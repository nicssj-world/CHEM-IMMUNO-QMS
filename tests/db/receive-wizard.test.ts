import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {Client} from 'pg';

const url=process.env.CI_TEST_DATABASE_URL;
if(!url)throw new Error('Use CI_TEST_DATABASE_URL for a disposable loopback PostgreSQL /postgres');
const root=new URL(url);
if(!['127.0.0.1','localhost','::1'].includes(root.hostname)||root.pathname!=='/postgres')
 throw new Error('Refusing to run outside disposable loopback PostgreSQL /postgres');
const dbName=`ci_receive_wizard_${process.pid}_${Math.floor(Math.random()*999999)}`;
const isolated=new URL(root);isolated.pathname='/'+dbName;
const ADMIN='11111111-1111-4111-8111-111111111111';
const CHE_ONLY='22222222-2222-4222-8222-222222222222';
async function conn(connection=isolated.toString()){const c=new Client({connectionString:connection});await c.connect();return c;}
async function privileged<T>(work:(c:Client)=>Promise<T>){const c=await conn();try{return await work(c)}finally{await c.end();}}
async function asUser<T>(id:string,work:(c:Client)=>Promise<T>){const c=await conn();try{
 await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');
 await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[id]);
 const value=await work(c);await c.query('COMMIT');return value;
}catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}}
async function rpc<T>(actor:string,name:string,args:unknown[],casts:string[]):Promise<T> {
 return asUser(actor,async c=>{
  const params=args.map((_,i)=>`$${i+1}::${casts[i]}`).join(',');
  const {rows}=await c.query<{result:T}>(`SELECT public.${name}(${params}) AS result`,
    args.map((v,i)=>casts[i]==='jsonb'?JSON.stringify(v):v));
  return rows[0].result;
 });
}
const assessment={correct_product:true,correct_quantity:true,packaging_ok:true,
 temperature_required:false,temperature_ok:null,shelf_life_ok:null,documentation_complete:true,
 delivery_discrepancy:false,has_complaint:false,reason_codes:[],other_reason_detail:null,notes:null};
const header=(vendorId:string,number:string)=>({vendorId,invoiceNumber:number,invoiceDate:'2026-10-09',poNumber:''});
const lot=(quantity:string,lotName:string,locationId:string)=>({
 id:lotName,quantity,lot:lotName,expiry:'2027-12-31',locationId
});

