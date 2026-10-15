import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// DATABASE ISOLATION: PostgreSQL is loopback-only, disposable and never Production.
const root=process.env.CI_TEST_DATABASE_URL;
if(!root) throw new Error('Set CI_TEST_DATABASE_URL to a disposable loopback PostgreSQL /postgres');
const rootUrl=new URL(root);
if(!['localhost','127.0.0.1','::1'].includes(rootUrl.hostname) || rootUrl.pathname!=='/postgres')
  throw new Error('Only disposable loopback PostgreSQL /postgres is allowed');
const databaseName=`ci_unified_count_${process.pid}_${Math.floor(Math.random()*100000)}`;
const databaseUrl=new URL(rootUrl); databaseUrl.pathname=`/${databaseName}`;
const ADMIN='11111111-1111-4111-8111-111111111111';
const CHE_ONLY='22222222-2222-4222-8222-222222222222';

async function owner<T>(fn:(client:Client)=>Promise<T>) {
  const client=new Client({connectionString:databaseUrl.toString()}); await client.connect();
  try{return await fn(client);}finally{await client.end();}
}
async function actor<T>(user:string,fn:(client:Client)=>Promise<T>) {
  return owner(async client=>{
    await client.query('BEGIN');
    try{
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);
      const value=await fn(client);
      await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK');throw error;}
  });
}
async function rpc<T>(user:string,name:string,values:unknown[],casts:string[]) {
  return actor(user,async client=>{
    const args=values.map((_,i)=>`$${i+1}::${casts[i]}`).join(',');
    const result=await client.query<{result:T}>(`SELECT public.${name}(${args}) result`,values.map((v,i)=>casts[i]==='jsonb'?JSON.stringify(v):v));
    return result.rows[0].result;
  });
}

