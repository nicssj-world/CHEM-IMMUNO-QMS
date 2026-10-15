import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const SUPERVISOR = '33333333-3333-4333-8333-333333333333';
const root = process.env.CI_TEST_DATABASE_URL;
if (!root) throw new Error('Set CI_TEST_DATABASE_URL via scripts/db/test.ps1');
const adminUrl = new URL(root);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required');
const dbName = `ci_receipt_edit_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

async function connect(url = testUrl.toString()) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function asUser<T>(id: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

async function rpc<T>(id: string, name: string, args: unknown[], casts: string[]): Promise<T> {
  return asUser(id, async client => {
    const placeholders = args.map((_, index) => `$${index + 1}::${casts[index]}`).join(',');
    const result = await client.query<{ result: T }>(`select public.${name}(${placeholders}) as result`, args.map((arg, index) => casts[index] === 'jsonb' ? JSON.stringify(arg) : arg));
    return result.rows[0].result;
  });
}

async function setup() {
  const owner = await connect(adminUrl.toString());
  try { await owner.query(`create database ${dbName}`); } finally { await owner.end(); }
  const client = await connect();
  try {
    const migrations = (await readdir(path.join(process.cwd(), 'supabase/migrations'))).filter(file => file.endsWith('.sql')).sort();
    for (const file of ['tests/db/bootstrap.sql', ...migrations.map(name => `supabase/migrations/${name}`)]) {
      await client.query(await readFile(path.join(process.cwd(), file), 'utf8'));
    }
    await client.query('insert into auth.users(id) values ($1),($2),($3)', [ADMIN, STAFF, SUPERVISOR]);
    await client.query("insert into public.ci_user_profiles(user_id,ephis_id,display_name) values ($1,'edit-admin','Admin'),($2,'edit-staff','Staff'),($3,'edit-supervisor','Supervisor')", [ADMIN, STAFF, SUPERVISOR]);
    await client.query("insert into public.ci_user_access(user_id,warehouse_id,role) values ($1,1,'admin'),($1,2,'admin'),($2,1,'staff'),($3,1,'supervisor')", [ADMIN, STAFF, SUPERVISOR]);
  } finally { await client.end(); }
}

async function cleanup() {
  const client = await connect(adminUrl.toString());
  try { await client.query(`drop database ${dbName} with (force)`); } finally { await client.end(); }
}

test('confirmed receipt can be edited in place and stock, invoice progress, and assessment remain consistent', { timeout: 120_000 }, async t => {
  await setup();
  try {
    const product = await rpc<string>(ADMIN, 'ci_create_product', [{ warehouse_id: 1, product_type: 'reagent', source_name: 'Receipt edit reagent', current_ref: 'EDIT-001', manufacturer_barcode: 'EDIT-001' }], ['jsonb']);
    const secondProduct = await rpc<string>(ADMIN, 'ci_create_product', [{ warehouse_id: 1, product_type: 'reagent', source_name: 'Second reagent', current_ref: 'EDIT-002', manufacturer_barcode: 'EDIT-002' }], ['jsonb']);
    const immProduct = await rpc<string>(ADMIN, 'ci_create_product', [{ warehouse_id: 2, product_type: 'reagent', source_name: 'IMM receipt edit reagent', current_ref: 'EDIT-IMM-001', manufacturer_barcode: 'EDIT-IMM-001' }], ['jsonb']);
    const locationA = await rpc<string>(ADMIN, 'ci_create_location', [1, 'EDIT-A', 'Receipt edit A'], ['smallint', 'text', 'text']);
    const locationB = await rpc<string>(ADMIN, 'ci_create_location', [1, 'EDIT-B', 'Receipt edit B'], ['smallint', 'text', 'text']);
    const immLocation = await rpc<string>(ADMIN, 'ci_create_location', [2, 'EDIT-IMM', 'IMM receipt edit'], ['smallint', 'text', 'text']);
    const vendor = await rpc<string>(ADMIN, 'ci_create_vendor', [{ vendorCode: 'EDIT-V', name: 'Receipt edit vendor' }], ['jsonb']);
    const invoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'EDIT-INV-1', invoice_date: '2026-09-29', po_number: 'PO-OLD', lines: [{ product_id: product, quantity: 20 }, { product_id: secondProduct, quantity: 20 }] }], ['jsonb']);
    const invoiceLines = await asUser(ADMIN, client => client.query<{ id: string; product_id: string }>('select id,product_id from public.ci_invoice_lines where invoice_id=$1 order by line_number', [invoice]));
    const firstLine = invoiceLines.rows.find(line => line.product_id === product)!.id;
    const secondLine = invoiceLines.rows.find(line => line.product_id === secondProduct)!.id;
    const assessment = { correct_product: true, correct_quantity: true, packaging_ok: true, temperature_required: false, temperature_ok: null, shelf_life_ok: null, documentation_complete: true, has_complaint: false, delivery_discrepancy: false, reason_codes: [], other_reason_detail: null, notes: null };
    await rpc(ADMIN, 'ci_confirm_receipt_assessed', [invoice, [{ invoice_line_id: firstLine, quantity: 10, lot_number: 'EDIT-LOT-A', expiry_date: '2027-12-31', location_id: locationA }], 'receipt-edit-initial', assessment], ['uuid', 'jsonb', 'text', 'jsonb']);
    const receiptRow = await asUser(ADMIN, client => client.query<{ id: string; transaction_id: string; line_id: string; lot_id: string }>("select r.id,tx.id transaction_id,rl.id line_id,rl.lot_id from public.ci_receipts r join public.ci_stock_transactions tx on tx.receipt_id=r.id and tx.kind='receive' join public.ci_receipt_lines rl on rl.receipt_id=r.id where r.invoice_id=$1", [invoice]));
    const receipt = receiptRow.rows[0];

    await t.test('staff cannot edit and supervisor can edit the existing receipt', async () => {
      const data = { invoice: { invoice_number: 'EDIT-INV-2', invoice_date: '2026-09-28', po_number: 'PO-NEW' }, lines: [{ receipt_line_id: receipt.line_id, invoice_line_id: firstLine, quantity: 12, lot_number: 'EDIT-LOT-B', expiry_date: '2028-01-31', location_id: locationB }], assessment };
      await assert.rejects(rpc(STAFF, 'ci_edit_receipt', [receipt.id, data], ['uuid', 'jsonb']), /CI_ACCESS_DENIED/);
      await rpc(SUPERVISOR, 'ci_edit_receipt', [receipt.id, data], ['uuid', 'jsonb']);
      const state = await asUser(SUPERVISOR, client => client.query<{ invoice_number: string; invoice_date: string; po_number: string | null; quantity: string; lot_number: string; expiry_date: string; location_id: string; received_quantity: string }>("select i.invoice_number,i.invoice_date::text,i.po_number,rl.quantity::text,lot.lot_number,lot.expiry_date::text,rl.location_id,pr.received_quantity::text from public.ci_receipts r join public.ci_invoices i on i.id=r.invoice_id join public.ci_receipt_lines rl on rl.receipt_id=r.id join public.ci_stock_lots lot on lot.id=rl.lot_id join public.ci_invoice_line_progress pr on pr.invoice_line_id=rl.invoice_line_id where r.id=$1", [receipt.id]));
      assert.deepEqual(state.rows[0], { invoice_number: 'EDIT-INV-2', invoice_date: '2026-09-28', po_number: 'PO-NEW', quantity: '12.000', lot_number: 'EDIT-LOT-B', expiry_date: '2028-01-31', location_id: locationB, received_quantity: '12.000' });
      const oldLotBalance = await asUser(SUPERVISOR, client => client.query("select coalesce(sum(balance),0)::text balance from public.ci_stock_balances where lot_number='EDIT-LOT-A'"));
      const newLotBalance = await asUser(SUPERVISOR, client => client.query("select coalesce(sum(balance),0)::text balance from public.ci_stock_balances where lot_number='EDIT-LOT-B' and location_id=$1", [locationB]));
      assert.equal(oldLotBalance.rows[0].balance, '0');
      assert.equal(Number(newLotBalance.rows[0].balance), 12);
      const identity = await asUser(SUPERVISOR, client => client.query('select count(*)::int receipts,(select count(*)::int from public.ci_stock_transactions where receipt_id=$1 and kind=\'receive\') receives,(select count(*)::int from public.ci_stock_transactions where source_transaction_id=$2) reversals from public.ci_receipts where id=$1', [receipt.id, receipt.transaction_id]));
      assert.deepEqual(identity.rows[0], { receipts: 1, receives: 1, reversals: 0 });
    });

    await t.test('changing invoice line/product, quantity, LOT, and location moves the original stock entry and supports adding/removing lines', async () => {
      await assert.rejects(rpc(ADMIN, 'ci_edit_receipt', [receipt.id, { invoice: null, lines: [{ receipt_line_id: receipt.line_id, invoice_line_id: secondLine, quantity: 21, lot_number: 'EDIT-LOT-B', expiry_date: '2028-01-31', location_id: locationA }], assessment }], ['uuid', 'jsonb']), /CI_RECEIPT_EDIT_EXCEEDS_INVOICE/);
      await rpc(ADMIN, 'ci_edit_receipt', [receipt.id, { invoice: null, lines: [
        { receipt_line_id: receipt.line_id, invoice_line_id: secondLine, quantity: 8, lot_number: 'EDIT-LOT-B', expiry_date: '2028-01-31', location_id: locationA },
        { invoice_line_id: secondLine, quantity: 2, lot_number: 'EDIT-LOT-C', expiry_date: '2028-03-31', location_id: locationB },
      ], assessment }], ['uuid', 'jsonb']);
      const balances = await asUser(ADMIN, client => client.query<{ product_id: string; balance: string }>('select product_id,sum(balance)::text balance from public.ci_stock_balances where lot_number=\'EDIT-LOT-B\' group by product_id order by product_id'));
      assert.deepEqual(balances.rows.map(row => [row.product_id, Number(row.balance)]), [[secondProduct, 8]]);
      const progress = await asUser(ADMIN, client => client.query<{ product_id: string; received_quantity: string }>('select product_id,received_quantity::text from public.ci_invoice_line_progress where invoice_id=$1 order by product_id', [invoice]));
      assert.deepEqual(Object.fromEntries(progress.rows.map(row => [row.product_id, Number(row.received_quantity)])), { [product]: 0, [secondProduct]: 10 });
      await rpc(ADMIN, 'ci_edit_receipt', [receipt.id, { invoice: null, lines: [{ receipt_line_id: receipt.line_id, invoice_line_id: secondLine, quantity: 8, lot_number: 'EDIT-LOT-B', expiry_date: '2028-02-29', location_id: locationA }], assessment }], ['uuid', 'jsonb']);
      const afterDelete = await asUser(ADMIN, client => client.query<{ lines: number; lot_expiry: string; remaining_line_balance: string; removed_lot_balance: string }>("select count(*)::int lines,(select expiry_date::text from public.ci_stock_lots where product_id=$3 and lot_number='EDIT-LOT-B') lot_expiry,(select coalesce(sum(balance),0)::text from public.ci_stock_balances where product_id=$3 and lot_number='EDIT-LOT-B' and location_id=$2) remaining_line_balance,(select coalesce(sum(balance),0)::text from public.ci_stock_balances where lot_number='EDIT-LOT-C') removed_lot_balance from public.ci_receipt_lines where receipt_id=$1", [receipt.id, locationA, secondProduct]));
      assert.deepEqual(afterDelete.rows[0], { lines: 1, lot_expiry: '2028-02-29', remaining_line_balance: '8.000', removed_lot_balance: '0' });
    });

    await t.test('issue, transfer and adjustment continue to use the edited LOT, and an unsafe reduction is atomic', async () => {
      const lot = await asUser(ADMIN, client => client.query<{ id: string }>("select id from public.ci_stock_lots where product_id=$1 and lot_number='EDIT-LOT-B'", [secondProduct]));
      await rpc(ADMIN, 'ci_transfer_stock', [{ lot_id: lot.rows[0].id, from_location_id: locationA, to_location_id: locationB, quantity: 2, idempotency_key: 'receipt-edit-transfer' }], ['jsonb']);
      await rpc(ADMIN, 'ci_issue_stock', [{ product_id: secondProduct, lot_id: lot.rows[0].id, location_id: locationA, quantity: 5, purpose: 'Routine', idempotency_key: 'receipt-edit-issue' }], ['jsonb']);
      await assert.rejects(rpc(ADMIN, 'ci_edit_receipt', [receipt.id, { invoice: null, lines: [{ receipt_line_id: receipt.line_id, invoice_line_id: secondLine, quantity: 1, lot_number: 'EDIT-LOT-B', expiry_date: '2028-02-29', location_id: locationA }], assessment }], ['uuid', 'jsonb']), /CI_RECEIPT_EDIT_STOCK_NEGATIVE/);
      const unchanged = await asUser(ADMIN, client => client.query<{ quantity: string; balance: string }>("select rl.quantity::text,(select sum(balance)::text from public.ci_stock_balances where lot_number='EDIT-LOT-B' and location_id=$2) balance from public.ci_receipt_lines rl where rl.id=$1", [receipt.line_id, locationA]));
      assert.deepEqual(unchanged.rows[0], { quantity: '8.000', balance: '1.000' });
      await rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lot.rows[0].id, location_id: locationA, quantity_delta: 1, reason: null, idempotency_key: 'receipt-edit-adjustment' }], ['jsonb']);
      const afterAdjustment = await asUser(ADMIN, client => client.query<{ balance: string }>("select sum(balance)::text balance from public.ci_stock_balances where product_id=$1 and lot_id=$2", [secondProduct, lot.rows[0].id]));
      assert.equal(Number(afterAdjustment.rows[0].balance), 4);
    });

    await t.test('assessment edits keep the existing revision history and closure rules reopen receiving capacity', async () => {
      const changedAssessment = { ...assessment, correct_product: false, delivery_discrepancy: true, reason_codes: ['approved_exception'], notes: 'ตรวจพบและแก้ข้อมูลรับเข้า' };
      await rpc(ADMIN, 'ci_edit_receipt', [receipt.id, { invoice: null, lines: [{ receipt_line_id: receipt.line_id, invoice_line_id: secondLine, quantity: 8, lot_number: 'EDIT-LOT-B', expiry_date: '2028-02-29', location_id: locationA }], assessment: changedAssessment }], ['uuid', 'jsonb']);
      const revision = await asUser(ADMIN, client => client.query<{ n: number }>('select count(*)::int n from public.ci_receipt_assessment_revisions rev join public.ci_receipt_assessments a on a.id=rev.assessment_id where a.receipt_id=$1', [receipt.id]));
      assert.equal(revision.rows[0].n, 1);

      const closedInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'EDIT-CLOSED-INV', invoice_date: '2026-09-29', po_number: null, lines: [{ product_id: product, quantity: 10 }] }], ['jsonb']);
      const closedLine = await asUser(ADMIN, client => client.query<{ id: string }>('select id from public.ci_invoice_lines where invoice_id=$1', [closedInvoice]));
      await rpc(ADMIN, 'ci_confirm_receipt_assessed', [closedInvoice, [{ invoice_line_id: closedLine.rows[0].id, quantity: 10, lot_number: 'EDIT-CLOSED-LOT', expiry_date: '2028-12-31', location_id: locationA }], 'receipt-edit-closed', assessment], ['uuid', 'jsonb', 'text', 'jsonb']);
      const closedReceipt = await asUser(ADMIN, client => client.query<{ id: string; line_id: string }>('select r.id,rl.id line_id from public.ci_receipts r join public.ci_receipt_lines rl on rl.receipt_id=r.id where r.invoice_id=$1', [closedInvoice]));
      const statusBefore = await asUser(ADMIN, client => client.query<{ status: string }>('select status from public.ci_invoices where id=$1', [closedInvoice]));
      assert.equal(statusBefore.rows[0].status, 'closed');
      await rpc(ADMIN, 'ci_edit_receipt', [closedReceipt.rows[0].id, { invoice: null, lines: [{ receipt_line_id: closedReceipt.rows[0].line_id, invoice_line_id: closedLine.rows[0].id, quantity: 8, lot_number: 'EDIT-CLOSED-LOT', expiry_date: '2028-12-31', location_id: locationA }], assessment }], ['uuid', 'jsonb']);
      const reopened = await asUser(ADMIN, client => client.query<{ status: string; remaining: string }>('select i.status,pr.remaining_quantity::text remaining from public.ci_invoices i join public.ci_invoice_line_progress pr on pr.invoice_id=i.id where i.id=$1', [closedInvoice]));
      assert.deepEqual(reopened.rows[0], { status: 'open', remaining: '2.000' });
      await rpc(ADMIN, 'ci_confirm_receipt_assessed', [closedInvoice, [{ invoice_line_id: closedLine.rows[0].id, quantity: 2, lot_number: 'EDIT-CLOSED-LOT', expiry_date: '2028-12-31', location_id: locationA }], 'receipt-edit-finish', assessment], ['uuid', 'jsonb', 'text', 'jsonb']);
      const completed = await asUser(ADMIN, client => client.query<{ status: string; remaining: string }>('select i.status,pr.remaining_quantity::text remaining from public.ci_invoices i join public.ci_invoice_line_progress pr on pr.invoice_id=i.id where i.id=$1', [closedInvoice]));
      assert.deepEqual(completed.rows[0], { status: 'closed', remaining: '0.000' });
    });

    await t.test('shared Invoice metadata needs Admin or Supervisor in every warehouse, but local receipt edits remain available', async () => {
      const mixedInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'EDIT-MIXED-INV', invoice_date: '2026-09-29', po_number: 'MIX-PO', lines: [{ product_id: product, quantity: 4 }, { product_id: immProduct, quantity: 3 }] }], ['jsonb']);
      const mixedLines = await asUser(ADMIN, client => client.query<{ id: string; warehouse_id: number; product_id: string }>('select id,warehouse_id,product_id from public.ci_invoice_lines where invoice_id=$1 order by warehouse_id', [mixedInvoice]));
      await rpc(ADMIN, 'ci_confirm_receipt_assessed', [mixedInvoice, mixedLines.rows.map(line => ({ invoice_line_id: line.id, quantity: line.warehouse_id === 1 ? 4 : 3, lot_number: 'MIX-' + line.warehouse_id, expiry_date: '2028-12-31', location_id: line.warehouse_id === 1 ? locationA : immLocation })), 'receipt-edit-mixed', assessment], ['uuid', 'jsonb', 'text', 'jsonb']);
      const cheReceipt = await asUser(ADMIN, client => client.query<{ id: string; line_id: string; invoice_line_id: string }>("select r.id,rl.id line_id,rl.invoice_line_id from public.ci_receipts r join public.ci_receipt_lines rl on rl.receipt_id=r.id where r.invoice_id=$1 and r.warehouse_id=1", [mixedInvoice]));
      await assert.rejects(rpc(SUPERVISOR, 'ci_edit_receipt', [cheReceipt.rows[0].id, { invoice: { invoice_number: 'EDIT-MIXED-NEW', invoice_date: '2026-09-29', po_number: 'MIX-PO' }, lines: [{ receipt_line_id: cheReceipt.rows[0].line_id, invoice_line_id: cheReceipt.rows[0].invoice_line_id, quantity: 3, lot_number: 'MIX-1', expiry_date: '2028-12-31', location_id: locationA }], assessment }], ['uuid', 'jsonb']), /CI_ACCESS_DENIED/);
      await rpc(SUPERVISOR, 'ci_edit_receipt', [cheReceipt.rows[0].id, { invoice: null, lines: [{ receipt_line_id: cheReceipt.rows[0].line_id, invoice_line_id: cheReceipt.rows[0].invoice_line_id, quantity: 3, lot_number: 'MIX-1', expiry_date: '2028-12-31', location_id: locationA }], assessment }], ['uuid', 'jsonb']);
      const invoiceHeader = await asUser(ADMIN, client => client.query<{ invoice_number: string }>('select invoice_number from public.ci_invoices where id=$1', [mixedInvoice]));
      assert.equal(invoiceHeader.rows[0].invoice_number, 'EDIT-MIXED-INV');
    });

    await t.test('reversed receipts cannot be edited and their quantities stay out of Invoice progress', async () => {
      const reversedInvoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: 'EDIT-REVERSED-INV', invoice_date: '2026-09-29', po_number: null, lines: [{ product_id: product, quantity: 5 }] }], ['jsonb']);
      const reversedLine = await asUser(ADMIN, client => client.query<{ id: string }>('select id from public.ci_invoice_lines where invoice_id=$1', [reversedInvoice]));
      await rpc(ADMIN, 'ci_confirm_receipt_assessed', [reversedInvoice, [{ invoice_line_id: reversedLine.rows[0].id, quantity: 5, lot_number: 'EDIT-REVERSED-LOT', expiry_date: '2028-12-31', location_id: locationA }], 'receipt-edit-reversed', assessment], ['uuid', 'jsonb', 'text', 'jsonb']);
      const reversedReceipt = await asUser(ADMIN, client => client.query<{ id: string; line_id: string; transaction_id: string }>("select r.id,rl.id line_id,tx.id transaction_id from public.ci_receipts r join public.ci_receipt_lines rl on rl.receipt_id=r.id join public.ci_stock_transactions tx on tx.receipt_id=r.id and tx.kind='receive' where r.invoice_id=$1", [reversedInvoice]));
      await rpc(ADMIN, 'ci_reverse_transaction', [reversedReceipt.rows[0].transaction_id, 'Correct a duplicate test receipt', 'receipt-edit-reversed-key'], ['uuid', 'text', 'text']);
      await assert.rejects(rpc(ADMIN, 'ci_edit_receipt', [reversedReceipt.rows[0].id, { invoice: null, lines: [{ receipt_line_id: reversedReceipt.rows[0].line_id, invoice_line_id: reversedLine.rows[0].id, quantity: 4, lot_number: 'EDIT-REVERSED-LOT', expiry_date: '2028-12-31', location_id: locationA }], assessment }], ['uuid', 'jsonb']), /CI_RECEIPT_EDIT_REVERSED/);
      const remaining = await asUser(ADMIN, client => client.query<{ received: string; remaining: string; status: string }>('select pr.received_quantity::text received,pr.remaining_quantity::text remaining,i.status from public.ci_invoice_line_progress pr join public.ci_invoices i on i.id=pr.invoice_id where pr.invoice_id=$1', [reversedInvoice]));
      assert.deepEqual(remaining.rows[0], { received: '0.000', remaining: '5.000', status: 'open' });
    });
  } finally { await cleanup(); }
});
