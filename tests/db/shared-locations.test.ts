import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// DATABASE ISOLATION: refuse any remote/non-disposable target.
const root = process.env.CI_TEST_DATABASE_URL;
if (!root) throw new Error('Provide CI_TEST_DATABASE_URL for disposable loopback PostgreSQL');
const rootUrl = new URL(root);
if (!['localhost', '127.0.0.1', '::1'].includes(rootUrl.hostname) || rootUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to loopback /postgres');
}
const dbName = `ci_shared_loc_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const dbUrl = new URL(rootUrl); dbUrl.pathname = `/${dbName}`;
const U = {
  admin: '11111111-1111-4111-8111-111111111111',
  staffChe: '22222222-2222-4222-8222-222222222222',
  supervisorChe: '33333333-3333-4333-8333-333333333333',
  staffImm: '44444444-4444-4444-8444-444444444444',
  inactive: '55555555-5555-4555-8555-555555555555',
};

async function owner<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: dbUrl.toString() }); await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}
async function asUser<T>(actor: string, fn: (db: Client) => Promise<T>): Promise<T> {
  return owner(async db => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor]);
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });
}
async function rpc<T>(actor: string, name: string, values: unknown[], casts: string[]): Promise<T> {
  return asUser(actor, async db => {
    const sql = `SELECT public.${name}(${values.map((_, i) => `$${i + 1}::${casts[i]}`).join(',')}) AS result`;
    const response = await db.query<{ result: T }>(sql, values.map((v, i) => casts[i] === 'jsonb' ? JSON.stringify(v) : v));
    return response.rows[0].result;
  });
}
const productPayload = (warehouse_id: number, label: string) => ({
  warehouse_id, product_type: 'reagent', source_name: label,
  current_ref: `REF-${label}`, manufacturer_barcode: `BAR-${label}`,
});
const newLocation = (actor: string, wh: number, code: string) =>
  rpc<string>(actor, 'ci_create_location_v2', [{ warehouse_id: wh, code, name: `Storage ${code}`, location_type: 'refrigerator' }], ['jsonb']);

test('shared Location Master: legacy IDs survive, storage is shared, stock and permissions are not merged', {timeout: 240_000}, async t => {
  const admin = new Client({ connectionString: rootUrl.toString() });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  try {
    await owner(async db => {
      await db.query(await readFile('tests/db/bootstrap.sql', 'utf8'));
      const files = (await readdir('supabase/migrations')).filter(x => x.endsWith('.sql') && !x.includes('ci_shared_location_master')).sort();
      for (const name of files) await db.query(await readFile(path.join('supabase/migrations', name), 'utf8'));
      await db.query(`INSERT INTO auth.users(id) VALUES ('${U.admin}'),('${U.staffChe}'),('${U.supervisorChe}'),('${U.staffImm}'),('${U.inactive}')`);
      await db.query(`INSERT INTO public.ci_user_profiles(user_id,ephis_id,display_name,active) VALUES
        ('${U.admin}','a100','Admin',true),('${U.staffChe}','c200','Staff CHE',true),
        ('${U.supervisorChe}','c300','Supervisor CHE',true),('${U.staffImm}','i400','Staff IMM',true),
        ('${U.inactive}','i500','Inactive',false)`);
      await db.query(`INSERT INTO public.ci_user_access(user_id,warehouse_id,role) VALUES
        ('${U.admin}',1,'admin'),('${U.admin}',2,'admin'),('${U.staffChe}',1,'staff'),
        ('${U.supervisorChe}',1,'supervisor'),('${U.staffImm}',2,'staff'),('${U.inactive}',2,'admin')`);
    });

    // These codes collide across warehouses in the legacy design. Never auto-merge them.
    const che = await newLocation(U.admin, 1, 'FR-01');
    const imm = await newLocation(U.admin, 2, 'FR-01');
    const productChe = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'CHE-P')], ['jsonb']);
    const productImm = await rpc<string>(U.admin, 'ci_create_product', [productPayload(2, 'IMM-P')], ['jsonb']);
    await owner(async db => db.query(await readFile('supabase/migrations/20261009052520_ci_shared_location_master.sql', 'utf8')));

    await t.test('all legacy physical Location IDs and origins remain, with links to both warehouses', async () => {
      const rows = await owner(db => db.query<{id: string; warehouse_id: number}>('SELECT id,warehouse_id FROM public.ci_locations ORDER BY id'));
      assert.equal(rows.rowCount, 2, 'legacy duplicate physical entries are not deleted or conflated');
      assert.ok(rows.rows.some(row => row.id === che && Number(row.warehouse_id) === 1));
      assert.ok(rows.rows.some(row => row.id === imm && Number(row.warehouse_id) === 2));
      const links = await owner(db => db.query('SELECT location_id,warehouse_id FROM public.ci_location_warehouses'));
      assert.equal(links.rowCount, 4);
      await assert.rejects(
        () => asUser(U.staffChe, db => db.query('SELECT count(*) FROM public.ci_location_warehouses')),
        /permission denied/,
        'warehouse link internals are never publicly readable',
      );
      const cheReadable = await asUser(U.staffChe, db => db.query<{id:string}>('SELECT id FROM public.ci_locations ORDER BY id'));
      const immReadable = await asUser(U.staffImm, db => db.query<{id:string}>('SELECT id FROM public.ci_locations ORDER BY id'));
      assert.deepEqual(cheReadable.rows.map(x=>x.id),immReadable.rows.map(x=>x.id));
      assert.equal(cheReadable.rowCount,2);
      const forbidden = await asUser(U.inactive, db => db.query('SELECT id FROM public.ci_locations'));
      assert.equal(forbidden.rowCount,0);
    });

    await t.test('Cross-warehouse Product default can use the same physical Location ID', async () => {
      await rpc(U.admin, 'ci_update_product', [productChe,{default_location_id: imm}], ['uuid','jsonb']);
      await rpc(U.admin, 'ci_update_product', [productImm,{default_location_id: che}], ['uuid','jsonb']);
      const rows = await owner(db => db.query<{id:string;default_location_id:string}>(
        'SELECT id,default_location_id FROM public.ci_products WHERE id = ANY($1::uuid[])',[ [productChe,productImm] ]));
      assert.equal(rows.rows.find(x=>x.id===productChe)?.default_location_id,imm);
      assert.equal(rows.rows.find(x=>x.id===productImm)?.default_location_id,che);
    });

    await t.test('supervisors manage the shared registry but staff and inactive users cannot edit', async () => {
      const date = await owner(db => db.query<{updated_at:string}>('SELECT updated_at::text AS updated_at FROM public.ci_locations WHERE id=$1',[imm]));
      await rpc(U.supervisorChe,'ci_update_location',[imm,{name:'Shared refrigerator'},date.rows[0].updated_at],['uuid','jsonb','timestamptz']);
      await assert.rejects(()=>rpc(U.staffChe,'ci_update_location',[imm,{name:'Tamper'},date.rows[0].updated_at],['uuid','jsonb','timestamptz']),/CI_ACCESS_DENIED/);
      await assert.rejects(()=>newLocation(U.inactive,1,'NEW'),/CI_ACCESS_DENIED/);
      await assert.rejects(()=>newLocation(U.admin,2,'FR-01'),/CI_LOCATION_CODE_EXISTS/);
      const created = await newLocation(U.supervisorChe,1,'FR-02');
      const links = await owner(db => db.query('SELECT warehouse_id FROM public.ci_location_warehouses WHERE location_id=$1',[created]));
      assert.equal(links.rowCount,2,'new locations are atomically available to CHE and IMM');
    });

    await t.test('same physical Location holds distinct CHE/IMM lots and ledger balances', async () => {
      const {rows:lots} = await owner(db=>db.query<{id:string;warehouse_id:number}>(`
        INSERT INTO public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date)
        VALUES (1,$1,'CHE-LOT','2027-12-31'),(2,$2,'IMM-LOT','2027-12-31')
        RETURNING id,warehouse_id`,[productChe,productImm]));
      const cheLot = lots.find(x=>Number(x.warehouse_id)===1)!.id;
      const immLot = lots.find(x=>Number(x.warehouse_id)===2)!.id;
      const tx = await owner(db=>db.query<{id:string;warehouse_id:number}>(`
        INSERT INTO public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id)
        VALUES (1,'adjustment',$1,'h1',$3),(2,'adjustment',$2,'h2',$3)
        RETURNING id,warehouse_id`,['k1','k2',U.admin]));
      const cheTx=tx.rows.find(x=>Number(x.warehouse_id)===1)!.id;
      const immTx=tx.rows.find(x=>Number(x.warehouse_id)===2)!.id;
      await owner(db=>db.query(`
        INSERT INTO public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta)
        VALUES ($1,1,$2,$5,3),($3,2,$4,$5,5)`,[cheTx,cheLot,immTx,immLot,che]));
      const totals=await owner(db=>db.query<{warehouse_id:number;balance:string}>(`
        SELECT warehouse_id,sum(balance)::text AS balance
        FROM public.ci_stock_balances WHERE location_id=$1 GROUP BY warehouse_id ORDER BY warehouse_id`,[che]));
      assert.deepEqual(totals.rows.map(x=>[Number(x.warehouse_id),Number(x.balance)]),[[1,3],[2,5]]);
      // Sharing the physical location must never grant staff access to the other warehouse's stock.
      const cheView = await asUser(U.staffChe, db => db.query<{warehouse_id:number;balance:string}>(
        'SELECT warehouse_id,balance::text FROM public.ci_stock_balances WHERE location_id=$1',[che]));
      const immView = await asUser(U.staffImm, db => db.query<{warehouse_id:number;balance:string}>(
        'SELECT warehouse_id,balance::text FROM public.ci_stock_balances WHERE location_id=$1',[che]));
      assert.deepEqual(cheView.rows.map(x=>Number(x.warehouse_id)),[1],'CHE stock access remains scoped');
      assert.deepEqual(immView.rows.map(x=>Number(x.warehouse_id)),[2],'IMM stock access remains scoped');
      await assert.rejects(()=>rpc(U.supervisorChe,'ci_set_location_active',[che,false,'still in use'],['uuid','boolean','text']),/CI_LOCATION_HAS_STOCK|CI_LOCATION_IS_PRODUCT_DEFAULT/);
      const transfer=await rpc<string>(U.staffImm,'ci_transfer_stock',[{
        lot_id:immLot,from_location_id:che,to_location_id:imm,quantity:2,idempotency_key:'imm-transfer'
      }],['jsonb']);
      assert.ok(transfer);
      const after=await owner(db=>db.query<{location_id:string;balance:string}>(`
        SELECT location_id,balance::text FROM public.ci_stock_balances WHERE lot_id=$1 ORDER BY location_id`,[immLot]));
      assert.equal(after.rows.reduce((sum,row)=>sum+Number(row.balance),0),5);
      assert.equal(after.rows.find(row=>row.location_id===imm)?.balance,'2.000');
      // FEFO/Issue still authorizes by Product warehouse, not physical location provenance.
      const issue=await rpc<string>(U.staffImm,'ci_issue_stock',[{
        product_id:productImm,lot_id:immLot,location_id:imm,quantity:1,purpose:'QC',idempotency_key:'imm-issue'
      }],['jsonb']);
      assert.ok(issue);
    });
  } finally {
    const drop = new Client({ connectionString: rootUrl.toString() }); await drop.connect();
    try { await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await drop.end(); }
  }
});