test('unified stock count: atomic snapshots, unchanged ledger and all-or-nothing approval',{timeout:240000},async t=>{
  const admin=new Client({connectionString:rootUrl.toString()});await admin.connect();
  try{await admin.query(`CREATE DATABASE ${databaseName}`);}finally{await admin.end();}
  try{
    await owner(async client=>{
      await client.query(await readFile('tests/db/bootstrap.sql','utf8'));
      const filenames=(await readdir('supabase/migrations')).filter(file=>file.endsWith('.sql')).sort();
      for(const filename of filenames) await client.query(await readFile(path.join('supabase/migrations',filename),'utf8'));
      await client.query('INSERT INTO auth.users(id) VALUES ($1),($2)',[ADMIN,CHE_ONLY]);
      await client.query("INSERT INTO ci_user_profiles(user_id,ephis_id,display_name,active) VALUES ($1,'admin1','Admin',true),($2,'staff1','Staff',true)",[ADMIN,CHE_ONLY]);
      await client.query("INSERT INTO ci_user_access(user_id,warehouse_id,role) VALUES ($1,1,'admin'),($1,2,'admin'),($2,1,'staff')",[ADMIN,CHE_ONLY]);
    });

    const location=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'COLD-01',name:'Shared refrigerator',location_type:'refrigerator'}],['jsonb']);
    const che=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:1,product_type:'reagent',source_name:'CHE Reagent',current_ref:'REF-UC-CHE',manufacturer_barcode:'BC-UC-CHE'}],['jsonb']);
    const imm=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:2,product_type:'reagent',source_name:'IMM Reagent',current_ref:'REF-UC-IMM',manufacturer_barcode:'BC-UC-IMM'}],['jsonb']);
    const ids=await owner(async client=>{
      const lotResult=await client.query<{id:string;warehouse_id:number}>(`
        INSERT INTO ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date)
        VALUES (1,$1,'CHE-TEST','2028-12-31'),(2,$2,'IMM-TEST','2028-12-31')
        RETURNING id,warehouse_id`,[che,imm]);
      const cheLot=lotResult.rows.find(row=>Number(row.warehouse_id)===1)!.id;
      const immLot=lotResult.rows.find(row=>Number(row.warehouse_id)===2)!.id;
      const transactionResult=await client.query<{id:string;warehouse_id:number}>(`
        INSERT INTO ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id)
        VALUES (1,'adjustment','startCHE','hashCHE',$1),(2,'adjustment','startIMM','hashIMM',$1)
        RETURNING id,warehouse_id`,[ADMIN]);
      const cheTransaction=transactionResult.rows.find(row=>Number(row.warehouse_id)===1)!.id;
      const immTransaction=transactionResult.rows.find(row=>Number(row.warehouse_id)===2)!.id;
      await client.query(`
        INSERT INTO ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta)
        VALUES ($1,1,$2,$5,3),($3,2,$4,$5,5)`,[cheTransaction,cheLot,immTransaction,immLot,location]);
      return {cheLot,immLot};
    });

    await t.test('one click captures all groups and private users cannot bypass permissions',async()=>{
      await assert.rejects(rpc<string>(CHE_ONLY,'ci_create_unified_stock_count',['denied'],['text']),/CI_ACCESS_DENIED/);
      const batch=await rpc<string>(ADMIN,'ci_create_unified_stock_count',['Monthly count'],['text']);
      const group=await actor(ADMIN,client=>client.query<{che_count_id:string;imm_count_id:string}>(`
        SELECT che_count_id,imm_count_id FROM ci_unified_stock_counts WHERE id=$1`,[batch]));
      assert.equal(group.rowCount,1);
      assert.ok(group.rows[0].che_count_id);
      assert.ok(group.rows[0].imm_count_id);
      const children=await actor(ADMIN,client=>client.query<{warehouse_id:number;status:string}>(`
        SELECT warehouse_id,status FROM ci_stock_counts WHERE id=ANY($1::uuid[]) ORDER BY warehouse_id`,[[group.rows[0].che_count_id,group.rows[0].imm_count_id]]));
      assert.deepEqual(children.rows.map(row=>[Number(row.warehouse_id),row.status]),[[1,'draft'],[2,'draft']]);
      await assert.rejects(rpc(ADMIN,'ci_approve_unified_stock_count',[batch,'not complete'],['uuid','text']),/CI_COUNT_INCOMPLETE/);
      const countLines=await actor(ADMIN,client=>client.query<{id:string;count_id:string;warehouse_id:number}>(`
        SELECT id,count_id,warehouse_id FROM ci_stock_count_lines WHERE count_id=ANY($1::uuid[]) ORDER BY warehouse_id`,[[group.rows[0].che_count_id,group.rows[0].imm_count_id]]));
      assert.equal(countLines.rowCount,2);
      for(const row of countLines.rows) await rpc(ADMIN,'ci_set_stock_count_line',[row.id,row.warehouse_id===1?4:5],['uuid','numeric']);
      const approved=await rpc<{status:string;batch_id:string}>(ADMIN,'ci_approve_unified_stock_count',[batch,'Reconciled physical count'],['uuid','text']);
      assert.equal(approved.status,'approved');
      const after=await owner(client=>client.query<{warehouse_id:number;balance:string}>(`
        SELECT warehouse_id,sum(balance)::text AS balance FROM ci_stock_balances GROUP BY warehouse_id ORDER BY warehouse_id`));
      assert.deepEqual(after.rows.map(row=>[Number(row.warehouse_id),Number(row.balance)]),[[1,4],[2,5]]);
      const approvedCount=await owner(client=>client.query<{n:number}>(`
        SELECT count(*)::integer AS n FROM ci_stock_counts WHERE id=ANY($1::uuid[]) AND status='approved'`,[[group.rows[0].che_count_id,group.rows[0].imm_count_id]]));
      assert.equal(approvedCount.rows[0].n,2);
    });

    await t.test('stale second ledger rolls back first approval instead of partial stock update',async()=>{
      const batch=await rpc<string>(ADMIN,'ci_create_unified_stock_count',['Stale check'],['text']);
      const idsResult=await owner(client=>client.query<{che_count_id:string;imm_count_id:string}>(`
        SELECT che_count_id,imm_count_id FROM ci_unified_stock_counts WHERE id=$1`,[batch]));
      const members=Object.values(idsResult.rows[0]);
      const lines=await owner(client=>client.query<{id:string;warehouse_id:number;snapshot_quantity:string}>(`
        SELECT id,warehouse_id,snapshot_quantity FROM ci_stock_count_lines WHERE count_id=ANY($1::uuid[])`,[members]));
      for(const row of lines.rows)await rpc(ADMIN,'ci_set_stock_count_line',[row.id,Number(row.snapshot_quantity)],['uuid','numeric']);
      await owner(async client=>{
        const tx=await client.query<{id:string}>(`
          INSERT INTO ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id)
          VALUES (2,'adjustment','staleIMM','hash-stale',$1) RETURNING id`,[ADMIN]);
        await client.query(`
          INSERT INTO ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta)
          VALUES ($1,2,$2,$3,1)`,[tx.rows[0].id,ids.immLot,location]);
      });
      await assert.rejects(rpc(ADMIN,'ci_approve_unified_stock_count',[batch,'Attempt approve stale batch'],['uuid','text']),/CI_UNIFIED_COUNT_STALE/);
      const after=await owner(client=>client.query<{status:string}>(`
        SELECT status FROM ci_stock_counts WHERE id=ANY($1::uuid[])`,[members]));
      assert.deepEqual(after.rows.map(row=>row.status),['draft','draft']);
    });
  }finally{
    const client=new Client({connectionString:rootUrl.toString()});await client.connect();
    try{await client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);}finally{await client.end();}
  }
});
