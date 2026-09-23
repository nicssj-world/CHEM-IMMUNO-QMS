import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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
    const migrations = (await readdir(join(process.cwd(), 'supabase/migrations')))
      .filter((file) => file.endsWith('.sql')).sort()
      .map((file) => `supabase/migrations/${file}`);
    for (const file of ['tests/db/bootstrap.sql', ...migrations]) {
      await client.query(await readFile(join(process.cwd(), file), 'utf8'));
    }
  } finally { await client.end(); }
}

async function cleanupDatabase(): Promise<void> {
  const owner = new Client({ connectionString: adminUrl.toString() });
  await owner.connect();
  try { await owner.query(`drop database ${dbName} with (force)`); } finally { await owner.end(); }
}

test('exact workbook and owner resolution manifest stage and apply atomically in a fresh database',
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
      await client.query("insert into public.ci_user_profiles(user_id,ephis_id,display_name) values ($1,'ci-import-admin','Import Admin'),($2,'ci-import-staff','Import Staff')", [adminId, staffId]);
      await client.query("insert into public.ci_user_access(user_id,warehouse_id,role) values ($1,1,'admin'),($1,2,'admin'),($2,1,'staff')", [adminId, staffId]);
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
      const stagingCounts = await client.query<{ products: string; reviews: string; used_with: string; resolutions: string; critical_open: string }>(
        `select (select count(*) from public.ci_import_rows where batch_id=$1)::text as products,
          (select count(*) from public.ci_import_review_items where batch_id=$1)::text as reviews,
          (select count(*) from public.ci_import_review_items where batch_id=$1 and kind='used_with')::text as used_with,
          (select count(*) from public.ci_import_review_resolutions where batch_id=$1)::text as resolutions,
          (select count(*) from public.ci_import_review_items where batch_id=$1 and critical and status='open')::text as critical_open`,
        [batchId],
      );
      assert.deepEqual(stagingCounts.rows[0], {
        products: '162', reviews: '20', used_with: '12', resolutions: '20', critical_open: '0',
      });
      await client.query('savepoint staff_resolution_visibility');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [staffId]);
      const staffVisible = await client.query<{ visible: string; immunology: string }>(
        `select count(*)::text as visible,
          count(*) filter(where warehouse_id=2)::text as immunology
         from public.ci_import_review_resolutions where batch_id=$1`, [batchId],
      );
      assert.deepEqual(staffVisible.rows[0], { visible: '10', immunology: '0' });
      await client.query('rollback to savepoint staff_resolution_visibility');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [adminId]);
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
        products: '162', identifiers: '353', relations: '100', platforms: '28',
        che_last: 'CHE-0090', imm_last: 'IMM-0072',
      });
      const warehouseCounts = await client.query<{ code: string; products: string }>(
        `select w.code,count(p.id)::text as products from public.ci_warehouses w
         left join public.ci_products p on p.warehouse_id=w.id group by w.code order by w.code`,
      );
      assert.deepEqual(warehouseCounts.rows, [
        { code: 'CHE', products: '90' }, { code: 'IMM', products: '72' },
      ]);
      const status = await client.query<{ status: string; open: string }>(
        `select b.status, (select count(*) from public.ci_import_review_items r
          where r.batch_id=b.id and r.status='open')::text as open
         from public.ci_import_batches b where b.id=$1`, [batchId]);
      assert.deepEqual(status.rows[0], { status: 'applied', open: '0' });

      const types = await client.query<{ type: string; active_count: string; source_count: string }>(
        `select t.type,
          (select count(*) from public.ci_products p where p.product_type=t.type)::text as active_count,
          (select count(*) from public.ci_import_rows r where r.batch_id=$1 and r.normalized->>'source_product_type'=t.type)::text as source_count
         from unnest(array['reagent','calibrator','control','consumable']::text[]) t(type) order by t.type`,
        [batchId],
      );
      assert.deepEqual(types.rows, [
        { type: 'calibrator', active_count: '34', source_count: '32' },
        { type: 'consumable', active_count: '33', source_count: '35' },
        { type: 'control', active_count: '23', source_count: '23' },
        { type: 'reagent', active_count: '72', source_count: '72' },
      ]);
      const standardTypeOverrides = await client.query<{ ref: string; active_type: string; source_type: string }>(
        `select i.value as ref,p.product_type as active_type,p.raw_source->>'type' as source_type
         from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id and i.kind='REF_CURRENT'
         where i.value in ('11183982216','11183974216') order by i.value`,
      );
      assert.deepEqual(standardTypeOverrides.rows, [
        { ref: '11183974216', active_type: 'calibrator', source_type: 'Consumable' },
        { ref: '11183982216', active_type: 'calibrator', source_type: 'Consumable' },
      ]);

      const identifierCounts = await client.query<{ current_refs: string; barcode: string; legacy: string; current_leading_zero: string }>(
        `select
          count(*) filter(where kind='REF_CURRENT')::text as current_refs,
          count(*) filter(where kind='MANUFACTURER_BARCODE')::text as barcode,
          count(*) filter(where kind='REF_LEGACY')::text as legacy,
          count(*) filter(where kind='REF_CURRENT' and value like '0%')::text as current_leading_zero
         from public.ci_product_identifiers`,
      );
      assert.deepEqual(identifierCounts.rows[0], { current_refs: '162', barcode: '162', legacy: '29', current_leading_zero: '138' });
      const legacyOwnership = await client.query<{ mismatches: string }>(
        `select count(*)::text as mismatches from public.ci_product_identifiers legacy
         where legacy.kind='REF_LEGACY' and not exists (
           select 1 from public.ci_product_identifiers current
           where current.product_id=legacy.product_id and current.kind='REF_CURRENT')`,
      );
      assert.equal(legacyOwnership.rows[0].mismatches, '0');

      const correctedPacking = await client.query<{ ref: string; current_value: string; source_value: string | null }>(
        `select i.value as ref,p.packing_size_raw as current_value,p.raw_source->>'packing_size' as source_value
         from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id and i.kind='REF_CURRENT'
         where i.value=any($1::text[]) order by i.value`,
        [['03375790190','04740955001','08335923190','09762582190']],
      );
      assert.deepEqual(correctedPacking.rows, [
        { ref: '03375790190', current_value: '6 x 5 mL calibrator + 1 x 10 mL diluent', source_value: null },
        { ref: '04740955001', current_value: '2 x 1000 pcs', source_value: null },
        { ref: '08335923190', current_value: '10 x 1.0 mL, 5 x 2.0 mL', source_value: '10  x  1.0  mL,  5  x  2.0  m' },
        { ref: '09762582190', current_value: '2 x 22 mL', source_value: null },
      ]);

      const reactionPlatforms = await client.query<{ platform_key: string; source_text: string }>(
        `select platform.platform_key,pp.source_text from public.ci_product_platforms pp
         join public.ci_platforms platform on platform.id=pp.platform_id
         join public.ci_product_identifiers i on i.product_id=pp.product_id and i.kind='REF_CURRENT'
         where i.value='07700814001' order by platform.platform_key`,
      );
      assert.deepEqual(reactionPlatforms.rows, [
        { platform_key: 'c503', source_text: 'cobas pro c503 / c703 / ISE' },
        { platform_key: 'c513', source_text: 'cobas pro c503 / c703 / ISE' },
      ]);
      const ownerRelations = await client.query<{
        source_ref: string; target_ref: string; relation_type: string; review_id: string;
      }>(
        `select source.value as source_ref,target.value as target_ref,r.relation_type,r.source_review_id as review_id
         from public.ci_product_relations r
         join public.ci_product_identifiers source on source.product_id=r.source_product_id and source.kind='REF_CURRENT'
         join public.ci_product_identifiers target on target.product_id=r.target_product_id and target.kind='REF_CURRENT'
         where r.source_kind='owner-approved' order by r.source_review_id`,
      );
      assert.deepEqual(ownerRelations.rows, [
        { source_ref: '09529713190', target_ref: '08463107190', relation_type: 'uses_consumable', review_id: 'REL-01' },
        { source_ref: '08056722190', target_ref: '08059322190', relation_type: 'uses_consumable', review_id: 'REL-02' },
        { source_ref: '09315284214', target_ref: '09315314190', relation_type: 'uses_calibrator', review_id: 'REL-05' },
        { source_ref: '09315357190', target_ref: '09315373190', relation_type: 'uses_calibrator', review_id: 'REL-06' },
        { source_ref: '09043284214', target_ref: '09043292190', relation_type: 'uses_calibrator', review_id: 'REL-07' },
        { source_ref: '09315284214', target_ref: '07299001190', relation_type: 'uses_consumable', review_id: 'REL-08' },
        { source_ref: '09315357190', target_ref: '07299010190', relation_type: 'uses_consumable', review_id: 'REL-09' },
        { source_ref: '07027699214', target_ref: '09762582190', relation_type: 'uses_consumable', review_id: 'REL-10' },
        { source_ref: '09315284214', target_ref: '04917049190', relation_type: 'uses_control', review_id: 'REL-11' },
        { source_ref: '09315357190', target_ref: '05095107190', relation_type: 'uses_control', review_id: 'REL-12' },
      ]);
      const c513Exists = await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_platforms where warehouse_id=1 and platform_key='c513'`,
      );
      assert.equal(c513Exists.rows[0].count, '1');
      const progesteroneRelation = await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_product_relations r
         join public.ci_product_identifiers source on source.product_id=r.source_product_id and source.kind='REF_CURRENT'
         join public.ci_product_identifiers target on target.product_id=r.target_product_id and target.kind='REF_CURRENT'
         where source.value='07027699214' and target.value='09762582190' and r.relation_type='uses_consumable'`,
      );
      assert.equal(progesteroneRelation.rows[0].count, '1');
      const unassignedRelations = await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_product_relations r
         join public.ci_product_identifiers i on i.product_id in (r.source_product_id,r.target_product_id) and i.kind='REF_CURRENT'
         where i.value in ('07361939001','04740955001')`,
      );
      assert.equal(unassignedRelations.rows[0].count, '0');
      const unassignedReviewStatus = await client.query<{ review_id: string; status: string; critical: boolean }>(
        `select review_id,status,critical from public.ci_import_review_items
         where batch_id=$1 and review_id in ('REL-03','REL-04') order by review_id`, [batchId],
      );
      assert.deepEqual(unassignedReviewStatus.rows, [
        { review_id: 'REL-03', status: 'accepted_unlinked', critical: true },
        { review_id: 'REL-04', status: 'accepted_unlinked', critical: true },
      ]);
      const manifestRecords = await client.query<{ count: string; actors: string; timestamps: string; audited: string }>(
        `select count(*)::text as count,count(*) filter(where recorded_by=$2)::text as actors,
          count(*) filter(where recorded_at is not null)::text as timestamps,
          (select count(*) from public.ci_audit_logs a where a.entity_table='ci_import_review_resolutions'
            and a.action='OWNER_APPROVED_RESOLUTION')::text as audited
         from public.ci_import_review_resolutions where batch_id=$1`,
        [batchId, adminId],
      );
      assert.deepEqual(manifestRecords.rows[0], { count: '20', actors: '20', timestamps: '20', audited: '20' });
      await client.query('savepoint immutable_resolution');
      await client.query('reset role');
      await assert.rejects(
        client.query("update public.ci_import_review_resolutions set resolution_note='edited' where batch_id=$1", [batchId]),
        /CI_IMPORT_RESOLUTION_IMMUTABLE/,
      );
      await client.query('rollback to savepoint immutable_resolution');
      await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [adminId]);
      } finally {
        await client.query('rollback');
        await client.end();
      }
    } finally {
      await cleanupDatabase();
    }
  });
