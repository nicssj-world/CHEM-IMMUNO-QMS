import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// Product -> Default Location: an OPTIONAL preferred/recommended storage Location, used only to preselect the
// Location when receiving. Actual stock location is, and remains, whatever ci_stock_movement_lines/ci_stock_balances
// say - this file specifically proves the two never entangle.

const root = process.env.CI_TEST_DATABASE_URL;
if (!root) throw new Error('Set CI_TEST_DATABASE_URL with scripts/db/test.ps1 to run disposable PostgreSQL tests');
const adminUrl = new URL(root);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to disposable loopback PostgreSQL');
}
const dbName = `ci_prod_default_loc_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${dbName}`;
const U = {
  admin: '11111111-1111-4111-8111-111111111111',
  staff: '22222222-2222-4222-8222-222222222222',
  supervisor: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  imm: '55555555-5555-4555-8555-555555555555',
} as const;

async function owner<T>(run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: dbUrl.toString() }); await db.connect();
  try { return await run(db); } finally { await db.end(); }
}
async function user<T>(id: string, run: (db: Client) => Promise<T>): Promise<T> {
  return owner(async db => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [id]);
      const value = await run(db);
      await db.query('COMMIT'); return value;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });
}
async function rpc<T>(id: string, name: string, args: unknown[], casts: string[]): Promise<T> {
  return user(id, async db => {
    const result = await db.query<{ result: T }>(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',')}) AS result`,
      args.map((value, i) => casts[i] === 'jsonb' ? JSON.stringify(value) : value));
    return result.rows[0].result;
  });
}
const uuid = () => crypto.randomUUID();
const location = (adminId: string, warehouseId: number, code: string) => rpc<string>(adminId, 'ci_create_location', [warehouseId, code, code], ['smallint', 'text', 'text']);
const productPayload = (warehouseId: number, ref: string, extra: Record<string, unknown> = {}) => ({ warehouse_id: warehouseId, product_type: 'reagent', source_name: ref, current_ref: ref, manufacturer_barcode: `B-${ref}`, ...extra });

test('Product -> Default Location: optional, same-warehouse, active-only assignment, deactivation guard, ledger untouched', { timeout: 240_000 }, async t => {
  const admin = new Client({ connectionString: adminUrl.toString() }); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  try {
    await owner(async db => {
      await db.query(await readFile('tests/db/bootstrap.sql', 'utf8'));
      for (const file of (await readdir('supabase/migrations')).filter(name => name.endsWith('.sql') && !name.includes('ci_shared_location_master')).sort()) {
        await db.query(await readFile(path.join('supabase/migrations', file), 'utf8'));
      }
      await db.query(`INSERT INTO auth.users(id) VALUES ('${U.admin}'),('${U.staff}'),('${U.supervisor}'),('${U.viewer}'),('${U.imm}')`);
      await db.query(`INSERT INTO public.ci_user_profiles(user_id,ephis_id,display_name,active) VALUES
        ('${U.admin}','a100','Admin',true),('${U.staff}','s200','Staff',true),('${U.supervisor}','p300','Supervisor',true),
        ('${U.viewer}','v400','Viewer',true),('${U.imm}','i500','IMM',true)`);
      await db.query(`INSERT INTO public.ci_user_access(user_id,warehouse_id,role) VALUES
        ('${U.admin}',1,'admin'),('${U.admin}',2,'admin'),('${U.staff}',1,'staff'),('${U.supervisor}',1,'supervisor'),
        ('${U.viewer}',1,'viewer'),('${U.imm}',2,'staff')`);
    });
    const cheA = await location(U.admin, 1, 'CHE-A');
    const cheB = await location(U.admin, 1, 'CHE-B');
    const immA = await location(U.admin, 2, 'IMM-A');
    const productRow = async (id: string) => (await owner(db => db.query('SELECT * FROM public.ci_products WHERE id = $1', [id]))).rows[0];

    await t.test('create without a default Location still works, and the column starts NULL', async () => {
      const id = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'P-NONE')], ['jsonb']);
      assert.equal((await productRow(id)).default_location_id, null);
    });

    await t.test('create with a valid same-warehouse active default Location works', async () => {
      const id = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'P-CREATE-OK', { default_location_id: cheA })], ['jsonb']);
      assert.equal((await productRow(id)).default_location_id, cheA);
    });

    await t.test('create rejects a cross-warehouse, nonexistent, or malformed default Location', async () => {
      await assert.rejects(() => rpc(U.admin, 'ci_create_product', [productPayload(1, 'P-CREATE-CROSS', { default_location_id: immA })], ['jsonb']), /CI_LOCATION_INVALID/);
      await assert.rejects(() => rpc(U.admin, 'ci_create_product', [productPayload(1, 'P-CREATE-MISSING', { default_location_id: uuid() })], ['jsonb']), /CI_LOCATION_INVALID/);
      await assert.rejects(() => rpc(U.admin, 'ci_create_product', [productPayload(1, 'P-CREATE-MALFORMED', { default_location_id: 'not-a-uuid' })], ['jsonb']), /CI_LOCATION_INVALID/);
    });

    await t.test('create rejects an inactive default Location', async () => {
      const loc = await location(U.admin, 1, 'CHE-INACTIVE-1');
      await rpc(U.admin, 'ci_set_location_active', [loc, false, 'ทดสอบ'], ['uuid', 'boolean', 'text']);
      await assert.rejects(() => rpc(U.admin, 'ci_create_product', [productPayload(1, 'P-CREATE-INACTIVE', { default_location_id: loc })], ['jsonb']), /CI_LOCATION_INVALID/);
    });

    const target = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'P-EDIT')], ['jsonb']);

    await t.test('Supervisor/Admin can assign, then clear, a Default Location', async () => {
      await rpc(U.supervisor, 'ci_update_product', [target, { default_location_id: cheA }], ['uuid', 'jsonb']);
      assert.equal((await productRow(target)).default_location_id, cheA);
      await rpc(U.admin, 'ci_update_product', [target, { default_location_id: cheB }], ['uuid', 'jsonb']);
      assert.equal((await productRow(target)).default_location_id, cheB, 'reassignment to another same-warehouse active Location works');
      await rpc(U.admin, 'ci_update_product', [target, { default_location_id: null }], ['uuid', 'jsonb']);
      assert.equal((await productRow(target)).default_location_id, null, 'clearing back to NULL always works, regardless of the Location');
      // Omitting the key entirely must leave the existing value alone (distinct from explicitly clearing it).
      await rpc(U.admin, 'ci_update_product', [target, { default_location_id: cheA }], ['uuid', 'jsonb']);
      await rpc(U.admin, 'ci_update_product', [target, { display_name: 'P-EDIT renamed' }], ['uuid', 'jsonb']);
      assert.equal((await productRow(target)).default_location_id, cheA, 'an update that does not mention default_location_id leaves it untouched');
    });

    await t.test('edit rejects cross-warehouse, nonexistent, and inactive Locations the same way create does', async () => {
      await assert.rejects(() => rpc(U.admin, 'ci_update_product', [target, { default_location_id: immA }], ['uuid', 'jsonb']), /CI_LOCATION_INVALID/);
      await assert.rejects(() => rpc(U.admin, 'ci_update_product', [target, { default_location_id: uuid() }], ['uuid', 'jsonb']), /CI_LOCATION_INVALID/);
      const inactive = await location(U.admin, 1, 'CHE-INACTIVE-2');
      await rpc(U.admin, 'ci_set_location_active', [inactive, false, 'ทดสอบ'], ['uuid', 'boolean', 'text']);
      await assert.rejects(() => rpc(U.admin, 'ci_update_product', [target, { default_location_id: inactive }], ['uuid', 'jsonb']), /CI_LOCATION_INVALID/);
      assert.equal((await productRow(target)).default_location_id, cheA, 'every rejected attempt left the prior value alone');
    });

    await t.test('an account without Product Master edit rights cannot change the default, even alone', async () => {
      await assert.rejects(() => rpc(U.staff, 'ci_update_product', [target, { default_location_id: cheB }], ['uuid', 'jsonb']), /CI_ACCESS_DENIED/);
      await assert.rejects(() => rpc(U.viewer, 'ci_update_product', [target, { default_location_id: cheB }], ['uuid', 'jsonb']), /CI_ACCESS_DENIED/);
      // A warehouse-2 account (even with edit rights there) cannot touch a warehouse-1 Product's default.
      await assert.rejects(() => rpc(U.imm, 'ci_update_product', [target, { default_location_id: immA }], ['uuid', 'jsonb']), /CI_ACCESS_DENIED/);
      assert.equal((await productRow(target)).default_location_id, cheA);
    });

    await t.test('direct authenticated table writes to ci_products remain denied', async () => {
      await assert.rejects(() => user(U.admin, db => db.query('UPDATE public.ci_products SET default_location_id = $1 WHERE id = $2', [cheB, target])), /permission denied/);
    });

    await t.test('a Location referenced as an active Product’s default cannot be deactivated until cleared', async () => {
      // A dedicated Location, referenced by exactly one Product, so clearing that one Product's default is what unblocks it.
      const guarded = await location(U.admin, 1, 'CHE-GUARDED');
      const guardedProduct = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'P-GUARDED', { default_location_id: guarded })], ['jsonb']);
      await assert.rejects(() => rpc(U.admin, 'ci_set_location_active', [guarded, false, 'ปิดตรวจสอบ'], ['uuid', 'boolean', 'text']), /CI_LOCATION_IS_PRODUCT_DEFAULT/);
      // Clearing (or reassigning away) the default unblocks it; the guard never clears anything automatically.
      await rpc(U.admin, 'ci_update_product', [guardedProduct, { default_location_id: null }], ['uuid', 'jsonb']);
      await rpc(U.admin, 'ci_set_location_active', [guarded, false, 'ปิดหลังล้างค่า'], ['uuid', 'boolean', 'text']);
      assert.equal((await owner(db => db.query('SELECT active FROM public.ci_locations WHERE id = $1', [guarded]))).rows[0].active, false);
    });

    await t.test('an inactive Product’s stale default does not block deactivating the Location', async () => {
      const retired = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'P-RETIRED', { default_location_id: cheB })], ['jsonb']);
      await rpc(U.admin, 'ci_update_product', [retired, { active: false }], ['uuid', 'jsonb']);
      assert.equal((await productRow(retired)).default_location_id, cheB, 'deactivating the Product does not clear its default');
      await rpc(U.admin, 'ci_set_location_active', [cheB, false, 'ตรวจสอบสินค้าปิดใช้งานไม่บล็อก'], ['uuid', 'boolean', 'text']);
      assert.equal((await owner(db => db.query('SELECT active FROM public.ci_locations WHERE id = $1', [cheB]))).rows[0].active, false);
      await rpc(U.admin, 'ci_set_location_active', [cheB, true, 'เปิดกลับ'], ['uuid', 'boolean', 'text']);
    });

    await t.test('changing or transferring a Product’s default never touches actual stock, and vice versa', async () => {
      const stockLoc = await location(U.admin, 1, 'CHE-STOCK-A');
      const stockLoc2 = await location(U.admin, 1, 'CHE-STOCK-B');
      const product = await rpc<string>(U.admin, 'ci_create_product', [productPayload(1, 'P-STOCK', { default_location_id: stockLoc })], ['jsonb']);
      const lot = await owner(async db => (await db.query(
        `INSERT INTO public.ci_stock_lots(product_id,warehouse_id,lot_number,expiry_date) VALUES ($1,1,'L1','2030-01-01') RETURNING id`, [product]
      )).rows[0].id as string);
      const tx = await owner(async db => (await db.query(
        `INSERT INTO public.ci_stock_transactions(warehouse_id,kind,actor_id,idempotency_key,request_hash) VALUES (1,'receive',$1,$2,$2) RETURNING id`, [U.admin, uuid()]
      )).rows[0].id as string);
      await owner(db => db.query(`INSERT INTO public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) VALUES ($1,1,$2,$3,10)`, [tx, lot, stockLoc]));
      const balanceAt = async (locationId: string) => Number((await owner(db => db.query(
        `SELECT COALESCE(SUM(quantity_delta),0)::numeric AS n FROM public.ci_stock_movement_lines WHERE lot_id = $1 AND location_id = $2`, [lot, locationId]
      ))).rows[0].n);
      assert.equal(await balanceAt(stockLoc), 10);
      // Changing the Product's default to a DIFFERENT Location must not move, or even reference, the actual stock.
      await rpc(U.admin, 'ci_update_product', [product, { default_location_id: stockLoc2 }], ['uuid', 'jsonb']);
      assert.equal(await balanceAt(stockLoc), 10, 'stock stays exactly where the ledger put it');
      assert.equal(await balanceAt(stockLoc2), 0, 'no stock is invented at the new default');
      assert.equal((await productRow(product)).default_location_id, stockLoc2);
      // A transfer (two movement lines, one negative one positive) must not touch the Product's default either way.
      const transferTx = await owner(async db => (await db.query(
        `INSERT INTO public.ci_stock_transactions(warehouse_id,kind,actor_id,idempotency_key,request_hash) VALUES (1,'transfer',$1,$2,$2) RETURNING id`, [U.admin, uuid()]
      )).rows[0].id as string);
      await owner(db => db.query(`INSERT INTO public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) VALUES ($1,1,$2,$3,-10),($1,1,$2,$4,10)`, [transferTx, lot, stockLoc, stockLoc2]));
      assert.equal(await balanceAt(stockLoc), 0);
      assert.equal(await balanceAt(stockLoc2), 10, 'the transfer is real and lands at the second Location');
      assert.equal((await productRow(product)).default_location_id, stockLoc2, 'the transfer left the Product default exactly as it was - FR-01 stays FR-01 even though stock moved to FR-02');
      // Existing ledger invariant: the balance view agrees with the raw ledger sum.
      const viewBalance = await owner(db => db.query(`SELECT balance FROM public.ci_stock_balances WHERE lot_id = $1 AND location_id = $2`, [lot, stockLoc2]));
      assert.equal(Number(viewBalance.rows[0].balance), 10);
    });
  } finally {
    const admin2 = new Client({ connectionString: adminUrl.toString() }); await admin2.connect();
    try { await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await admin2.end(); }
  }
});
