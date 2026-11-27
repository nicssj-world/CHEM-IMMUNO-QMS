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
const dbName=`ci_unified_vendor_${process.pid}_${Math.floor(Math.random()*999999)}`;
const isolated=new URL(root);isolated.pathname='/'+dbName;
const ADMIN='11111111-1111-4111-8111-111111111111';
const CHE_ONLY='22222222-2222-4222-8222-222222222222';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function conn(connection=isolated.toString()){const c=new Client({connectionString:connection});await c.connect();return c;}
async function privileged<T>(work:(c:Client)=>Promise<T>){const c=await conn();try{return await work(c)}finally{await c.end();}}
async function asUser<T>(id:string,work:(c:Client)=>Promise<T>){const c=await conn();try{
 await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');
 await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[id]);
 const value=await work(c);await c.query('COMMIT');return value;
}catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}}
async function rpc<T>(id:string,name:string,values:unknown[],casts:string[]) {
 return asUser(id,async c=>{
  const params=values.map((_,i)=>`$${i+1}::${casts[i]}`).join(',');
  const r=await c.query<{result:T}>(`SELECT public.${name}(${params}) AS result`,values.map((v,i)=>casts[i]==='jsonb'?JSON.stringify(v):v));
  return r.rows[0].result;
 });
}
const assessment={delivery_discrepancy:false,correct_product:true,correct_quantity:true,packaging_ok:true,
 temperature_required:false,temperature_ok:null,shelf_life_ok:null,documentation_complete:true,has_complaint:false,
 reason_codes:[],other_reason_detail:null,notes:null};

