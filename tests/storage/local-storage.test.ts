import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const service=process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl=process.env.CI_LOCAL_DATABASE_URL;
const host=url?new URL(url).hostname:'';
const dbHost=dbUrl?new URL(dbUrl).hostname:'';
const local=Boolean(url&&publishable&&service&&dbUrl&&['localhost','127.0.0.1','::1'].includes(host)&&['localhost','127.0.0.1','::1'].includes(dbHost));

test('private invoice evidence: signed upload/read, warehouse denial and public denial',{skip:!local,timeout:120000},async()=>{
  const serviceClient=createClient(url!,service!,{auth:{autoRefreshToken:false,persistSession:false}});
  const userClient=createClient(url!,publishable!,{auth:{autoRefreshToken:false,persistSession:false}});
  const outsider=createClient(url!,publishable!,{auth:{autoRefreshToken:false,persistSession:false}});
  const anon=createClient(url!,publishable!,{auth:{autoRefreshToken:false,persistSession:false}});
  const password=`Local-${crypto.randomUUID()}-A9!`;
  const adminEmail=`ephis.local${crypto.randomUUID().slice(0,8)}@chem-immuno.internal`;
  const outsideEmail=`ephis.local${crypto.randomUUID().slice(0,8)}@chem-immuno.internal`;
  const ephis=adminEmail.split('@')[0].slice(6);
  const outsideEphis=outsideEmail.split('@')[0].slice(6);
  const db=new Client({connectionString:dbUrl!});await db.connect();
  let adminId:string|undefined;let outsiderId:string|undefined;let productId:string|undefined;let invoiceId:string|undefined;let key:string|undefined;
  try{
    const created=await serviceClient.auth.admin.createUser({email:adminEmail,password,email_confirm:true});
    assert.equal(created.error,null);adminId=created.data.user!.id;
    assert.equal((await serviceClient.rpc('ci_bootstrap_first_admin',{p_ephis_id:ephis,p_display_name:'Storage test admin'})).error,null);
    assert.equal((await userClient.auth.signInWithPassword({email:adminEmail,password})).error,null);
    const outsideUser=await serviceClient.auth.admin.createUser({email:outsideEmail,password,email_confirm:true});
    assert.equal(outsideUser.error,null);outsiderId=outsideUser.data.user!.id;
    assert.equal((await userClient.rpc('ci_provision_user',{p_ephis_id:outsideEphis,p_display_name:'IMM viewer',p_role:'viewer',p_warehouse_ids:[2],p_active:true})).error,null);
    assert.equal((await outsider.auth.signInWithPassword({email:outsideEmail,password})).error,null);
    const product=await userClient.rpc('ci_create_product',{p_data:{warehouse_id:1,product_type:'reagent',source_name:'Synthetic storage test',current_ref:`ST-${crypto.randomUUID()}`,manufacturer_barcode:`BC-${crypto.randomUUID()}`}});
    assert.equal(product.error,null);productId=product.data;
    const vendor=await userClient.rpc('ci_create_vendor',{p_name:`Synthetic ${crypto.randomUUID()}`});
    assert.equal(vendor.error,null);
    const invoice=await userClient.rpc('ci_create_invoice',{p_data:{vendor_id:vendor.data,invoice_number:`ST-${crypto.randomUUID()}`,invoice_date:'2026-09-24',lines:[{product_id:productId,quantity:1}]}});
    assert.equal(invoice.error,null);invoiceId=invoice.data;
    let bucketError:Error|null=null;
    for(let attempt=0;attempt<20;attempt++){
      const bucket=await serviceClient.storage.createBucket('ci-invoice-evidence',{public:false,fileSizeLimit:10485760,allowedMimeTypes:['image/jpeg','image/png','image/heic','application/pdf']});
      bucketError=bucket.error;
      if(!bucketError)break;
      const existing=await serviceClient.storage.getBucket('ci-invoice-evidence');
      if(existing.data){bucketError=null;break;}
      if(!('status' in bucketError)||bucketError.status!==502)break;
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    assert.equal(bucketError,null);
    const details=await serviceClient.storage.getBucket('ci-invoice-evidence');
    assert.equal(details.data?.public,false);
    const registered=await userClient.rpc('ci_register_invoice_attachment',{p_invoice_id:invoiceId,p_warehouse_id:1,p_type:'invoice_photo',p_mime:'image/png',p_size:8});
    assert.equal(registered.error,null);key=registered.data[0].object_key;
    const deniedSign=await outsider.storage.from('ci-invoice-evidence').createSignedUploadUrl(key!);
    assert.ok(deniedSign.error);
    const deniedRead=await outsider.storage.from('ci-invoice-evidence').createSignedUrl(key!,60);
    assert.ok(deniedRead.error);
    const uploadAuthorization=await userClient.storage.from('ci-invoice-evidence').createSignedUploadUrl(key!);
    assert.equal(uploadAuthorization.error,null);
    const file=new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'});
    const direct=await anon.storage.from('ci-invoice-evidence').upload(`${invoiceId}/unregistered`,file,{contentType:'image/png'});
    assert.ok(direct.error);
    const uploaded=await anon.storage.from('ci-invoice-evidence').uploadToSignedUrl(key!,uploadAuthorization.data!.token,file,{contentType:'image/png'});
    assert.equal(uploaded.error,null);
    const signed=await userClient.storage.from('ci-invoice-evidence').createSignedUrl(key!,60);
    assert.equal(signed.error,null);
    assert.equal((await fetch(signed.data!.signedUrl)).status,200);
    const publicUrl=serviceClient.storage.from('ci-invoice-evidence').getPublicUrl(key!).data.publicUrl;
    assert.notEqual((await fetch(publicUrl)).status,200);
    await outsider.storage.from('ci-invoice-evidence').remove([key!]);
    assert.equal((await serviceClient.storage.from('ci-invoice-evidence').download(key!)).error,null,'other warehouse must not delete the object');
    assert.equal((await userClient.storage.from('ci-invoice-evidence').remove([key!])).error,null);
    assert.ok((await serviceClient.storage.from('ci-invoice-evidence').download(key!)).error,'uploader can remove the object before confirmation');
    assert.equal((await userClient.rpc('ci_delete_invoice_attachment',{p_id:registered.data[0].attachment_id})).error,null);
    key=undefined;
  }finally{
    if(key) await serviceClient.storage.from('ci-invoice-evidence').remove([key]);
    await serviceClient.storage.deleteBucket('ci-invoice-evidence');
    if(invoiceId){await db.query('delete from public.ci_attachments where invoice_id=$1',[invoiceId]);await db.query('delete from public.ci_invoice_lines where invoice_id=$1',[invoiceId]);await db.query('delete from public.ci_invoices where id=$1',[invoiceId]);}
    if(productId)await userClient.rpc('ci_delete_product',{p_id:productId});
    await userClient.auth.signOut({scope:'local'});await outsider.auth.signOut({scope:'local'});
    if(outsiderId)await serviceClient.auth.admin.deleteUser(outsiderId);
    if(adminId)await serviceClient.auth.admin.deleteUser(adminId);
    await db.end();
  }
});
