import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const root = process.env.CI_TEST_DATABASE_URL;
if (!root) throw new Error('Set CI_TEST_DATABASE_URL to disposable loopback PostgreSQL');
const rootUrl = new URL(root);
if (!['localhost','127.0.0.1','::1'].includes(rootUrl.hostname) || rootUrl.pathname !== '/postgres') throw new Error('Only loopback /postgres is allowed');
const dbName = `ci_po_seller_${process.pid}_${Math.floor(Math.random()*100000)}`;
const dbUrl = new URL(rootUrl); dbUrl.pathname = '/' + dbName;
const admin = randomUUID(), seller = randomUUID(), seller2 = randomUUID(), cheOnly = randomUUID(), denied = randomUUID();
async function connect(url = dbUrl.toString()) {
  const c = new Client({ connectionString: url }); await c.connect(); return c;
}
async function actor<T>(user: string, fn: (c: Client) => Promise<T>) {
  const c = await connect();
  try {
    await c.query('begin'); await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    const result = await fn(c); await c.query('commit'); return result;
  } catch (e) { await c.query('rollback'); throw e; } finally { await c.end(); }
}
async function rpc<T>(user: string, sql: string, params: unknown[]) {
  return actor(user, async c => (await c.query<{result:T}>(sql,params)).rows[0].result);
}
type Ack = { acknowledged_at: string; acknowledged_by: string; acknowledged_by_name: string };