test('unified vendor official report: RLS, double-counting, stale guard and immutable PDF evidence',{timeout:240000},async t=>{
 const admin=await conn(root.toString());try{await admin.query(`CREATE DATABASE ${dbName}`);}finally{await admin.end();}
 try{
  await privileged(async c=>{
   await c.query(await readFile('tests/db/bootstrap.sql','utf8'));
   const migrations=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
   for(const file of migrations)await c.query(await readFile(path.join('supabase/migrations',file),'utf8'));
   await c.query('INSERT INTO auth.users(id) VALUES ($1),($2)',[ADMIN,CHE_ONLY]);
   await c.query("INSERT INTO ci_user_profiles(user_id,ephis_id,display_name,active,position_title) VALUES ($1,'admin','Admin',true,'Supervisor'),($2,'staff','Staff',true,'Staff')",[ADMIN,CHE_ONLY]);
   await c.query("INSERT INTO ci_user_access(user_id,warehouse_id,role) VALUES ($1,1,'admin'),($1,2,'admin'),($2,1,'staff')",[ADMIN,CHE_ONLY]);
  });
  const vendor=await rpc<string>(ADMIN,'ci_create_vendor',[{vendorCode:'V-UNIFIED',name:'Vendor combined'}],['jsonb']);
  await t.test('single-scope staff cannot create a report or read its row',async()=>{
   await assert.rejects(rpc(CHE_ONLY,'ci_create_unified_vendor_report',[vendor,2570],['uuid','integer']),/CI_ACCESS_DENIED/);
  });
  const policy=await privileged(async c=>(await c.query<{id:string}>("SELECT id FROM ci_vendor_evaluation_policies WHERE version='VE-POLICY-V1'")).rows[0].id);
  await rpc(ADMIN,'ci_approve_vendor_evaluation_policy',[policy],['uuid']);
  const draft=await rpc<string>(ADMIN,'ci_create_unified_vendor_report',[vendor,2570],['uuid','integer']);
  const same=await rpc<string>(ADMIN,'ci_create_unified_vendor_report',[vendor,2570],['uuid','integer']);
  assert.equal(same,draft);
  const hidden=await asUser(CHE_ONLY,c=>c.query('SELECT id FROM ci_unified_vendor_reports WHERE id=$1',[draft]));
  assert.equal(hidden.rowCount,0);

  const che=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:1,product_type:'reagent',source_name:'Chem',current_ref:'REF-UNIFIED-CHE',manufacturer_barcode:'BC-UNIFIED-CHE'}],['jsonb']);
  const imm=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:2,product_type:'reagent',source_name:'Immuno',current_ref:'REF-UNIFIED-IMM',manufacturer_barcode:'BC-UNIFIED-IMM'}],['jsonb']);
  const loc=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'SHARED-01',name:'Reagent Shelf',location_type:'refrigerator'}],['jsonb']);
  const invoice=await rpc<string>(ADMIN,'ci_create_invoice',[{vendor_id:vendor,invoice_number:'COMBINED-001',invoice_date:'2026-10-09',lines:[{product_id:che,quantity:1},{product_id:imm,quantity:1}]}],['jsonb']);
  const lines=await privileged(async c=>(await c.query<{id:string;warehouse_id:number}>('SELECT id,warehouse_id FROM ci_invoice_lines WHERE invoice_id=$1 ORDER BY warehouse_id',[invoice])).rows);
  assert.equal(lines.length,2);
  for(const [i,line] of lines.entries()){
   await rpc(ADMIN,'ci_confirm_receipt_assessed',[invoice,[{invoice_line_id:line.id,quantity:1,lot_number:'LOT-'+i,expiry_date:'2027-05-01',location_id:loc}],'combined-'+i,assessment],['uuid','jsonb','text','jsonb']);
  }
  await t.test('one mixed invoice appears once in vendor evidence from two receipt ledgers',async()=>{
   const rows=await asUser(ADMIN,c=>c.query<{evidence_snapshot:{activity:{invoices:number;receipts:number};warehouse:{code:string}}}>('SELECT evidence_snapshot FROM ci_unified_vendor_reports WHERE id=$1',[draft]));
   assert.equal(rows.rows[0].evidence_snapshot.activity.invoices,0,'draft is frozen until explicit refresh');
   await assert.rejects(rpc(ADMIN,'ci_finalize_unified_vendor_report',[draft],['uuid']),/CI_ANNUAL_EVIDENCE_STALE/);
   await rpc(ADMIN,'ci_refresh_unified_vendor_report',[draft],['uuid']);
   const updated=await asUser(ADMIN,c=>c.query<{evidence_snapshot:{activity:{invoices:number;receipts:number};warehouse:{code:string}}}>('SELECT evidence_snapshot FROM ci_unified_vendor_reports WHERE id=$1',[draft]));
   assert.equal(updated.rows[0].evidence_snapshot.activity.invoices,1);
   assert.equal(updated.rows[0].evidence_snapshot.activity.receipts,2);
   assert.equal(updated.rows[0].evidence_snapshot.warehouse.code,'ALL');
  });
  await rpc(ADMIN,'ci_save_my_signature',[png],['text']);
  const draftInput={summary:'Verified',strengths:'Reliable',risksConcerns:'Monitored',recommendations:'Continue',evaluatorId:ADMIN,reviewerId:ADMIN,approverId:ADMIN};
  await rpc(ADMIN,'ci_save_unified_vendor_report',[draft,draftInput],['uuid','jsonb']);
  const number=await rpc<string>(ADMIN,'ci_finalize_unified_vendor_report',[draft],['uuid']);
  assert.match(number,/^VEC-2570-0001$/);
  await t.test('official report freezes score, signatures and policy; cannot be changed',async()=>{
   const row=await asUser(ADMIN,c=>c.query<{status:string;frozen_snapshot:{evidence:{activity:{invoices:number;receipts:number}};criteria:unknown[]};evaluator_signature:string}>('SELECT status,frozen_snapshot,evaluator_signature FROM ci_unified_vendor_reports WHERE id=$1',[draft]));
   assert.equal(row.rows[0].status,'final');
   assert.equal(row.rows[0].frozen_snapshot.evidence.activity.invoices,1);
   assert.equal(row.rows[0].frozen_snapshot.evidence.activity.receipts,2);
   assert.equal(row.rows[0].evaluator_signature,png);
   assert.equal(row.rows[0].frozen_snapshot.criteria.length,8);
   await assert.rejects(rpc(ADMIN,'ci_save_unified_vendor_report',[draft,draftInput],['uuid','jsonb']),/CI_ANNUAL_REVISION_IMMUTABLE/);
   await assert.rejects(privileged(c=>c.query("UPDATE ci_unified_vendor_reports SET judgment_summary='bad' WHERE id=$1",[draft])),/CI_ANNUAL_REVISION_IMMUTABLE/);
   const next=await rpc<string>(ADMIN,'ci_create_unified_vendor_report',[vendor,2570],['uuid','integer']);
   assert.notEqual(next,draft);
   const follow=await asUser(ADMIN,c=>c.query('SELECT revision_number,status FROM ci_unified_vendor_reports WHERE id=$1',[next]));
   assert.equal(follow.rows[0].revision_number,2);
   assert.equal(follow.rows[0].status,'draft');
  });
 } finally {
  const c=await conn(root.toString());
  try{await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);}finally{await c.end();}
 }
});
