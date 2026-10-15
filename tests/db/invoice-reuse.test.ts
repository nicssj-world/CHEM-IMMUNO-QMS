import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// Never execute this integration test against an external/PostgREST/Production DB.
const connection = process.env.CI_TEST_DATABASE_URL;
if (!connection) throw new Error('CI_TEST_DATABASE_URL must point to disposable loopback PostgreSQL');
const adminUrl = new URL(connection);
if (!['localhost','127.0.0.1','::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('Database integration tests are restricted to loopback /postgres');
}
const dbName = `ci_invoice_reuse_${process.pid}_${Math.floor(Math.random()*1000000)}`;
const workUrl = new URL(adminUrl); workUrl.pathname = `/${dbName}`;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const invoiceNumber = 'INVOICE-REUSED-2026';

async function connect(uri: URL) {
  const client = new Client({connectionString:uri.toString()});
  await client.connect();
  return client;
}
async function withOwner<T>(fn: (db: Client)=>Promise<T>):Promise<T> {
  const db = await connect(workUrl);
  try { return await fn(db); } finally { await db.end(); }
}
async function asUser<T>(fn: (db:Client)=>Promise<T>):Promise<T> {
  return withOwner(async db => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ACTOR]);
      const output = await fn(db);
      await db.query('COMMIT');
      return output;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });
}
async function rpc(name:string,payload:unknown):Promise<string> {
  return asUser(async db => {
    const r = await db.query<{result:string}>(`SELECT public.${name}($1::jsonb) AS result`,[JSON.stringify(payload)]);
    return r.rows[0].result;
  });
}
function invoice(vendorId:string,productId:string) {
  return {vendor_id:vendorId,invoice_number:invoiceNumber,invoice_date:'2026-10-09',po_number:null,
    lines:[{product_id:productId,quantity:'2'}]};
}
async function expectUnique(run:()=>Promise<unknown>,description:string) {
  await assert.rejects(run,(error:unknown) => {
    assert.equal((error as {code?:string}).code,'23505',description);
    return true;
  });
}