test('four-step receiving: cross-device draft, atomic mixed-ledger final and idempotency',{timeout:240000},async t=>{
 const admin=await conn(root.toString());try{await admin.query(`CREATE DATABASE ${dbName}`)}finally{await admin.end();}
 try{
  await privileged(async c=>{
   await c.query(await readFile('tests/db/bootstrap.sql','utf8'));
   const migrations=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
   for(const file of migrations)await c.query(await readFile(path.join('supabase/migrations',file),'utf8'));
   await c.query('INSERT INTO auth.users(id) VALUES ($1),($2)',[ADMIN,CHE_ONLY]);
   await c.query("INSERT INTO ci_user_profiles(user_id,ephis_id,display_name,active) VALUES ($1,'admin','Admin',true),($2,'staff','Staff',true)",[ADMIN,CHE_ONLY]);
   await c.query("INSERT INTO ci_user_access(user_id,warehouse_id,role) VALUES ($1,1,'admin'),($1,2,'admin'),($2,1,'staff')",[ADMIN,CHE_ONLY]);
  });
  const vendor=await rpc<string>(ADMIN,'ci_create_vendor',[{vendorCode:'V-WIZARD',name:'Wizard Vendor'}],['jsonb']);
  const che=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:1,product_type:'reagent',source_name:'Chem',current_ref:'REF-WIZ-CHE',manufacturer_barcode:'BC-WIZ-CHE'}],['jsonb']);
  const imm=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:2,product_type:'reagent',source_name:'Imm',current_ref:'REF-WIZ-IMM',manufacturer_barcode:'BC-WIZ-IMM'}],['jsonb']);
  const loc=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'SHARED-WIZ',name:'Shared shelf',location_type:'refrigerator'}],['jsonb']);
  const draft=await rpc<string>(ADMIN,'ci_create_receive_draft',[vendor,'WIZ-001','2026-10-09',null],['uuid','text','date','text']);
  assert.equal(await rpc<string>(ADMIN,'ci_create_receive_draft',[vendor,'WIZ-001','2026-10-09',null],['uuid','text','date','text']),draft);
  await t.test('Step1 is only a persisted draft; no empty invoice, stock or receipt',async()=>{
   const stats=await privileged(c=>c.query<{invoices:string;receipts:string;lots:string}>(`select
    (select count(*) from ci_invoices) invoices,(select count(*) from ci_receipts) receipts,
    (select count(*) from ci_stock_lots) lots`));
   assert.deepEqual(stats.rows[0],{invoices:'0',receipts:'0',lots:'0'});
   const saved=await asUser(ADMIN,c=>c.query('select invoice_number,step from ci_receive_wizard_drafts where id=$1',[draft]));
   assert.equal(saved.rows[0].invoice_number,'WIZ-001');
   assert.equal(saved.rows[0].step,2);
  });
  const lines=[
   {id:'row1',productId:che,orderedQuantity:'5',packages:[lot('2','CHE-LOT',loc)]},
   {id:'row2',productId:imm,orderedQuantity:'2',packages:[lot('1','IMM-LOT1',loc),lot('1','IMM-LOT2',loc)]},
  ];
  await rpc(ADMIN,'ci_save_receive_draft',[draft,header(vendor,'WIZ-001'),lines,null,3],['uuid','jsonb','jsonb','jsonb','smallint']);
  await t.test('draft remains cross-device readable only to creator',async()=>{
   const a=await asUser(ADMIN,c=>c.query('select id,lines,step from ci_receive_wizard_drafts where id=$1',[draft]));
   assert.equal(a.rows[0].lines.length,2);assert.equal(a.rows[0].step,3);
   const other=await asUser(CHE_ONLY,c=>c.query('select id from ci_receive_wizard_drafts where id=$1',[draft]));
   assert.equal(other.rowCount,0);
   await assert.rejects(rpc(CHE_ONLY,'ci_finalize_receive_draft',[draft],['uuid']),/CI_RECEIVE_DRAFT_NOT_FOUND/);
  });
  await t.test('invalid location fails atomically with no orphan Invoice',async()=>{
   const bad=lines.map(x=>({...x,packages:x.packages.map(p=>({...p,locationId:'00000000-0000-4000-8000-000000000099'}))}));
   await rpc(ADMIN,'ci_save_receive_draft',[draft,header(vendor,'WIZ-001'),bad,assessment,4],['uuid','jsonb','jsonb','jsonb','smallint']);
   await assert.rejects(rpc(ADMIN,'ci_finalize_receive_draft',[draft],['uuid']),/CI_LOCATION_INVALID/);
   const n=await privileged(c=>c.query('select count(*)::int as n from ci_invoices'));
   assert.equal(n.rows[0].n,0);
  });
  await rpc(ADMIN,'ci_save_receive_draft',[draft,header(vendor,'WIZ-001'),lines,assessment,4],['uuid','jsonb','jsonb','jsonb','smallint']);
  const invoice=await rpc<string>(ADMIN,'ci_finalize_receive_draft',[draft],['uuid']);
  await t.test('final creates one Invoice, two signed receipts, three LOT lines and correct pending amount',async()=>{
   const invoiceAgain=await rpc<string>(ADMIN,'ci_finalize_receive_draft',[draft],['uuid']);
   assert.equal(invoiceAgain,invoice,'same confirmed draft cannot create duplicate movements');
   const state=await privileged(c=>c.query<{invoices:number;receipts:number;lotLines:number;movementQty:string;status:string;draftStatus:string}>(`select
    (select count(*)::int from ci_invoices) invoices,
    (select count(*)::int from ci_receipts) receipts,
    (select count(*)::int from ci_receipt_lines) "lotLines",
    (select coalesce(sum(quantity_delta),0) from ci_stock_movement_lines) "movementQty",
    (select status from ci_invoices where id=$1) status,
    (select status from ci_receive_wizard_drafts where id=$2) "draftStatus"`,[invoice,draft]));
   assert.deepEqual(state.rows[0],{invoices:1,receipts:2,lotLines:3,movementQty:'4.000',status:'open',draftStatus:'submitted'});
   const progress=await privileged(c=>c.query<{ordered_quantity:string;remaining_quantity:string}>(`select ordered_quantity,remaining_quantity from ci_invoice_line_progress where invoice_id=$1 and product_id=$2`,[invoice,che]));
   assert.equal(progress.rows[0].ordered_quantity,'5.000');
   assert.equal(progress.rows[0].remaining_quantity,'3.000');
   const reused=await privileged(c=>c.query('select count(distinct idempotency_key)::int as keys from ci_stock_transactions where kind=\'receive\''));
   assert.equal(reused.rows[0].keys,1);
  });
  await t.test('cannot create new draft for an already active Invoice',async()=>{
   await assert.rejects(rpc(ADMIN,'ci_create_receive_draft',[vendor,'WIZ-001','2026-10-09',null],['uuid','text','date','text']),/CI_INVOICE_EXISTS/);
  });
 } finally {
  const c=await conn(root.toString());
  try{await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)}finally{await c.end();}
 }
});
