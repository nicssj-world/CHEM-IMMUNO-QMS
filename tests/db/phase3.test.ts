import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const ADMIN='11111111-1111-4111-8111-111111111111';
const IMM='44444444-4444-4444-8444-444444444444';
const root=process.env.CI_TEST_DATABASE_URL;
if(!root)throw new Error('Set CI_TEST_DATABASE_URL via scripts/db/test.ps1');
const adminUrl=new URL(root);
if(!['127.0.0.1','localhost','::1'].includes(adminUrl.hostname)||adminUrl.pathname!=='/postgres')throw new Error('Disposable loopback PostgreSQL required');
const dbName=`ci_phase3_${process.pid}_${Math.floor(Math.random()*1000000)}`;
const testUrl=new URL(adminUrl);testUrl.pathname=`/${dbName}`;
async function connect(url=testUrl.toString()){const c=new Client({connectionString:url});await c.connect();return c;}
async function asUser<T>(id:string,fn:(c:Client)=>Promise<T>):Promise<T>{const c=await connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);const r=await fn(c);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{await c.end();}}
async function setup(){const owner=await connect(adminUrl.toString());try{await owner.query(`create database ${dbName}`);}finally{await owner.end();}const c=await connect();try{const migrations=(await readdir(path.join(process.cwd(),'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort();for(const file of ['tests/db/bootstrap.sql',...migrations.map(f=>`supabase/migrations/${f}`)])await c.query(await readFile(path.join(process.cwd(),file),'utf8'));await c.query('insert into auth.users(id) values ($1),($2)',[ADMIN,IMM]);await c.query("insert into public.ci_user_profiles(user_id,ephis_id,display_name) values ($1,'admin','Admin'),($2,'viewer','Viewer')",[ADMIN,IMM]);await c.query("insert into public.ci_user_access(user_id,warehouse_id,role) values ($1,1,'admin'),($1,2,'admin'),($2,2,'viewer')",[ADMIN,IMM]);}finally{await c.end();}}
async function cleanup(){const c=await connect(adminUrl.toString());try{await c.query(`drop database ${dbName} with (force)`);}finally{await c.end();}}

test('Phase 3 PostgreSQL: signed monthly report, date range, search and warehouse isolation',{timeout:120000},async t=>{
  await setup();try{
    const c=await connect();let product:string;let emptyProduct:string;let imm:string;let lot:string;let location:string;let platform:string;
    try{
      product=(await c.query<{id:string}>("insert into public.ci_products(warehouse_id,product_code,product_type,source_name,display_name) values(1,'CHE-0001','reagent','Synthetic reagent','Synthetic reagent') returning id")).rows[0].id;
      emptyProduct=(await c.query<{id:string}>("insert into public.ci_products(warehouse_id,product_code,product_type,source_name,display_name) values(1,'CHE-0002','control','Synthetic empty','Synthetic empty') returning id")).rows[0].id;
      imm=(await c.query<{id:string}>("insert into public.ci_products(warehouse_id,product_code,product_type,source_name,display_name) values(2,'IMM-0001','control','Synthetic control','Synthetic control') returning id")).rows[0].id;
      platform=(await c.query<{id:string}>("select id from public.ci_platforms where warehouse_id=1 and platform_key='c503'")).rows[0].id;
      await c.query('insert into public.ci_product_platforms(product_id,platform_id,warehouse_id) values($1,$2,1)',[product,platform]);
      await c.query("insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value) values($1,1,'REF_CURRENT','000123')",[product]);
      location=(await c.query<{id:string}>("insert into public.ci_locations(warehouse_id,code,name) values(1,'A','A') returning id")).rows[0].id;
      lot=(await c.query<{id:string}>("insert into public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date) values(1,$1,'L1','2028-01-01') returning id",[product])).rows[0].id;
      const parts:[string,string,number,string?][]=[['2026-08-31 16:59:59+00','receive',5],['2026-08-31 17:00:00+00','receive',4],['2026-09-05 01:00:00+00','issue',-2],['2026-09-06 01:00:00+00','adjustment',1],['2026-09-07 01:00:00+00','expired_disposal',-1],['2026-09-08 01:00:00+00','reversal',2]];
      let issueId='';
      for(let i=0;i<parts.length;i++){const [created,kind,delta]=parts[i];const tx=(await c.query<{id:string}>('insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,purpose,source_transaction_id,created_at) values(1,$1,$2,$3,$4,$5,$6,$7) returning id',[kind,`synthetic-${i}`,'test',ADMIN,kind==='issue'?'Routine':null,kind==='reversal'?issueId:null,created])).rows[0].id;if(kind==='issue')issueId=tx;await c.query('insert into public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) values($1,1,$2,$3,$4)',[tx,lot,location,delta]);}
    }finally{await c.end();}
    await t.test('Bangkok month boundary and signed reconciliation',async()=>{
      const september=await asUser(ADMIN,c=>c.query('select * from public.ci_monthly_inventory_report(1::smallint,$1::date) where product_id=$2',['2026-09-01',product]));
      const r=september.rows[0];assert.deepEqual(['opening','received','issued','adjustments','expired_disposal','reversals','closing'].map(k=>Number(r[k])),[5,4,2,1,1,2,9]);
      const august=await asUser(ADMIN,c=>c.query('select opening,received,closing from public.ci_monthly_inventory_report(1::smallint,$1::date) where product_id=$2',['2026-08-01',product]));
      assert.deepEqual([Number(august.rows[0].opening),Number(august.rows[0].received),Number(august.rows[0].closing)],[0,5,5]);
      await assert.rejects(asUser(ADMIN,c=>c.query('select * from public.ci_monthly_inventory_report(1::smallint,$1::date)',['2026-09-02'])),/CI_REPORT_MONTH_INVALID/);
    });
    await t.test('searches identifiers, filters stock, and pages within one warehouse',async()=>{
      const match=await asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'000123',null,null,'below',null,50,0)"));
      assert.equal(match.rows.length,0);
      const rows=await asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'000123',null,null,'stockout',null,50,0)"));
      assert.equal(rows.rows.length,0);
      const byIdentifier=await asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'000123',null,null,null,null,50,0)"));
      assert.equal(byIdentifier.rows[0].id,product);
      const stockout=await asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'CHE-0002',null,null,'stockout',null,50,0)"));
      assert.equal(stockout.rows[0].id,emptyProduct);
      const filtered=await asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'000123','reagent',$1::uuid,null,'>90',50,0)",[platform]));
      assert.equal(filtered.rows[0].id,product);
      const stock=await asUser(ADMIN,c=>c.query("select * from public.ci_search_stock(1::smallint,'000123',50,0)"));
      assert.equal(stock.rows.length,1);assert.equal(stock.rows[0].product_id,product);assert.equal(Number(stock.rows[0].balance),9);
      const noOther=await asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'IMM',null,null,null,null,50,0)"));
      assert.equal(noOther.rows.length,0);
      await assert.rejects(asUser(ADMIN,c=>c.query("select * from public.ci_search_inventory(1::smallint,'',null,null,null,null,101,0)")),/CI_SEARCH_PAGE_INVALID/);
    });
    await t.test('warehouse reader cannot request other warehouse report or search',async()=>{
      await assert.rejects(asUser(IMM,c=>c.query("select * from public.ci_monthly_inventory_report(1::smallint,'2026-09-01')")),/CI_ACCESS_DENIED/);
      await assert.rejects(asUser(IMM,c=>c.query("select * from public.ci_search_inventory(1::smallint,'',null,null,null,null,50,0)")),/CI_ACCESS_DENIED/);
      await assert.rejects(asUser(IMM,c=>c.query("select * from public.ci_search_stock(1::smallint,'',50,0)")),/CI_ACCESS_DENIED/);
      const own=await asUser(IMM,c=>c.query("select * from public.ci_search_inventory(2::smallint,'IMM',null,null,null,null,50,0)"));
      assert.equal(own.rows[0].id,imm);
    });
  }finally{await cleanup();}
});