test('a cancelled invoice number can be reused without losing historical invoices or weakening active uniqueness', {timeout:240000},async t=>{
  const admin=await connect(adminUrl);
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally {await admin.end();}
  try {
    let oldId='';
    let newId='';
    let vendorA='';
    let vendorB='';
    let productId='';
    let newMigration='';
    await withOwner(async db=>{
      await db.query(await readFile('tests/db/bootstrap.sql','utf8'));
      const migrations=(await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql') && !n.includes('ci_reuse_cancelled_invoice_number')).sort();
      const reuse=(await readdir('supabase/migrations')).filter(n=>n.endsWith('_ci_reuse_cancelled_invoice_number.sql'));
      assert.equal(reuse.length,1,'exactly one new invoice-reuse migration');
      newMigration=path.join('supabase/migrations',reuse[0]);
      for (const name of migrations) await db.query(await readFile(path.join('supabase/migrations',name),'utf8'));
      await db.query(`INSERT INTO auth.users(id) VALUES ('${ACTOR}')`);
      await db.query(`INSERT INTO public.ci_user_profiles(user_id,ephis_id,display_name,active) VALUES ('${ACTOR}','admin','Admin',true)`);
      await db.query(`INSERT INTO public.ci_user_access(user_id,warehouse_id,role) VALUES ('${ACTOR}',1,'admin'),('${ACTOR}',2,'admin')`);
      const vendors=await db.query<{id:string}>(`
        INSERT INTO public.ci_vendors(name,vendor_code)
        VALUES ('Supplier A','TEST-A'),('Supplier B','TEST-B') RETURNING id`);
      // Return order from INSERT is implementation-defined; load by stable name below.
      assert.equal(vendors.rowCount,2);
      vendorA=(await db.query<{id:string}>("SELECT id FROM public.ci_vendors WHERE name='Supplier A'")).rows[0].id;
      vendorB=(await db.query<{id:string}>("SELECT id FROM public.ci_vendors WHERE name='Supplier B'")).rows[0].id;
    });
    productId=await rpc('ci_create_product',{warehouse_id:1,product_type:'reagent',
      source_name:'Test Reagent',current_ref:'T-REF-1',manufacturer_barcode:'T-BAR-1'});
    oldId=await rpc('ci_create_invoice',invoice(vendorA,productId));
    await expectUnique(()=>rpc('ci_create_invoice',invoice(vendorA,productId)),
      'original unique constraint blocks same vendor+number even before cancellation');
    await withOwner(db=>db.query("UPDATE public.ci_invoices SET status='cancelled' WHERE id=$1",[oldId]));
    await expectUnique(()=>rpc('ci_create_invoice',invoice(vendorA,productId)),
      'original unique constraint blocks cancelled invoice until the migration');

    await withOwner(async db=>{ await db.query(await readFile(newMigration,'utf8')); });
    await t.test('existing cancelled invoice is still preserved with the same ID',async()=>{
      const records=await withOwner(db=>db.query<{id:string;status:string;invoice_number:string}>(
        "SELECT id,status,invoice_number FROM public.ci_invoices WHERE vendor_id=$1",[vendorA]));
      assert.deepEqual(records.rows,[{id:oldId,status:'cancelled',invoice_number:invoiceNumber}]);
      const oldLines=await withOwner(db=>db.query("SELECT id FROM public.ci_invoice_lines WHERE invoice_id=$1",[oldId]));
      assert.equal(oldLines.rowCount,1);
    });
    newId=await rpc('ci_create_invoice',invoice(vendorA,productId));
    assert.notEqual(newId,oldId);
    await t.test('new invoice with same number is distinct and active; duplicate active insert fails',async()=>{
      const records=await withOwner(db=>db.query<{id:string;status:string}>(
        "SELECT id,status FROM public.ci_invoices WHERE vendor_id=$1 AND invoice_number=$2 ORDER BY created_at,id",[vendorA,invoiceNumber]));
      assert.equal(records.rowCount,2);
      assert.equal(records.rows.find(x=>x.id===oldId)?.status,'cancelled');
      assert.equal(records.rows.find(x=>x.id===newId)?.status,'open');
      await expectUnique(()=>rpc('ci_create_invoice',invoice(vendorA,productId)),
        'partial index must protect against same vendor+number active duplicates');
      const active=await asUser(db=>db.query<{id:string}>(
        "SELECT id FROM public.ci_invoices WHERE vendor_id=$1 AND invoice_number=$2 AND status <> 'cancelled'",[vendorA,invoiceNumber]));
      assert.deepEqual(active.rows.map(x=>x.id),[newId],'application active-only query resolves the fresh invoice');
    });
    await t.test('different vendor can use the same number independently',async()=>{
      const otherId=await rpc('ci_create_invoice',invoice(vendorB,productId));
      assert.notEqual(otherId,newId);
      assert.notEqual(otherId,oldId);
    });
    await t.test('closed invoice remains active for uniqueness; cancelled invoice cannot be revived while active exists',async()=>{
      await withOwner(db=>db.query("UPDATE public.ci_invoices SET status='closed' WHERE id=$1",[newId]));
      await expectUnique(()=>rpc('ci_create_invoice',invoice(vendorA,productId)),
        'closed must count as active');
      await expectUnique(()=>withOwner(db=>db.query("UPDATE public.ci_invoices SET status='open' WHERE id=$1",[oldId])),
        'cancelled cannot be revived when a newer active invoice uses that number');
    });
    await t.test('multiple cancellation cycles retain all history',async()=>{
      await withOwner(db=>db.query("UPDATE public.ci_invoices SET status='cancelled' WHERE id=$1",[newId]));
      const thirdId=await rpc('ci_create_invoice',invoice(vendorA,productId));
      assert.ok(thirdId!==newId && thirdId!==oldId);
      const histories=await withOwner(db=>db.query<{id:string;status:string}>(
        "SELECT id,status FROM public.ci_invoices WHERE vendor_id=$1 AND invoice_number=$2",[vendorA,invoiceNumber]));
      assert.equal(histories.rowCount,3);
      assert.equal(histories.rows.filter(x=>x.status==='cancelled').length,2);
      assert.equal(histories.rows.filter(x=>x.status==='open').length,1);
      const allLines=await withOwner(db=>db.query("SELECT invoice_id FROM public.ci_invoice_lines WHERE invoice_id IN ($1,$2,$3)",[oldId,newId,thirdId]));
      assert.equal(allLines.rowCount,3,'new receipts are tied to unique Invoice IDs, not numbers');
    });
    await t.test('receipt editor ignores cancelled invoice numbers without changing other validation',async()=>{
      const functionDef=await withOwner(db=>db.query<{definition:string}>(
        "SELECT pg_get_functiondef('ci_private.ci_edit_receipt(uuid,jsonb)'::regprocedure) AS definition"));
      assert.match(functionDef.rows[0].definition,/other\.status\s*<>\s*'cancelled'/);
    });
  } finally {
    const admin=await connect(adminUrl);
    try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally {await admin.end();}
  }
});
