import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const STAFF_CHE = '22222222-2222-4222-8222-222222222222';
const SUPERVISOR_CHE = '33333333-3333-4333-8333-333333333333';
const VIEWER_IMM = '44444444-4444-4444-8444-444444444444';

const configuredDatabaseUrl = process.env.CI_TEST_DATABASE_URL;
if (!configuredDatabaseUrl) {
  throw new Error('Set CI_TEST_DATABASE_URL with scripts/db/test.ps1 to run disposable PostgreSQL tests');
}
const adminUrl = new URL(configuredDatabaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to a disposable loopback PostgreSQL postgres database');
}
const dbName = `ci_phase1_${process.pid}_${Math.floor(Math.random() * 1000000)}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

async function connect(connectionString = testUrl.toString()) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function asUser<T>(userId: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function rpc<T>(userId: string, name: string, args: unknown[], casts: string[]): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',');
  return asUser(userId, async (client) => {
    const result = await client.query<{ result: T }>(`SELECT public.${name}(${placeholders}) AS result`, args.map((arg, i) => casts[i] === 'jsonb' ? JSON.stringify(arg) : arg));
    return result.rows[0].result;
  });
}

async function product(userId: string, warehouseId: number, productType: string, name: string, ref: string) {
  return rpc<string>(userId, 'ci_create_product', [{ warehouse_id: warehouseId, product_type: productType, source_name: name, current_ref: ref, manufacturer_barcode: `B-${ref}` }], ['jsonb']);
}

async function setup(): Promise<void> {
  const owner = await connect(adminUrl.toString());
  try { await owner.query(`CREATE DATABASE ${dbName}`); } finally { await owner.end(); }
  const client = await connect();
  try {
    const migrations = (await readdir(path.join(process.cwd(), 'supabase/migrations')))
      .filter((filename) => filename.endsWith('.sql')).sort()
      .map((filename) => `supabase/migrations/${filename}`);
    const files = ['tests/db/bootstrap.sql', ...migrations];
    for (const filename of files) await client.query(await readFile(path.join(process.cwd(), filename), 'utf8'));
    await client.query(`INSERT INTO auth.users(id) VALUES ('${ADMIN}'),('${STAFF_CHE}'),('${SUPERVISOR_CHE}'),('${VIEWER_IMM}')`);
    await client.query(`INSERT INTO public.ci_user_profiles(user_id,ephis_id,display_name) VALUES
      ('${ADMIN}','a100','Test Admin'),('${STAFF_CHE}','s200','Test Staff'),('${SUPERVISOR_CHE}','p300','Test Supervisor'),('${VIEWER_IMM}','v400','Test Viewer')`);
    await client.query(`INSERT INTO public.ci_user_access(user_id,warehouse_id,role) VALUES
      ('${ADMIN}',1,'admin'),('${ADMIN}',2,'admin'),('${STAFF_CHE}',1,'staff'),
      ('${SUPERVISOR_CHE}',1,'supervisor'),('${VIEWER_IMM}',2,'viewer')`);
  } finally { await client.end(); }
}

async function cleanup(): Promise<void> {
  const owner = await connect(adminUrl.toString());
  try { await owner.query(`DROP DATABASE ${dbName} WITH (FORCE)`); } finally { await owner.end(); }
}

test('Phase 1 PostgreSQL gate: auth, ledger, workflows, concurrency', { timeout: 120000 }, async (t) => {
  await setup();
  try {
    const reagent = await product(ADMIN, 1, 'reagent', 'Chem reagent', '00000000001');
    const calibrator = await product(ADMIN, 1, 'calibrator', 'Chem calibrator', '00000000002');
    const control = await product(ADMIN, 1, 'control', 'Chem control', '00000000003');
    const immReagent = await product(ADMIN, 2, 'reagent', 'Imm reagent', '00000000004');
    const cheLocation = await rpc<string>(ADMIN, 'ci_create_location', [1, 'A1', 'Chem shelf A1'], ['smallint', 'text', 'text']);
    const cheLocation2 = await rpc<string>(ADMIN, 'ci_create_location', [1, 'A2', 'Chem shelf A2'], ['smallint', 'text', 'text']);
    const immLocation = await rpc<string>(ADMIN, 'ci_create_location', [2, 'I1', 'Imm shelf I1'], ['smallint', 'text', 'text']);
    const vendor = await rpc<string>(ADMIN, 'ci_create_vendor', [{ vendorCode: 'V-A', name: 'Vendor A' }], ['jsonb']);

    await t.test('Product hard delete is admin-only, blocks invoice and LOT history, and audits an unused product', async () => {
      const deletable = await product(ADMIN, 1, 'consumable', 'Disposable product', 'DELETE-NO-HISTORY');
      await assert.rejects(
        () => rpc(STAFF_CHE, 'ci_delete_product', [deletable], ['uuid']),
        /CI_ACCESS_DENIED/,
      );
      await rpc(ADMIN, 'ci_delete_product', [deletable], ['uuid']);
      const deleted = await asUser(ADMIN, client => client.query('SELECT id FROM ci_products WHERE id=$1', [deletable]));
      assert.equal(deleted.rows.length, 0);
      const deleteAudit = await asUser(ADMIN, client => client.query(
        "SELECT action FROM ci_audit_logs WHERE entity_table='ci_products' AND entity_id=$1",
        [deletable],
      ));
      assert.equal(deleteAudit.rows.filter(row => row.action === 'HARD_DELETE').length, 1);

      const invoiceProduct = await product(ADMIN, 1, 'reagent', 'Invoice-protected product', 'DELETE-INVOICE');
      await rpc<string>(ADMIN, 'ci_create_invoice', [{
        vendor_id: vendor,
        invoice_number: 'INV-PRODUCT-DELETE-HISTORY',
        invoice_date: '2026-09-23',
        lines: [{ product_id: invoiceProduct, quantity: 1 }],
      }], ['jsonb']);
      await assert.rejects(
        () => rpc(ADMIN, 'ci_delete_product', [invoiceProduct], ['uuid']),
        /CI_PRODUCT_HAS_OPERATIONAL_HISTORY/,
      );

      const lotProduct = await product(ADMIN, 1, 'control', 'LOT-protected product', 'DELETE-LOT');
      const owner = await connect();
      try {
        await owner.query(
          "INSERT INTO public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date) VALUES(1,$1,'DELETE-HISTORY-LOT','2027-01-01')",
          [lotProduct],
        );
      } finally {
        await owner.end();
      }
      await assert.rejects(
        () => rpc(ADMIN, 'ci_delete_product', [lotProduct], ['uuid']),
        /CI_PRODUCT_HAS_OPERATIONAL_HISTORY/,
      );
    });

    await t.test('Ephis provisioning resolves the internal Auth identity and replaces warehouse grants atomically', async () => {
      const provisionedUser = '55555555-5555-4555-8555-555555555555';
      const owner = await connect();
      try {
        await owner.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [provisionedUser, 'ephis.new-staff@chem-immuno.internal']);
      } finally { await owner.end(); }
      await rpc(ADMIN, 'ci_provision_user', ['New-Staff','New Staff','staff',[1],true], ['text','text','text','smallint[]','boolean']);
      const check = await connect();
      try {
        const result = await check.query(`SELECT p.ephis_id,p.display_name,p.active,
          array_agg(a.warehouse_id ORDER BY a.warehouse_id) FILTER (WHERE a.active) AS active_warehouses,
          array_agg(a.role ORDER BY a.warehouse_id) FILTER (WHERE a.active) AS active_roles
          FROM public.ci_user_profiles p JOIN public.ci_user_access a ON a.user_id=p.user_id
          WHERE p.user_id=$1 GROUP BY p.ephis_id,p.display_name,p.active`, [provisionedUser]);
        assert.deepEqual(result.rows[0], {
          ephis_id: 'new-staff', display_name: 'New Staff', active: true,
          active_warehouses: [1], active_roles: ['staff'],
        });
      } finally { await check.end(); }
      await assert.rejects(() => rpc(STAFF_CHE, 'ci_provision_user', ['Other','Other User','viewer',[1],true], ['text','text','text','smallint[]','boolean']), /CI_ACCESS_DENIED/);
      await assert.rejects(() => rpc(ADMIN, 'ci_provision_user', ['Other','Other User','owner',[1],true], ['text','text','text','smallint[]','boolean']), /CI_USER_ROLE_INVALID/);
      await rpc(ADMIN, 'ci_provision_user', ['New-Staff','Updated Name','supervisor',[2],true], ['text','text','text','smallint[]','boolean']);
      const updated = await connect();
      try {
        const result = await updated.query(`SELECT p.display_name,
          array_agg(a.warehouse_id ORDER BY a.warehouse_id) FILTER (WHERE a.active) AS active_warehouses,
          array_agg(a.role ORDER BY a.warehouse_id) FILTER (WHERE a.active) AS active_roles
          FROM public.ci_user_profiles p JOIN public.ci_user_access a ON a.user_id=p.user_id
          WHERE p.user_id=$1 GROUP BY p.display_name`, [provisionedUser]);
        assert.deepEqual(result.rows[0], { display_name: 'Updated Name', active_warehouses: [2], active_roles: ['supervisor'] });
      } finally { await updated.end(); }
    });

    await t.test('product codes are transactional, immutable, and allocated across two sessions', async () => {
      const first = await connect();
      const second = await connect();
      try {
        await first.query('BEGIN');
        await first.query('SET LOCAL ROLE authenticated');
        await first.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN]);
        const a = await first.query<{ result: string }>('SELECT ci_create_product($1::jsonb) result', [{ warehouse_id: 1, product_type: 'reagent', source_name: 'Concurrent A', current_ref: 'C-A', manufacturer_barcode: 'BC-A' }]);
        await second.query('BEGIN');
        await second.query('SET LOCAL ROLE authenticated');
        await second.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN]);
        let done = false;
        const bPromise = second.query<{ result: string }>('SELECT ci_create_product($1::jsonb) result', [{ warehouse_id: 1, product_type: 'reagent', source_name: 'Concurrent B', current_ref: 'C-B', manufacturer_barcode: 'BC-B' }]).then((r) => { done = true; return r; });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(done, false, 'second session must wait on the counter row');
        await first.query('COMMIT');
        const b = await bPromise;
        await second.query('COMMIT');
        const rows = await asUser(ADMIN, (client) => client.query('SELECT product_code FROM ci_products WHERE id=ANY($1::uuid[]) ORDER BY product_code', [[a.rows[0].result, b.rows[0].result]]));
        assert.equal(rows.rows.length, 2);
        assert.notEqual(rows.rows[0].product_code, rows.rows[1].product_code);
        await assert.rejects(() => asUser(ADMIN, (client) => client.query('UPDATE ci_products SET product_code=$1 WHERE id=$2', ['CHE-9999', reagent])), /permission denied/);
      } finally { await first.end(); await second.end(); }
    });

    await t.test('warehouse RLS and relationship constraints, edit and audited hard delete', async () => {
      const hidden = await asUser(STAFF_CHE, (client) => client.query('SELECT id FROM ci_products WHERE id=$1', [immReagent]));
      assert.equal(hidden.rows.length, 0);
      await assert.rejects(() => rpc(STAFF_CHE, 'ci_save_product_relation', [{ source_product_id: reagent, target_product_id: calibrator, relation_type: 'uses_calibrator' }], ['jsonb']), /CI_ACCESS_DENIED/);
      await assert.rejects(() => rpc(ADMIN, 'ci_save_product_relation', [{ source_product_id: reagent, target_product_id: control, relation_type: 'uses_calibrator' }], ['jsonb']), /CI_RELATION_TARGET_TYPE_INVALID/);
      await assert.rejects(() => rpc(ADMIN, 'ci_save_product_relation', [{ source_product_id: reagent, target_product_id: immReagent, relation_type: 'compatible_with' }], ['jsonb']), /foreign key|violates/);
      await assert.rejects(() => rpc(ADMIN, 'ci_save_product_relation', [{ source_product_id: reagent, target_product_id: reagent, relation_type: 'other' }], ['jsonb']), /violates|check constraint/);
      const relation = await rpc<string>(ADMIN, 'ci_save_product_relation', [{ source_product_id: reagent, target_product_id: calibrator, relation_type: 'uses_calibrator', note: 'Initial' }], ['jsonb']);
      await rpc(ADMIN, 'ci_save_product_relation', [{ id: relation, source_product_id: reagent, target_product_id: control, relation_type: 'uses_control', note: 'Changed' }], ['jsonb']);
      await rpc(ADMIN, 'ci_delete_product_relation', [relation], ['uuid']);
      const rows = await asUser(ADMIN, (client) => client.query('SELECT * FROM ci_product_relations WHERE id=$1', [relation]));
      assert.equal(rows.rows.length, 0);
      const audits = await asUser(ADMIN, (client) => client.query("SELECT action FROM ci_audit_logs WHERE entity_table='ci_product_relations' AND entity_id=$1 ORDER BY id", [relation]));
      assert.deepEqual(audits.rows.map((r) => r.action), ['INSERT', 'UPDATE', 'DELETE']);
    });

    const invoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'INV-1', invoice_date: '2026-09-23', lines: [{ product_id: reagent, quantity: 4 }, { product_id: immReagent, quantity: 2 }] }], ['jsonb']);
    const invoiceLines = await asUser(ADMIN, (client) => client.query<{ id: string; warehouse_id: number }>('SELECT id,warehouse_id FROM ci_invoice_lines WHERE invoice_id=$1 ORDER BY warehouse_id', [invoice]));
    const cheLine = invoiceLines.rows[0].id;
    const immLine = invoiceLines.rows[1].id;
    const shortDate = '2026-10-10';
    const laterDate = '2026-11-10';
    const receipt = await rpc<Array<{ warehouse_id: number; transaction_id: string }>>(ADMIN, 'ci_confirm_receipt', [invoice, [
      { invoice_line_id: cheLine, quantity: 2, lot_number: 'CHE-LOT-1', expiry_date: shortDate, location_id: cheLocation },
      { invoice_line_id: immLine, quantity: 1, lot_number: 'IMM-LOT-1', expiry_date: laterDate, location_id: immLocation },
    ], 'receipt-mixed-1'], ['uuid', 'jsonb', 'text']);
    assert.equal(receipt.length, 2);
    const lots = await asUser(ADMIN, (client) => client.query<{ id: string; lot_number: string }>('SELECT id,lot_number FROM ci_stock_lots WHERE product_id=$1 ORDER BY lot_number', [reagent]));
    const cheLot = lots.rows[0].id;

    await t.test('mixed invoice, partial receipts, expiry conflict, and double submission', async () => {
      const progress = await asUser(ADMIN, (client) => client.query('SELECT remaining_quantity FROM ci_invoice_line_progress WHERE invoice_line_id=$1', [cheLine]));
      assert.equal(Number(progress.rows[0].remaining_quantity), 2);
      const same = await rpc<typeof receipt>(ADMIN, 'ci_confirm_receipt', [invoice, [
        { invoice_line_id: cheLine, quantity: 2, lot_number: 'CHE-LOT-1', expiry_date: shortDate, location_id: cheLocation },
        { invoice_line_id: immLine, quantity: 1, lot_number: 'IMM-LOT-1', expiry_date: laterDate, location_id: immLocation },
      ], 'receipt-mixed-1'], ['uuid', 'jsonb', 'text']);
      assert.deepEqual(same, receipt);
      await assert.rejects(() => rpc(ADMIN, 'ci_confirm_receipt', [invoice, [
        { invoice_line_id: cheLine, quantity: 3, lot_number: 'CHE-LOT-1', expiry_date: shortDate, location_id: cheLocation },
      ], 'receipt-too-many'], ['uuid', 'jsonb', 'text']), /CI_RECEIPT_EXCEEDS_INVOICE/);
      await assert.rejects(() => rpc(ADMIN, 'ci_confirm_receipt', [invoice, [
        { invoice_line_id: cheLine, quantity: 1, lot_number: 'CHE-LOT-1', expiry_date: '2026-12-10', location_id: cheLocation },
      ], 'receipt-expiry-conflict'], ['uuid', 'jsonb', 'text']), /CI_LOT_EXPIRY_CONFLICT/);
      const balance = await asUser(ADMIN, (client) => client.query('SELECT balance FROM ci_stock_balances WHERE lot_id=$1', [cheLot]));
      assert.equal(Number(balance.rows[0].balance), 2);
    });

    await t.test('reversing a confirmed receipt restores invoice receiving capacity and issue purpose is mandatory', async () => {
      const reversibleInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'INV-REVERSE-RECEIPT', invoice_date: '2026-09-23', lines: [{ product_id: reagent, quantity: 1 }] }], ['jsonb']);
      const line = (await asUser(ADMIN, client => client.query<{ id: string }>('SELECT id FROM ci_invoice_lines WHERE invoice_id=$1',[reversibleInvoice]))).rows[0].id;
      const [received] = await rpc<Array<{ transaction_id: string }>>(ADMIN,'ci_confirm_receipt',[reversibleInvoice,[{ invoice_line_id: line, quantity: 1, lot_number: 'REVERSE-ME', expiry_date: '2027-01-01', location_id: cheLocation }],'receipt-before-reversal'],['uuid','jsonb','text']);
      await rpc(SUPERVISOR_CHE,'ci_reverse_transaction',[received.transaction_id,'Receipt was recorded against the wrong delivery','reverse-receipt-1'],['uuid','text','text']);
      const status = await asUser(ADMIN,client => client.query<{ status:string }>('SELECT status FROM ci_invoices WHERE id=$1',[reversibleInvoice]));
      const progress = await asUser(ADMIN,client => client.query<{ remaining_quantity:number; received_quantity:number }>('SELECT remaining_quantity,received_quantity FROM ci_invoice_line_progress WHERE invoice_line_id=$1',[line]));
      assert.equal(status.rows[0].status,'open');
      assert.equal(Number(progress.rows[0].received_quantity),0);
      assert.equal(Number(progress.rows[0].remaining_quantity),1);
      await rpc(ADMIN,'ci_confirm_receipt',[reversibleInvoice,[{ invoice_line_id: line, quantity: 1, lot_number: 'RECEIPT-AFTER-REVERSAL', expiry_date: '2027-02-01', location_id: cheLocation }],'receipt-after-reversal'],['uuid','jsonb','text']);
      const closed = await asUser(ADMIN,client => client.query<{ status:string }>('SELECT status FROM ci_invoices WHERE id=$1',[reversibleInvoice]));
      assert.equal(closed.rows[0].status,'closed');
      await assert.rejects(() => rpc(ADMIN,'ci_issue_stock',[{ product_id: reagent, lot_id: cheLot, location_id: cheLocation, quantity: 0.1, idempotency_key: 'missing-purpose' }],['jsonb']),/CI_ISSUE_PURPOSE_REQUIRED|ci_issue_purpose_required/);
    });

    await t.test('FEFO override, transfer, adjustment permission, one-time reversal', async () => {
      await rpc(ADMIN, 'ci_confirm_receipt', [invoice, [
        { invoice_line_id: cheLine, quantity: 2, lot_number: 'CHE-LOT-2', expiry_date: laterDate, location_id: cheLocation },
        { invoice_line_id: immLine, quantity: 1, lot_number: 'IMM-LOT-1', expiry_date: laterDate, location_id: immLocation },
      ], 'receipt-mixed-2'], ['uuid', 'jsonb', 'text']);
      const laterLot = (await asUser(ADMIN, (client) => client.query<{ id: string }>("SELECT id FROM ci_stock_lots WHERE lot_number='CHE-LOT-2'"))).rows[0].id;
      await assert.rejects(() => rpc(STAFF_CHE, 'ci_issue_stock', [{ product_id: reagent, lot_id: laterLot, location_id: cheLocation, quantity: 1, purpose: 'Routine', idempotency_key: 'fefo-reject' }], ['jsonb']), /CI_FEFO_OVERRIDE_REASON_REQUIRED/);
      const issue = await rpc<string>(STAFF_CHE, 'ci_issue_stock', [{ product_id: reagent, lot_id: laterLot, location_id: cheLocation, quantity: 1, purpose: 'Routine', override_reason: 'Validated later lot', idempotency_key: 'fefo-override' }], ['jsonb']);
      await assert.rejects(() => rpc(STAFF_CHE, 'ci_adjust_stock', [{ lot_id: cheLot, location_id: cheLocation, quantity_delta: 1, reason: 'Check', idempotency_key: 'adj-staff' }], ['jsonb']), /CI_ACCESS_DENIED/);
      const transfer = await rpc<string>(STAFF_CHE, 'ci_transfer_stock', [{ lot_id: cheLot, from_location_id: cheLocation, to_location_id: cheLocation2, quantity: 1, idempotency_key: 'transfer-1' }], ['jsonb']);
      assert.ok(transfer);
      await assert.rejects(() => rpc(STAFF_CHE, 'ci_transfer_stock', [{ lot_id: cheLot, from_location_id: cheLocation, to_location_id: immLocation, quantity: 1, idempotency_key: 'transfer-cross' }], ['jsonb']), /CI_LOCATION_INVALID/);
      const reversal = await rpc<string>(SUPERVISOR_CHE, 'ci_reverse_transaction', [issue, 'Issue entered in error', 'reverse-1'], ['uuid', 'text', 'text']);
      assert.ok(reversal);
      await assert.rejects(() => rpc(SUPERVISOR_CHE, 'ci_reverse_transaction', [issue, 'Again', 'reverse-2'], ['uuid', 'text', 'text']), /CI_ALREADY_REVERSED/);
      const adjustment = await rpc<string>(SUPERVISOR_CHE, 'ci_adjust_stock', [{ lot_id: cheLot, location_id: cheLocation, quantity_delta: 1, reason: 'Count correction', idempotency_key: 'adj-1' }], ['jsonb']);
      assert.ok(adjustment);
      await assert.rejects(() => asUser(ADMIN, (client) => client.query('UPDATE ci_stock_movement_lines SET quantity_delta=100 WHERE transaction_id=$1', [issue])), /permission denied/);
    });

    await t.test('stale count fails closed and expired disposal uses dedicated kind', async () => {
      const count = await rpc<string>(STAFF_CHE, 'ci_create_stock_count', [{ warehouse_id: 1, lines: [{ lot_id: cheLot, location_id: cheLocation }] }], ['jsonb']);
      const countLine = (await asUser(ADMIN, (client) => client.query<{ id: string }>('SELECT id FROM ci_stock_count_lines WHERE count_id=$1', [count]))).rows[0].id;
      await rpc(STAFF_CHE, 'ci_set_stock_count_line', [countLine, 2], ['uuid', 'numeric']);
      await rpc(SUPERVISOR_CHE, 'ci_adjust_stock', [{ lot_id: cheLot, location_id: cheLocation, quantity_delta: 1, reason: 'Post snapshot', idempotency_key: 'adj-after-count' }], ['jsonb']);
      const result = await rpc<{ status: string }>(SUPERVISOR_CHE, 'ci_approve_stock_count', [count, 'Approve physical count'], ['uuid', 'text']);
      assert.equal(result.status, 'stale');
      const expiredInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'INV-EXPIRED', invoice_date: '2026-09-23', lines: [{ product_id: reagent, quantity: 1 }] }], ['jsonb']);
      const expiredLine = (await asUser(ADMIN, (client) => client.query<{ id: string }>('SELECT id FROM ci_invoice_lines WHERE invoice_id=$1', [expiredInvoice]))).rows[0].id;
      await rpc(ADMIN, 'ci_confirm_receipt', [expiredInvoice, [{ invoice_line_id: expiredLine, quantity: 1, lot_number: 'EXPIRED', expiry_date: '2025-01-01', location_id: cheLocation }], 'receipt-expired'], ['uuid', 'jsonb', 'text']);
      const expiredLot = (await asUser(ADMIN, (client) => client.query<{ id: string }>("SELECT id FROM ci_stock_lots WHERE lot_number='EXPIRED'"))).rows[0].id;
      const disposal = await rpc<string>(SUPERVISOR_CHE, 'ci_dispose_expired_stock', [{ lot_id: expiredLot, location_id: cheLocation, quantity: 1, reason: 'Expired', idempotency_key: 'dispose-1' }], ['jsonb']);
      const tx = await asUser(ADMIN, (client) => client.query('SELECT kind FROM ci_stock_transactions WHERE id=$1', [disposal]));
      assert.equal(tx.rows[0].kind, 'expired_disposal');
    });

    await t.test('two interleaved sessions cannot over-issue the same balance', async () => {
      const first = await connect();
      const second = await connect();
      try {
        for (const client of [first, second]) {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE authenticated');
          await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [STAFF_CHE]);
        }
        const p1 = { product_id: reagent, lot_id: cheLot, location_id: cheLocation, quantity: 2, purpose: 'Routine', idempotency_key: 'race-issue-1' };
        const p2 = { ...p1, idempotency_key: 'race-issue-2' };
        await first.query('SELECT ci_issue_stock($1::jsonb)', [p1]);
        let settled = false;
        const pending = second.query('SELECT ci_issue_stock($1::jsonb)', [p2]).then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(settled, false, 'second issue must wait for first transaction');
        await first.query('COMMIT');
        await assert.rejects(pending, /CI_NEGATIVE_STOCK/);
        await second.query('ROLLBACK');
      } finally { await first.end(); await second.end(); }
    });

    await t.test('two interleaved receipts cannot exceed invoice; same key is idempotent', async () => {
      const raceInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'INV-RACE', invoice_date: '2026-09-23', lines: [{ product_id: reagent, quantity: 1 }] }], ['jsonb']);
      const raceLine = (await asUser(ADMIN, (client) => client.query<{ id: string }>('SELECT id FROM ci_invoice_lines WHERE invoice_id=$1', [raceInvoice]))).rows[0].id;
      const args = [raceInvoice, [{ invoice_line_id: raceLine, quantity: 1, lot_number: 'RACE', expiry_date: laterDate, location_id: cheLocation }]];
      const first = await connect();
      const second = await connect();
      try {
        for (const client of [first, second]) {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE authenticated');
          await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN]);
        }
        const one = await first.query('SELECT ci_confirm_receipt($1::uuid,$2::jsonb,$3::text) result', [args[0], JSON.stringify(args[1]), 'same-receipt-key']);
        let settled = false;
        const pending = second.query('SELECT ci_confirm_receipt($1::uuid,$2::jsonb,$3::text) result', [args[0], JSON.stringify(args[1]), 'same-receipt-key']).then((r) => { settled = true; return r; });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(settled, false, 'second receipt must wait for invoice row');
        await first.query('COMMIT');
        const two = await pending;
        await second.query('COMMIT');
        assert.deepEqual(two.rows[0].result, one.rows[0].result);
        const count = await asUser(ADMIN, (client) => client.query('SELECT count(*)::int n FROM ci_receipt_lines WHERE invoice_line_id=$1', [raceLine]));
        assert.equal(count.rows[0].n, 1);
      } finally { await first.end(); await second.end(); }
    });

    await t.test('two different receipt keys still cannot over-receive', async () => {
      const raceInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'INV-RACE-2', invoice_date: '2026-09-23', lines: [{ product_id: reagent, quantity: 1 }] }], ['jsonb']);
      const raceLine = (await asUser(ADMIN, (client) => client.query<{ id: string }>('SELECT id FROM ci_invoice_lines WHERE invoice_id=$1', [raceInvoice]))).rows[0].id;
      const lines = JSON.stringify([{ invoice_line_id: raceLine, quantity: 1, lot_number: 'RACE-2', expiry_date: laterDate, location_id: cheLocation }]);
      const first = await connect();
      const second = await connect();
      try {
        for (const client of [first, second]) {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE authenticated');
          await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN]);
        }
        await first.query('SELECT ci_confirm_receipt($1::uuid,$2::jsonb,$3::text)', [raceInvoice, lines, 'race-receipt-1']);
        let settled = false;
        const pending = second.query('SELECT ci_confirm_receipt($1::uuid,$2::jsonb,$3::text)', [raceInvoice, lines, 'race-receipt-2'])
          .then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(settled, false);
        await first.query('COMMIT');
        await assert.rejects(pending, /CI_INVOICE_NOT_OPEN|CI_RECEIPT_EXCEEDS_INVOICE/);
        await second.query('ROLLBACK');
        const count = await asUser(ADMIN, (client) => client.query('SELECT count(*)::int n FROM ci_receipt_lines WHERE invoice_line_id=$1', [raceLine]));
        assert.equal(count.rows[0].n, 1);
      } finally { await first.end(); await second.end(); }
    });
  } finally { await cleanup(); }
});