test('seller confirmation: authorization, first writer, revocation, history and no stock changes', { timeout: 180000 }, async () => {
  const rootClient = await connect(rootUrl.toString());
  try { await rootClient.query(`create database ${dbName}`); } finally { await rootClient.end(); }
  try {
    const c = await connect();
    try {
      await c.query(await readFile('tests/db/bootstrap.sql','utf8'));
      for (const name of (await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort())
        await c.query(await readFile(path.join('supabase/migrations',name),'utf8'));
      for (const [id,ephis,display,role,warehouses] of [
        [admin,'admin','Admin','admin',[1,2]],
        [seller,'seller','Seller One','viewer',[1,2]],
        [seller2,'seller2','Seller Two','viewer',[1,2]],
        [cheOnly,'cheonly','CHE Viewer','viewer',[1]],
        [denied,'denied','Denied','viewer',[1,2]],
      ] as const) {
        await c.query('insert into auth.users(id) values($1)',[id]);
        await c.query('insert into ci_user_profiles(user_id,ephis_id,display_name,active) values($1,$2,$3,true)',[id,ephis,display]);
        for (const wh of warehouses) await c.query('insert into ci_user_access(user_id,warehouse_id,role,active) values($1,$2,$3,true)',[id,wh,role]);
      }
    } finally { await c.end(); }
    const grant = (u:string,ephis:string,enabled:boolean) => rpc(u,'select ci_set_po_confirmation_permission($1,$2) result',[ephis,enabled]);
    const eligible = (u:string,id:string) => rpc<boolean>(u,'select ci_can_seller_confirm_purchase_order($1) result',[id]);
    const confirm = (u:string,id:string) => rpc<Ack>(u,'select ci_confirm_purchase_order_as_seller($1) result',[id]);
    const createProduct = (wh:number,name:string) => rpc<string>(admin,'select ci_create_product($1::jsonb) result',[JSON.stringify({warehouse_id:wh,product_type:'reagent',source_name:name,current_ref:'REF-'+name,manufacturer_barcode:'BC-'+name})]);
    const che = await createProduct(1,'CHE'), imm = await createProduct(2,'IMM');
    const createOrder = (done:boolean,ids:string[]) => rpc<{id:string}>(admin,'select ci_save_purchase_order($1::jsonb) result',[JSON.stringify({client_key:randomUUID(),confirm:done,lines:ids.map(id=>({product_id:id,order_quantity:1}))})]);
    const order = await createOrder(true,[che,imm]), draft = await createOrder(false,[che]), other = await createOrder(true,[che]);
    const original = await actor(admin,c=>c.query('select * from ci_purchase_order_lines where purchase_order_id=$1 order by id',[order.id]));
    const ledgerBefore = await actor(admin,c=>c.query('select count(*) n from ci_stock_movement_lines'));
    await assert.rejects(grant(seller,'seller',true),/CI_ACCESS_DENIED/);
    await assert.rejects(confirm(seller,order.id),/CI_ACCESS_DENIED/);
    assert.equal(await eligible(seller,order.id),false);
    await grant(admin,'seller',true); await grant(admin,'seller2',true); await grant(admin,'cheonly',true);
    assert.equal(await eligible(seller,order.id),true);
    assert.equal(await eligible(cheOnly,order.id),false);
    assert.equal(await eligible(cheOnly,other.id),true);
    assert.equal(await eligible(seller,draft.id),false);
    await assert.rejects(confirm(cheOnly,order.id),/CI_ACCESS_DENIED/);
    await assert.rejects(confirm(seller,draft.id),/CI_PO_SELLER_NOT_ORDERED/);
    await assert.rejects(confirm(denied,order.id),/CI_ACCESS_DENIED/);
    await assert.rejects(actor(seller,c=>c.query('update ci_purchase_orders set acknowledged_at=now() where id=$1',[order.id])),/permission denied/);
    await assert.rejects(actor(seller,c=>c.query('update ci_user_profiles set can_confirm_purchase_orders=true where user_id=$1',[seller])),/permission denied/);
    await assert.rejects(rpc(seller,'select ci_cancel_purchase_order($1) result',[order.id]),/CI_ACCESS_DENIED/);
    const [a,b] = await Promise.all([confirm(seller,order.id),confirm(seller2,order.id)]);
    assert.deepEqual(a,b); assert.ok([seller,seller2].includes(a.acknowledged_by));
    assert.ok(a.acknowledged_at); assert.ok(['Seller One','Seller Two'].includes(a.acknowledged_by_name));
    assert.deepEqual(await confirm(seller,order.id),a);
    assert.equal(await eligible(seller,order.id),false);
    const after = await actor(admin,c=>c.query('select * from ci_purchase_order_lines where purchase_order_id=$1 order by id',[order.id]));
    assert.deepEqual(after.rows,original.rows);
    await grant(admin,'seller',false);
    assert.equal(await eligible(seller,other.id),false);
    await assert.rejects(confirm(seller,other.id),/CI_ACCESS_DENIED/);
    await rpc(admin,'select ci_cancel_purchase_order($1) result',[order.id]);
    await assert.rejects(confirm(seller2,order.id),/CI_PO_SELLER_NOT_ORDERED/);
    const history = await actor(admin,c=>c.query('select status,acknowledged_by,acknowledged_by_name,acknowledged_at from ci_purchase_orders where id=$1',[order.id]));
    assert.equal(history.rows[0].status,'cancelled');
    assert.equal(history.rows[0].acknowledged_by,a.acknowledged_by);
    assert.equal(new Date(history.rows[0].acknowledged_at).toISOString(),new Date(a.acknowledged_at).toISOString());
    assert.equal(history.rows[0].acknowledged_by_name,a.acknowledged_by_name);
    assert.deepEqual((await actor(admin,c=>c.query('select count(*) n from ci_stock_movement_lines'))).rows,ledgerBefore.rows);
    const verification = await connect();
    try {
      assert.equal((await verification.query("select has_function_privilege('anon','public.ci_confirm_purchase_order_as_seller(uuid)','EXECUTE') allowed")).rows[0].allowed,false);
      await verification.query('update ci_user_profiles set active=false where user_id=$1',[seller2]);
    } finally { await verification.end(); }
    assert.equal(await eligible(seller2,other.id),false);
    await assert.rejects(confirm(seller2,other.id),/CI_ACCESS_DENIED/);
  } finally {
    const cleanup=await connect(rootUrl.toString());
    try { await cleanup.query(`drop database if exists ${dbName} with (force)`); } finally { await cleanup.end(); }
  }
});
