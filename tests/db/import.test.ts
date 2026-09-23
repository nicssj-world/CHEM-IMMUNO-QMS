import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import { APPROVED_WORKBOOK_FILENAME, previewApprovedWorkbook } from '../../src/lib/import/approved-workbook';

const configuredDatabaseUrl = process.env.CI_TEST_DATABASE_URL;
if (!configuredDatabaseUrl) {
  throw new Error('Set CI_TEST_DATABASE_URL with scripts/db/test.ps1 to run disposable PostgreSQL tests');
}
const adminUrl = new URL(configuredDatabaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to the disposable loopback PostgreSQL postgres database');
}
const dbName = `ci_import_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const adminId = '90274914-1058-476f-88c6-b74bbc6cc710';
const staffId = '90274914-1058-476f-88c6-b74bbc6cc711';

async function setupDatabase(): Promise<void> {
  const owner = new Client({ connectionString: adminUrl.toString() });
  await owner.connect();
  try { await owner.query(`create database ${dbName}`); } finally { await owner.end(); }
  const client = new Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    for (const file of [
      'tests/db/bootstrap.sql',
      'supabase/migrations/202609230001_ci_phase1_schema.sql',
      'supabase/migrations/202609230002_ci_phase1_rpcs.sql',
      'supabase/migrations/202609230003_ci_phase1_import.sql',
      'supabase/migrations/20260923105045_ci_phase1_correctness.sql',
    ]) {
      await client.query(await readFile(join(process.cwd(), file), 'utf8'));
    }
  } finally { await client.end(); }
}

async function cleanupDatabase(): Promise<void> {
  const owner = new Client({ connectionString: adminUrl.toString() });
  await owner.connect();
  try { await owner.query(`drop database ${dbName} with (force)`); } finally { await owner.end(); }
}

test('exact workbook stages, blocks open reviews, and applies atomically after explicit local-only decisions',
  { timeout: 120000 },
  async () => {
    const bytes = await readFile(join(process.cwd(), 'tests/import/fixtures', APPROVED_WORKBOOK_FILENAME));
    const { payload } = await previewApprovedWorkbook(bytes);
    await setupDatabase();
    try {
      const client = new Client({ connectionString: testUrl.toString() });
      await client.connect();
      try {
      await client.query('begin');
      await client.query('insert into auth.users(id) values ($1),($2)', [adminId, staffId]);
      await client.query("insert into public.ci_user_profiles(user_id,ephis_id) values ($1,'ci-import-admin'),($2,'ci-import-staff')", [adminId, staffId]);
      await client.query("insert into public.ci_user_access(user_id,warehouse_id,role) values ($1,1,'admin'),($1,2,'admin'),($2,1,'staff'),($2,2,'staff')", [adminId, staffId]);
      await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [staffId]);
      await client.query('savepoint staff_attempt');
      await assert.rejects(
        client.query('select public.ci_stage_import_batch($1::jsonb)', [JSON.stringify(payload)]),
        /CI_ROLE_FORBIDDEN|CI_ACCESS_DENIED|CI_ROLE_REQUIRED/,
      );
      await client.query('rollback to savepoint staff_attempt');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [adminId]);

      const altered = structuredClone(payload);
      altered.products[0].source_name = 'Unapproved source name';
      await client.query('savepoint altered_payload');
      await assert.rejects(
        client.query('select public.ci_stage_import_batch($1::jsonb)', [JSON.stringify(altered)]),
        /CI_IMPORT_PAYLOAD_FINGERPRINT_MISMATCH/,
      );
      await client.query('rollback to savepoint altered_payload');

      const staged = await client.query<{ batch_id: string }>(
        'select public.ci_stage_import_batch($1::jsonb) as batch_id', [JSON.stringify(payload)],
      );
      const batchId = staged.rows[0].batch_id;
      assert.match(batchId, /^[0-9a-f-]{36}$/);
      const stagingCounts = await client.query<{ products: string; reviews: string; used_with: string }>(
        `select (select count(*) from public.ci_import_rows where batch_id=$1)::text as products,
          (select count(*) from public.ci_import_review_items where batch_id=$1)::text as reviews,
          (select count(*) from public.ci_import_review_items where batch_id=$1 and kind='used_with')::text as used_with`,
        [batchId],
      );
      assert.deepEqual(stagingCounts.rows[0], { products: '162', reviews: '20', used_with: '12' });
      await client.query('savepoint premature_apply');
      await assert.rejects(client.query('select public.ci_apply_import_batch($1)', [batchId]), /CI_IMPORT_CRITICAL_REVIEW_OPEN/);
      await client.query('rollback to savepoint premature_apply');
      const beforeApply = await client.query<{ count: string }>('select count(*)::text as count from public.ci_products');
      assert.equal(beforeApply.rows[0].count, '0');

      const reviewRows = await client.query<{
        id: string; kind: string; source_sheet: string; source_row: number;
      }>('select id,kind,source_sheet,source_row from public.ci_import_review_items where batch_id=$1 order by source_sheet,source_row', [batchId]);
      for (const row of reviewRows.rows) {
        // These are synthetic choices inside a rollback-only disposable test.
        // They do not approve a clinical relationship in the real import.
        let status = row.kind === 'used_with' ? 'accepted_unlinked' : 'accepted_source';
        let data: Record<string, unknown> = {};
        if (row.source_sheet === 'FOC item_chem c503 c703 ISE' && row.source_row === 16 && row.kind === 'used_with') {
          status = 'approved_mapping';
          data = { target_ref_currents: ['08056692190'], relation_type: 'uses_consumable' };
        }
        if (row.source_sheet === 'FOC item_chem c503 c703 ISE' && row.source_row === 41 && row.kind === 'used_with') {
          status = 'approved_mapping';
          data = { platform_key: 'c503_c703_ise' };
        }
        await client.query('select public.ci_resolve_import_review($1,$2,$3,$4::jsonb)',
          [row.id, status, 'Disposable import test decision only', JSON.stringify(data)]);
      }
      const applied = await client.query<{ result: { products: number } }>(
        'select public.ci_apply_import_batch($1) as result', [batchId],
      );
      assert.equal(applied.rows[0].result.products, 162);
      const counts = await client.query<{
        products: string; identifiers: string; relations: string; platforms: string; che_last: string; imm_last: string;
      }>(`select
        (select count(*) from public.ci_products)::text as products,
        (select count(*) from public.ci_product_identifiers)::text as identifiers,
        (select count(*) from public.ci_product_relations)::text as relations,
        (select count(*) from public.ci_product_platforms)::text as platforms,
        (select max(product_code) from public.ci_products where warehouse_id=1) as che_last,
        (select max(product_code) from public.ci_products where warehouse_id=2) as imm_last`);
      assert.deepEqual(counts.rows[0], {
        products: '162', identifiers: '353', relations: '91', platforms: '28',
        che_last: 'CHE-0090', imm_last: 'IMM-0072',
      });
      const status = await client.query<{ status: string; open: string }>(
        `select b.status, (select count(*) from public.ci_import_review_items r
          where r.batch_id=b.id and r.status='open')::text as open
         from public.ci_import_batches b where b.id=$1`, [batchId]);
      assert.deepEqual(status.rows[0], { status: 'applied', open: '0' });
      } finally {
        await client.query('rollback');
        await client.end();
      }
    } finally {
      await cleanupDatabase();
    }
  });
