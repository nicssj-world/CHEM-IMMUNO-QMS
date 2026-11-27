import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const ADMIN='11111111-1111-4111-8111-111111111111';
const STAFF='22222222-2222-4222-8222-222222222222';
const SUPERVISOR='33333333-3333-4333-8333-333333333333';
const IMM_VIEWER='44444444-4444-4444-8444-444444444444';
const root=process.env.CI_TEST_DATABASE_URL;
if(!root)throw new Error('Set CI_TEST_DATABASE_URL via scripts/db/test.ps1');
const adminUrl=new URL(root);
if(!['127.0.0.1','localhost','::1'].includes(adminUrl.hostname)||adminUrl.pathname!=='/postgres')throw new Error('Disposable loopback PostgreSQL required');
const dbName=`ci_phase2_${process.pid}_${Math.floor(Math.random()*1000000)}`;
const testUrl=new URL(adminUrl);testUrl.pathname=`/${dbName}`;
async function connect(url=testUrl.toString()){const client=new Client({connectionString:url});await client.connect();return client;}
async function asUser<T>(id:string,fn:(c:Client)=>Promise<T>):Promise<T>{const c=await connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);const result=await fn(c);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}finally{await c.end();}}
async function rpc<T>(id:string,name:string,args:unknown[],casts:string[]):Promise<T>{return asUser(id,async c=>{const p=args.map((_,i)=>`$${i+1}::${casts[i]}`).join(',');const result=await c.query<{result:T}>(`select public.${name}(${p}) result`,args.map((arg,i)=>casts[i]==='jsonb'?JSON.stringify(arg):arg));return result.rows[0].result;});}
async function setup(){const owner=await connect(adminUrl.toString());try{await owner.query(`create database ${dbName}`);}finally{await owner.end();}const c=await connect();try{const migrations=(await readdir(path.join(process.cwd(),'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort();for(const file of ['tests/db/bootstrap.sql',...migrations.map(f=>`supabase/migrations/${f}`)])await c.query(await readFile(path.join(process.cwd(),file),'utf8'));await c.query('insert into auth.users(id) values ($1),($2),($3),($4)',[ADMIN,STAFF,SUPERVISOR,IMM_VIEWER]);await c.query("insert into public.ci_user_profiles(user_id,ephis_id,display_name) values ($1,'admin','Admin'),($2,'staff','Staff'),($3,'supervisor','Supervisor'),($4,'viewer','Viewer')",[ADMIN,STAFF,SUPERVISOR,IMM_VIEWER]);await c.query("insert into public.ci_user_access(user_id,warehouse_id,role) values ($1,1,'admin'),($1,2,'admin'),($2,1,'staff'),($3,1,'supervisor'),($4,2,'viewer')",[ADMIN,STAFF,SUPERVISOR,IMM_VIEWER]);}finally{await c.end();}}
async function cleanup(){const c=await connect(adminUrl.toString());try{await c.query(`drop database ${dbName} with (force)`);}finally{await c.end();}}

test('Phase 2 PostgreSQL: mapping, evidence, assessed receipts, reorder and RLS',{timeout:120000},async t=>{
  await setup();try{
    const product=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:1,product_type:'reagent',source_name:'A',current_ref:'0001',manufacturer_barcode:'A-1'}],['jsonb']);
    const product2=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:1,product_type:'reagent',source_name:'B',current_ref:'0002',manufacturer_barcode:'B-1'}],['jsonb']);
    const imm=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:2,product_type:'reagent',source_name:'IMM',current_ref:'0003',manufacturer_barcode:'I-1'}],['jsonb']);
    const location=await rpc<string>(ADMIN,'ci_create_location',[1,'A','A'],['smallint','text','text']);
    const immLocation=await rpc<string>(ADMIN,'ci_create_location',[2,'B','B'],['smallint','text','text']);
    const vendor=await rpc<string>(ADMIN,'ci_create_vendor',[{vendorCode:'V-SYN',name:'Synthetic vendor'}],['jsonb']);
    await t.test('proposed identifier does not resolve; approval is role-bound and conflict-safe',async()=>{
      const id=await rpc<string>(STAFF,'ci_propose_identifier_mapping',[product,'GTIN','00012345678905',']C10100012345678905'],['uuid','text','text','text']);
      const before=await asUser(STAFF,c=>c.query("select count(*)::int n from public.ci_product_identifiers where kind='GTIN'"));
      assert.equal(before.rows[0].n,0);
      await assert.rejects(rpc(IMM_VIEWER,'ci_decide_identifier_mapping',[id,true,'Verified label'],['uuid','boolean','text']),/CI_ACCESS_DENIED/);
      await rpc(SUPERVISOR,'ci_decide_identifier_mapping',[id,true,'Verified manufacturer label'],['uuid','boolean','text']);
      const after=await asUser(STAFF,c=>c.query("select product_id from public.ci_product_identifiers where kind='GTIN' and value='00012345678905'"));
      assert.equal(after.rows[0].product_id,product);
      const conflict=await rpc<string>(STAFF,'ci_propose_identifier_mapping',[product2,'GS1_AI240','00012345678905','raw'],['uuid','text','text','text']);
      await assert.rejects(rpc(SUPERVISOR,'ci_decide_identifier_mapping',[conflict,true,'Would conflict'],['uuid','boolean','text']),/CI_IDENTIFIER_AMBIGUOUS/);
      await rpc(SUPERVISOR,'ci_decide_identifier_mapping',[conflict,false,'Conflicts with approved GTIN'],['uuid','boolean','text']);
    });
    const invoice=await rpc<string>(ADMIN,'ci_create_invoice',[{vendor_id:vendor,invoice_number:'SYN-001',invoice_date:'2026-09-24',lines:[{product_id:product,quantity:10},{product_id:imm,quantity:4}]}],['jsonb']);
    const lineRows=await asUser(ADMIN,c=>c.query<{id:string;product_id:string}>("select id,product_id from public.ci_invoice_lines where invoice_id=$1",[invoice]));
    const cheLine=lineRows.rows.find(l=>l.product_id===product)!.id;
    const immLine=lineRows.rows.find(l=>l.product_id===imm)!.id;
    await t.test('raw scan evidence and attachment registration enforce warehouse access',async()=>{
      const scan=await rpc<string>(STAFF,'ci_record_scan',[{warehouse_id:1,invoice_id:invoice,invoice_line_id:cheLine,raw_payload:']C10100012345678905',symbology:'CODE_128',parsed_fields:{gtin:'00012345678905'},parse_warnings:[]}],['jsonb']);
      const row=await asUser(STAFF,c=>c.query('select raw_payload,actor_id from public.ci_scan_events where id=$1',[scan]));
      assert.equal(row.rows[0].raw_payload,']C10100012345678905');assert.equal(row.rows[0].actor_id,STAFF);
      const denied=await asUser(IMM_VIEWER,c=>c.query('select count(*)::int n from public.ci_scan_events where id=$1',[scan]));
      assert.equal(denied.rows[0].n,0);
      await assert.rejects(rpc(IMM_VIEWER,'ci_register_invoice_attachment',[invoice,1,'invoice_photo','image/jpeg',100],['uuid','smallint','text','text','bigint']),/CI_ACCESS_DENIED/);
      const attachment=(await asUser(STAFF,c=>c.query<{attachment_id:string;object_key:string}>('select * from public.ci_register_invoice_attachment($1::uuid,$2::smallint,$3::text,$4::text,$5::bigint)',[invoice,1,'invoice_photo','image/jpeg',100]))).rows;
      assert.equal(attachment.length,1);assert.ok(attachment[0].object_key.startsWith(`${invoice}/`));
      const hidden=await asUser(IMM_VIEWER,c=>c.query('select count(*)::int n from public.ci_attachments'));
      assert.equal(hidden.rows[0].n,0);
    });
    await t.test('mixed-warehouse assessed receipt is atomic and idempotent',async()=>{
      const lines=[{invoice_line_id:cheLine,quantity:5,lot_number:'LOT-A',expiry_date:'2027-01-01',location_id:location},{invoice_line_id:immLine,quantity:4,lot_number:'LOT-I',expiry_date:'2027-01-01',location_id:immLocation}];
      const assessment={correct_product:true,correct_quantity:true,packaging_ok:true,temperature_required:false,shelf_life_ok:true,documentation_complete:true,delivery_discrepancy:false};
      const result=await rpc<{warehouse_id:number;transaction_id:string}[]>(ADMIN,'ci_confirm_receipt_assessed',[invoice,lines,'receipt-1',assessment],['uuid','jsonb','text','jsonb']);
      assert.equal(result.length,2);
      const retry=await rpc<{warehouse_id:number;transaction_id:string}[]>(ADMIN,'ci_confirm_receipt_assessed',[invoice,lines,'receipt-1',assessment],['uuid','jsonb','text','jsonb']);
      assert.deepEqual(retry,result);
      const counts=await asUser(ADMIN,c=>c.query('select count(*)::int n from public.ci_receipt_assessments'));
      assert.equal(counts.rows[0].n,2);
      const balance=await asUser(ADMIN,c=>c.query('select warehouse_id,sum(balance)::numeric n from public.ci_stock_balances group by warehouse_id order by warehouse_id'));
      assert.deepEqual(balance.rows.map(r=>[r.warehouse_id,Number(r.n)]),[[1,5],[2,4]]);
    });
    await t.test('manual ROP, missing automatic history and usable stock exclude expiry',async()=>{
      await rpc(ADMIN,'ci_save_reorder_settings',[product,{mode:'manual',manual_rop_packs:3,order_pack_quantity:2,target_coverage_days:30}],['uuid','jsonb']);
      const manual=await asUser(ADMIN,c=>c.query('select usable_stock,rop from public.ci_reorder_status where product_id=$1',[product]));
      assert.equal(Number(manual.rows[0].usable_stock),5);assert.equal(Number(manual.rows[0].rop),6);
      await rpc(ADMIN,'ci_save_reorder_settings',[product,{mode:'automatic',lead_time_days:7,safety_stock:2,target_coverage_days:30,order_pack_quantity:2}],['uuid','jsonb']);
      const automatic=await asUser(ADMIN,c=>c.query('select rop,missing_reason from public.ci_reorder_status where product_id=$1',[product]));
      assert.equal(automatic.rows[0].rop,null);assert.match(automatic.rows[0].missing_reason,/90/);
    });
    await t.test('90-day net issue counts consumption purposes and nets reversals, excluding Waste',async()=>{
      const owner=await connect();
      try{
        const lot=(await owner.query<{id:string}>('select id from public.ci_stock_lots where product_id=$1',[product])).rows[0].id;
        const old=(await owner.query<{id:string}>("insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,purpose,created_at) values(1,'issue','synthetic-old-history','history',$1,'Routine',now()-interval '91 days') returning id",[ADMIN])).rows[0].id;
        await owner.query('insert into public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) values($1,1,$2,$3,-1)',[old,lot,location]);
        const routine=await rpc<string>(ADMIN,'ci_issue_stock',[{product_id:product,lot_id:lot,location_id:location,quantity:2,purpose:'Routine',idempotency_key:'routine-1'}],['jsonb']);
        await rpc(ADMIN,'ci_reverse_transaction',[routine,'Test reversal','reverse-1'],['uuid','text','text']);
        await rpc(ADMIN,'ci_issue_stock',[{product_id:product,lot_id:lot,location_id:location,quantity:1,purpose:'Waste',idempotency_key:'waste-1'}],['jsonb']);
        await rpc(ADMIN,'ci_issue_stock',[{product_id:product,lot_id:lot,location_id:location,quantity:1,purpose:'QC',idempotency_key:'qc-1'}],['jsonb']);
        const row=await asUser(ADMIN,c=>c.query('select average_daily_issue,rop,usable_stock,suggested_order from public.ci_reorder_status where product_id=$1',[product]));
        assert.ok(Math.abs(Number(row.rows[0].average_daily_issue)-1/90)<0.00001);
        assert.ok(Math.abs(Number(row.rows[0].rop)-(2+7/90))<0.00001);
        assert.equal(Number(row.rows[0].usable_stock),2);
        assert.equal(Number(row.rows[0].suggested_order),0);
      }finally{await owner.end();}
    });
    await t.test('vendor metrics stay objective and count the receipt',async()=>{
      const row=await asUser(SUPERVISOR,c=>c.query('select receipt_count from public.ci_vendor_metrics where vendor_id=$1 and warehouse_id=1',[vendor]));
      assert.equal(Number(row.rows[0].receipt_count),1);
    });
  }finally{await cleanup();}
});
