import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// Run only against an isolated disposable loopback PostgreSQL instance.
const raw=process.env.CI_TEST_DATABASE_URL;
if(!raw)throw new Error('Set CI_TEST_DATABASE_URL to disposable localhost /postgres');
const root=new URL(raw);
if(!['localhost','127.0.0.1','::1'].includes(root.hostname)||root.pathname!=='/postgres')
 throw new Error('Refusing non-disposable database');
const dbName='ci_issue_group_'+process.pid+'_'+Math.floor(Math.random()*1000000);
const dbUrl=new URL(root);dbUrl.pathname='/'+dbName;
const OWNER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
async function connect(url=dbUrl.toString()) {
 const c=new Client({connectionString:url});await c.connect();return c;
}
async function asUser<T>(id:string,fn:(c:Client)=>Promise<T>){
 const c=await connect();
 try{
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[id]);
  const result=await fn(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
}
async function rpc<T>(user:string,name:string,args:unknown[],casts:string[]):Promise<T>{
 return asUser(user,async c=>{
  const placeholders=args.map((_,i)=>'$'+(i+1)+'::'+casts[i]).join(',');
  const result=await c.query<{result:T}>('select public.'+name+'('+placeholders+') result',
   args.map((a,i)=>casts[i]==='jsonb'?JSON.stringify(a):a));
  return result.rows[0].result;
 });
}
test('issue group: owner-only deletion, checklist progress, atomic post and immutable posted ledger',{timeout:180000},async()=>{
 const admin=await connect(root.toString());
 try{await admin.query('CREATE DATABASE '+dbName);}finally{await admin.end();}
 try{
  const c=await connect();
  let product:string,location:string,lot:string;
  try{
   await c.query(await readFile('tests/db/bootstrap.sql','utf8'));
   for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())
    await c.query(await readFile(path.join('supabase/migrations',file),'utf8'));
   await c.query('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);
   await c.query("insert into ci_user_profiles(user_id,ephis_id,display_name,active) values($1,'owner','Owner',true),($2,'other','Other',true)",[OWNER,OTHER]);
   await c.query("insert into ci_user_access(user_id,warehouse_id,role) values($1,1,'admin'),($2,1,'staff')",[OWNER,OTHER]);
   product=(await c.query<{id:string}>("insert into ci_products(warehouse_id,product_code,product_type,source_name,display_name) values(1,'CHE-TEST','reagent','Test','Test') returning id")).rows[0].id;
   location=(await c.query<{id:string}>("insert into ci_locations(warehouse_id,code,name) values(1,'STORE','Store') returning id")).rows[0].id;
   lot=(await c.query<{id:string}>("insert into ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date) values(1,$1,'LOT-1','2028-01-01') returning id",[product])).rows[0].id;
   const tx=(await c.query<{id:string}>("insert into ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id) values(1,'adjustment','seed-issue-test','seed',$1) returning id",[OWNER])).rows[0].id;
   await c.query('insert into ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) values($1,1,$2,$3,10)',[tx,lot,location]);
  }finally{await c.end();}
  const data=(client_key:string,amount=2)=>({client_key,purpose:'Routine',lines:[{product_id:product,lot_id:lot,location_id:location,quantity:amount}]});
  const draft=await rpc<string>(OWNER,'ci_create_issue_group',[data('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],['jsonb']);
  assert.equal(await rpc<string>(OWNER,'ci_create_issue_group',[data('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],['jsonb']),draft,'idempotency');
  const c1=await connect();
  let line:string;
  try{line=(await c1.query<{id:string}>('select id from ci_issue_group_lines where group_id=$1',[draft])).rows[0].id;}finally{await c1.end();}
  await assert.rejects(rpc(OTHER,'ci_delete_issue_group',[draft],['uuid']),/CI_ISSUE_GROUP_NOT_FOUND/);
  await rpc(OWNER,'ci_set_issue_group_picked',[draft,line,true],['uuid','uuid','boolean']);
  const detail=await asUser(OWNER,c=>c.query('select status from ci_issue_groups where id=$1',[draft]));
  assert.equal(detail.rows[0].status,'picking');
  await rpc(OWNER,'ci_delete_issue_group',[draft],['uuid']);
  const afterDelete=await connect();
  try{
   assert.equal((await afterDelete.query('select count(*)::int n from ci_issue_groups where id=$1',[draft])).rows[0].n,0);
   assert.equal((await afterDelete.query('select count(*)::int n from ci_issue_group_lines where group_id=$1',[draft])).rows[0].n,0);
   assert.equal((await afterDelete.query("select sum(quantity_delta)::int n from ci_stock_movement_lines where lot_id=$1",[lot])).rows[0].n,10);
  }finally{await afterDelete.end();}
  const posted=await rpc<string>(OWNER,'ci_create_issue_group',[data('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',3)],['jsonb']);
  await assert.rejects(rpc(OWNER,'ci_complete_issue_group',[posted],['uuid']),/CI_ISSUE_PICKING_INCOMPLETE/);
  const c2=await connect();
  let line2:string;
  try{line2=(await c2.query<{id:string}>('select id from ci_issue_group_lines where group_id=$1',[posted])).rows[0].id;}finally{await c2.end();}
  await rpc(OWNER,'ci_set_issue_group_picked',[posted,line2,true],['uuid','uuid','boolean']);
  assert.equal(await rpc<string>(OWNER,'ci_complete_issue_group',[posted],['uuid']),posted);
  assert.equal(await rpc<string>(OWNER,'ci_complete_issue_group',[posted],['uuid']),posted,'close idempotent');
  await assert.rejects(rpc(OWNER,'ci_delete_issue_group',[posted],['uuid']),/CI_ISSUE_GROUP_ALREADY_POSTED/);
  const done=await connect();
  try{
   assert.equal((await done.query("select sum(quantity_delta)::int n from ci_stock_movement_lines where lot_id=$1",[lot])).rows[0].n,7);
   assert.equal((await done.query('select status from ci_issue_groups where id=$1',[posted])).rows[0].status,'closed');
  }finally{await done.end();}
 }finally{
  const admin=await connect(root.toString());
  try{await admin.query('DROP DATABASE IF EXISTS '+dbName+' WITH (FORCE)');}finally{await admin.end();}
 }
});
