import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import { APPROVED_WORKBOOK_FILENAME, previewApprovedWorkbook } from '../../src/lib/import/approved-workbook';
import { classifyIncrementalImport, parseIncrementalWorkbook, type IncrementalMaster } from '../../src/lib/import/incremental';

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
      let batchId = staged.rows[0].batch_id;
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

      const productMasterSnapshot = async () => (await client.query<{
        products: string; identifiers: string; relations: string; platforms: string;
        product_state: string; identifier_state: string; relation_state: string; platform_state: string;
      }>(`select
        (select count(*)::text from public.ci_products) as products,
        (select count(*)::text from public.ci_product_identifiers) as identifiers,
        (select count(*)::text from public.ci_product_relations) as relations,
        (select count(*)::text from public.ci_product_platforms) as platforms,
        (select md5(coalesce(string_agg(to_jsonb(p)::text, E'\\n' order by p.id),'')) from public.ci_products p) as product_state,
        (select md5(coalesce(string_agg(to_jsonb(i)::text, E'\\n' order by i.id),'')) from public.ci_product_identifiers i) as identifier_state,
        (select md5(coalesce(string_agg(to_jsonb(r)::text, E'\\n' order by r.id),'')) from public.ci_product_relations r) as relation_state,
        (select md5(coalesce(string_agg(to_jsonb(pp)::text, E'\\n' order by pp.id),'')) from public.ci_product_platforms pp) as platform_state`)).rows[0];
      const initialMasterBeforeCancel = await productMasterSnapshot();
      await client.query('select public.ci_cancel_import_batch($1::uuid)', [batchId]);
      const cancelledInitialRows = await client.query<{ batches: string; products: string; reviews: string; resolutions: string }>(
        `select
          (select count(*)::text from public.ci_import_batches where id=$1) as batches,
          (select count(*)::text from public.ci_import_rows where batch_id=$1) as products,
          (select count(*)::text from public.ci_import_review_items where batch_id=$1) as reviews,
          (select count(*)::text from public.ci_import_review_resolutions where batch_id=$1) as resolutions`,
        [batchId],
      );
      assert.deepEqual(cancelledInitialRows.rows[0], { batches: '0', products: '0', reviews: '0', resolutions: '0' });
      assert.deepEqual(await productMasterSnapshot(), initialMasterBeforeCancel);
      assert.equal((await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_audit_logs
         where entity_table='ci_import_batches' and entity_id=$1 and action='CANCEL'`, [batchId],
      )).rows[0].count, '2');
      batchId = (await client.query<{ batch_id: string }>(
        'select public.ci_stage_import_batch($1::jsonb) as batch_id', [JSON.stringify(payload)],
      )).rows[0].batch_id;
      await client.query('savepoint duplicate_initial_active_batch');
      await assert.rejects(
        client.query('select public.ci_stage_import_batch($1::jsonb)', [JSON.stringify(payload)]),
        /ci_import_batches_one_staged_idx/,
      );
      await client.query('rollback to savepoint duplicate_initial_active_batch');

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
      await client.query('savepoint applied_initial_cancel');
      await assert.rejects(
        client.query('select public.ci_cancel_import_batch($1::uuid)', [batchId]),
        /CI_IMPORT_NOT_CANCELLABLE/,
      );
      await client.query('rollback to savepoint applied_initial_cancel');
      assert.equal((await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_import_batches where status='staged'`,
      )).rows[0].count, '0');
      assert.equal((await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_import_batches where id=$1 and status='applied'`, [batchId],
      )).rows[0].count, '1');

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
      assert.deepEqual(manifestRecords.rows[0], { count: '20', actors: '20', timestamps: '20', audited: '40' });

      const loadIncrementalMaster = async (): Promise<IncrementalMaster> => {
        const products = await client.query<IncrementalMaster['products'][number]>(
          `select id,warehouse_id,product_code,product_type,source_name,display_name,packing_size_raw,source_sheet,source_row,raw_source
           from public.ci_products order by id`,
        );
        const identifiers = await client.query<IncrementalMaster['identifiers'][number]>(
          `select product_id,warehouse_id,kind,value,approved from public.ci_product_identifiers order by id`,
        );
        const relations = await client.query<IncrementalMaster['relations'][number]>(
          `select source_product_id,target_product_id,relation_type from public.ci_product_relations order by id`,
        );
        const platforms = await client.query<IncrementalMaster['platforms'][number]>(
          `select id,warehouse_id,platform_key,display_name from public.ci_platforms order by id`,
        );
        const productPlatforms = await client.query<IncrementalMaster['product_platforms'][number]>(
          `select product_id,platform_id from public.ci_product_platforms order by id`,
        );
        return {
          products: products.rows, identifiers: identifiers.rows, relations: relations.rows,
          platforms: platforms.rows, product_platforms: productPlatforms.rows,
        };
      };
      const stageIncremental = async (sourceFilename: string, sourceSha256: string, rows: ReturnType<typeof classifyIncrementalImport>) => {
        const staged = await client.query<{ batch_id: string }>(
          `select public.ci_stage_incremental_product_import($1::jsonb) as batch_id`,
          [JSON.stringify({ source_filename: sourceFilename, source_sha256: sourceSha256, rows })],
        );
        return staged.rows[0].batch_id;
      };
      const applyIncremental = async (id: string) => client.query<{ result: {
        new: number; existing: number; updated: number; conflict: number; duplicate_in_file: number;
      } }>('select public.ci_apply_incremental_product_import($1::uuid) as result', [id]);

      const incrementalFilename = 'Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx';
      const incrementalWorkbook = await parseIncrementalWorkbook(
        await readFile(join(process.cwd(), 'tests/import/fixtures', incrementalFilename)), incrementalFilename,
      );
      const acceptancePreview = classifyIncrementalImport(incrementalWorkbook.rows, await loadIncrementalMaster());
      assert.equal(acceptancePreview.length, 5);
      assert.deepEqual(acceptancePreview.map(row => row.classification), ['Existing','Existing','New','New','New']);
      assert.deepEqual(acceptancePreview.map(row => row.candidate.ref_current), [
        '07700814001','09796762001','08463115190','08463123190','04813707001',
      ]);
      let incrementalBatchId = await stageIncremental(incrementalFilename, incrementalWorkbook.source_sha256, acceptancePreview);
      const previewCounts = await client.query<{ disposition: string; count: string }>(
        `select disposition,count(*)::text as count from public.ci_incremental_product_import_rows
         where batch_id=$1 group by disposition order by disposition`, [incrementalBatchId],
      );
      assert.deepEqual(previewCounts.rows, [
        { disposition: 'Existing', count: '2' }, { disposition: 'New', count: '3' },
      ]);
      const incrementalMasterBeforeCancel = await productMasterSnapshot();
      await client.query('select public.ci_cancel_incremental_product_import($1::uuid)', [incrementalBatchId]);
      const cancelledIncrementalRows = await client.query<{ batches: string; rows: string; audit: string }>(
        `select
          (select count(*)::text from public.ci_incremental_product_import_batches where id=$1) as batches,
          (select count(*)::text from public.ci_incremental_product_import_rows where batch_id=$1) as rows,
          (select count(*)::text from public.ci_incremental_product_import_audit where import_batch_id=$1) as audit`,
        [incrementalBatchId],
      );
      assert.deepEqual(cancelledIncrementalRows.rows[0], { batches: '0', rows: '0', audit: '0' });
      assert.deepEqual(await productMasterSnapshot(), incrementalMasterBeforeCancel);
      assert.equal((await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_incremental_product_import_batches where status='preview'`,
      )).rows[0].count, '0');
      incrementalBatchId = await stageIncremental(incrementalFilename, incrementalWorkbook.source_sha256, acceptancePreview);
      await client.query('savepoint duplicate_incremental_active_batch');
      await assert.rejects(
        stageIncremental(incrementalFilename, incrementalWorkbook.source_sha256, acceptancePreview),
        /ci_incremental_import_batches_one_preview_idx/,
      );
      await client.query('rollback to savepoint duplicate_incremental_active_batch');
      const reactionsBefore = await client.query<{ id: string; product_code: string; ref: string; platform_key: string }>(
        `select p.id,p.product_code,i.value as ref,pl.platform_key
         from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id and i.kind='REF_CURRENT'
         left join public.ci_product_platforms pp on pp.product_id=p.id
         left join public.ci_platforms pl on pl.id=pp.platform_id
         where i.value in ('07700814001','09796762001') order by i.value,pl.platform_key`,
      );
      const appliedIncremental = await applyIncremental(incrementalBatchId);
      assert.deepEqual(appliedIncremental.rows[0].result, {
        new: 3, existing: 2, updated: 0, conflict: 0, duplicate_in_file: 0,
      });
      const initialAndIncrementalTotals = await client.query<{ products: string; identifiers: string }>(
        `select (select count(*)::text from public.ci_products) as products,
          (select count(*)::text from public.ci_product_identifiers) as identifiers`,
      );
      assert.deepEqual(initialAndIncrementalTotals.rows[0], { products: '165', identifiers: '359' });
      const reactionsAfter = await client.query<{ id: string; product_code: string; ref: string; platform_key: string }>(
        `select p.id,p.product_code,i.value as ref,pl.platform_key
         from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id and i.kind='REF_CURRENT'
         left join public.ci_product_platforms pp on pp.product_id=p.id
         left join public.ci_platforms pl on pl.id=pp.platform_id
         where i.value in ('07700814001','09796762001') order by i.value,pl.platform_key`,
      );
      assert.deepEqual(reactionsAfter.rows, reactionsBefore.rows);
      const newCatalogRows = await client.query<{ ref: string; product_code: string; product_type: string; packing_size_raw: string | null }>(
        `select i.value as ref,p.product_code,p.product_type,p.packing_size_raw
         from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id and i.kind='REF_CURRENT'
         where i.value=any($1::text[]) order by p.product_code`,
        [['08463115190','08463123190','04813707001']],
      );
      assert.deepEqual(newCatalogRows.rows, [
        { ref: '08463115190', product_code: 'CHE-0091', product_type: 'consumable', packing_size_raw: null },
        { ref: '08463123190', product_code: 'CHE-0092', product_type: 'consumable', packing_size_raw: null },
        { ref: '04813707001', product_code: 'CHE-0093', product_type: 'consumable', packing_size_raw: null },
      ]);
      await client.query('savepoint applied_incremental_cancel');
      await assert.rejects(
        client.query('select public.ci_cancel_incremental_product_import($1::uuid)', [incrementalBatchId]),
        /CI_INCREMENTAL_IMPORT_NOT_CANCELLABLE/,
      );
      await client.query('rollback to savepoint applied_incremental_cancel');
      assert.equal((await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_incremental_product_import_batches where status='preview'`,
      )).rows[0].count, '0');
      assert.equal((await client.query<{ count: string }>(
        `select count(*)::text as count from public.ci_incremental_product_import_batches where id=$1 and status='applied'`, [incrementalBatchId],
      )).rows[0].count, '1');

      let master = await loadIncrementalMaster();
      const platformProduct = master.products.find(product => master.identifiers.some(identifier =>
        identifier.product_id === product.id && identifier.kind === 'REF_CURRENT' && identifier.value === '07700814001'))!;
      const platformCandidate = {
        warehouse_code: 'CHE' as const, source_name: platformProduct.display_name, product_type: platformProduct.product_type,
        packing_size_raw: null, source_sheet: 'FOC item_chem c503 c703 ISE', source_row: 1001,
        raw_source: { test: 'platform replacement' }, ref_current: '07700814001',
        manufacturer_barcode: master.identifiers.find(item => item.product_id === platformProduct.id && item.kind === 'MANUFACTURER_BARCODE')!.value,
        replaces_ref: null, used_with: 'cobas pro c703',
      };
      const platformPreview = classifyIncrementalImport([platformCandidate], master);
      assert.equal(platformPreview[0].classification, 'Update');
      const platformBefore = await client.query<{ platform_keys: string[] }>(
        `select array_agg(pl.platform_key order by pl.platform_key) as platform_keys
         from public.ci_product_platforms pp join public.ci_platforms pl on pl.id=pp.platform_id
         where pp.product_id=$1`, [platformProduct.id],
      );
      const platformBatchId = await stageIncremental('platform-update-test.xlsx', 'A'.repeat(64), platformPreview);
      const platformApply = await applyIncremental(platformBatchId);
      assert.deepEqual(platformApply.rows[0].result, {
        new: 0, existing: 0, updated: 1, conflict: 0, duplicate_in_file: 0,
      });
      const platformAfter = await client.query<{ id: string; product_code: string; platform_key: string }>(
        `select p.id,p.product_code,pl.platform_key from public.ci_products p
         join public.ci_product_platforms pp on pp.product_id=p.id join public.ci_platforms pl on pl.id=pp.platform_id
         where p.id=$1 order by pl.platform_key`, [platformProduct.id],
      );
      assert.deepEqual(platformAfter.rows, [{ id: platformProduct.id, product_code: platformProduct.product_code, platform_key: 'c703' }]);

      master = await loadIncrementalMaster();
      const relation = master.relations.find(item => item.relation_type === 'uses_consumable')!;
      const relationProduct = master.products.find(product => product.id === relation.target_product_id)!;
      const originalRelationSources = master.relations.filter(item => item.target_product_id === relationProduct.id && item.relation_type.startsWith('uses_'));
      const alternateReagent = master.products.find(product => product.warehouse_id === relationProduct.warehouse_id &&
        product.product_type === 'reagent' && !originalRelationSources.some(item => item.source_product_id === product.id))!;
      const relationCandidate = {
        warehouse_code: relationProduct.warehouse_id === 1 ? 'CHE' as const : 'IMM' as const,
        source_name: relationProduct.display_name, product_type: relationProduct.product_type,
        packing_size_raw: null, source_sheet: relationProduct.source_sheet!, source_row: 1002,
        raw_source: { test: 'relationship replacement' },
        ref_current: master.identifiers.find(item => item.product_id === relationProduct.id && item.kind === 'REF_CURRENT')!.value,
        manufacturer_barcode: master.identifiers.find(item => item.product_id === relationProduct.id && item.kind === 'MANUFACTURER_BARCODE')!.value,
        replaces_ref: null,
        used_with: relationProduct.warehouse_id === 1 ? alternateReagent.source_name.split(',',1)[0].trim() : alternateReagent.source_name,
      };
      const relationPreview = classifyIncrementalImport([relationCandidate], master);
      assert.equal(relationPreview[0].classification, 'Update');
      const relationBatchId = await stageIncremental('relationship-update-test.xlsx', 'B'.repeat(64), relationPreview);
      const relationApply = await applyIncremental(relationBatchId);
      assert.deepEqual(relationApply.rows[0].result, {
        new: 0, existing: 0, updated: 1, conflict: 0, duplicate_in_file: 0,
      });
      const relationsAfter = await client.query<{ source_product_id: string; relation_type: string }>(
        `select source_product_id,relation_type from public.ci_product_relations
         where target_product_id=$1 and relation_type like 'uses_%' order by source_product_id`, [relationProduct.id],
      );
      assert.deepEqual(relationsAfter.rows, [{ source_product_id: alternateReagent.id, relation_type: 'uses_consumable' }]);
      const relationAudit = await client.query<{ field: string }>(
        `select field from public.ci_incremental_product_import_audit where product_id=$1 and import_batch_id=$2 order by id`,
        [relationProduct.id, relationBatchId],
      );
      assert.deepEqual(relationAudit.rows, [{ field: 'Used with / Product relationship' }]);

      const existingHistory = await client.query<{ id: string; product_code: string; warehouse_id: number; product_type: string; source_name: string; display_name: string; current_ref: string; barcode: string; relations: string }>(
        `select p.id,p.product_code,p.warehouse_id,p.product_type,p.source_name,p.display_name,
          current.value as current_ref,barcode.value as barcode,
          (select count(*)::text from public.ci_product_relations r where r.source_product_id=p.id or r.target_product_id=p.id) as relations
         from public.ci_products p
         join public.ci_product_identifiers current on current.product_id=p.id and current.kind='REF_CURRENT'
         join public.ci_product_identifiers barcode on barcode.product_id=p.id and barcode.kind='MANUFACTURER_BARCODE'
         where p.id=$1`, [relationProduct.id],
      );
      const identityBefore = existingHistory.rows[0];
      await client.query('reset role');
      const historyLocation = await client.query<{ id: string }>(
        `insert into public.ci_locations(warehouse_id,code,name) values($1,'INCR-REF-TEST','Incremental REF test') returning id`,
        [identityBefore.warehouse_id],
      );
      const historyLot = await client.query<{ id: string }>(
        `insert into public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date)
         values($1,$2,'INCR-REF-LOT','2027-12-31') returning id`, [identityBefore.warehouse_id,identityBefore.id],
      );
      const historyTransaction = await client.query<{ id: string }>(
        `insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id)
         values($1,'receive','incremental-ref-test','incremental-ref-test',$2) returning id`, [identityBefore.warehouse_id,adminId],
      );
      await client.query(
        `insert into public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta)
         values($1,$2,$3,$4,2)`, [historyTransaction.rows[0].id,identityBefore.warehouse_id,historyLot.rows[0].id,historyLocation.rows[0].id],
      );
      await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [adminId]);

      master = await loadIncrementalMaster();
      const replacementCandidate = {
        warehouse_code: identityBefore.warehouse_id === 1 ? 'CHE' as const : 'IMM' as const,
        source_name: `${identityBefore.display_name} revised`, product_type: identityBefore.product_type as 'reagent'|'calibrator'|'control'|'consumable',
        packing_size_raw: null, source_sheet: relationProduct.source_sheet!, source_row: 1003,
        raw_source: { test: 'deterministic REF replacement' }, ref_current: '99999999999',
        manufacturer_barcode: identityBefore.barcode, replaces_ref: identityBefore.current_ref, used_with: null,
      };
      const replacementPreview = classifyIncrementalImport([replacementCandidate], master);
      assert.equal(replacementPreview[0].classification, 'Update');
      assert.equal(replacementPreview[0].product_id, identityBefore.id);
      const replacementBatchId = await stageIncremental('ref-replacement-test.xlsx', 'C'.repeat(64), replacementPreview);
      const replacementApply = await applyIncremental(replacementBatchId);
      assert.deepEqual(replacementApply.rows[0].result, {
        new: 0, existing: 0, updated: 1, conflict: 0, duplicate_in_file: 0,
      });
      const identityAfter = await client.query<{ id: string; product_code: string; source_name: string; display_name: string; ref_current: string; legacy_ref: string; lot_product_id: string; movement_count: string; relation_count: string }>(
        `select p.id,p.product_code,p.source_name,p.display_name,current.value as ref_current,legacy.value as legacy_ref,
          l.product_id as lot_product_id,
          (select count(*)::text from public.ci_stock_movement_lines m where m.lot_id=l.id) as movement_count,
          (select count(*)::text from public.ci_product_relations r where r.source_product_id=p.id or r.target_product_id=p.id) as relation_count
         from public.ci_products p
         join public.ci_product_identifiers current on current.product_id=p.id and current.kind='REF_CURRENT'
         join public.ci_product_identifiers legacy on legacy.product_id=p.id and legacy.kind='REF_LEGACY' and legacy.value=$2
         join public.ci_stock_lots l on l.product_id=p.id where p.id=$1`, [identityBefore.id,identityBefore.current_ref],
      );
      assert.deepEqual(identityAfter.rows[0], {
        id: identityBefore.id, product_code: identityBefore.product_code, source_name: identityBefore.source_name,
        display_name: `${identityBefore.display_name} revised`, ref_current: '99999999999', legacy_ref: identityBefore.current_ref,
        lot_product_id: identityBefore.id, movement_count: '1', relation_count: identityBefore.relations,
      });
      const platformAudit = await client.query<{ field: string; old_value: string[]; new_value: string[] }>(
        `select field,old_value,new_value
         from public.ci_incremental_product_import_audit where product_id=$1 order by id`, [platformProduct.id],
      );
      assert.deepEqual(platformAudit.rows, [{ field: 'Platform mapping', old_value: platformBefore.rows[0].platform_keys, new_value: ['c703'] }]);
      const replacementAudit = await client.query<{ field: string; old_value: string | null; new_value: string | null; action: string; source_filename: string; source_row: number; actor_id: string; created_at: string; batch_id: string }>(
        `select field,old_value#>>'{}' as old_value,new_value#>>'{}' as new_value,action,
          source_filename,source_row,actor_id,created_at::text,import_batch_id as batch_id
         from public.ci_incremental_product_import_audit where product_id=$1 and import_batch_id=$2 order by id`,
        [identityBefore.id, replacementBatchId],
      );
      assert.deepEqual(replacementAudit.rows.map(row => row.field), ['Product Name','REF_CURRENT','REF_LEGACY']);
      assert.ok(replacementAudit.rows.every(row => row.source_filename === 'ref-replacement-test.xlsx'
        && row.source_row === 1003 && row.actor_id === adminId && row.created_at && row.batch_id === replacementBatchId));
      assert.equal(replacementAudit.rows.find(row => row.field === 'REF_CURRENT')?.old_value, identityBefore.current_ref);
      assert.equal(replacementAudit.rows.find(row => row.field === 'REF_CURRENT')?.new_value, '99999999999');
      assert.ok(replacementAudit.rows.filter(row => ['REF_CURRENT','REF_LEGACY'].includes(row.field))
        .every(row => row.action === 'PRODUCT_IDENTIFIER_REPLACED'));

      master = await loadIncrementalMaster();
      const legacyNoteCandidate = {
        warehouse_code: identityBefore.warehouse_id === 1 ? 'CHE' as const : 'IMM' as const,
        source_name: `${identityAfter.rows[0].display_name} revised again`, product_type: identityBefore.product_type as 'reagent'|'calibrator'|'control'|'consumable',
        packing_size_raw: null, source_sheet: relationProduct.source_sheet!, source_row: 1004,
        raw_source: { test: 'replacement explicitly refers to prior legacy REF' }, ref_current: '88888888888',
        manufacturer_barcode: '99999999998', replaces_ref: identityBefore.current_ref, used_with: null,
      };
      const legacyNotePreview = classifyIncrementalImport([legacyNoteCandidate], master);
      assert.equal(legacyNotePreview[0].classification, 'Update');
      assert.equal(legacyNotePreview[0].product_id, identityBefore.id);
      const legacyNoteBatchId = await stageIncremental('legacy-ref-replacement-test.xlsx', 'D'.repeat(64), legacyNotePreview);
      const legacyNoteApply = await applyIncremental(legacyNoteBatchId);
      assert.deepEqual(legacyNoteApply.rows[0].result, {
        new: 0, existing: 0, updated: 1, conflict: 0, duplicate_in_file: 0,
      });
      const finalIdentity = await client.query<{ id: string; product_code: string; current_ref: string; barcode: string; legacy_refs: string[] }>(
        `select p.id,p.product_code,current.value as current_ref,barcode.value as barcode,
          array(select value from public.ci_product_identifiers where product_id=p.id and kind='REF_LEGACY' order by value) as legacy_refs
         from public.ci_products p
         join public.ci_product_identifiers current on current.product_id=p.id and current.kind='REF_CURRENT'
         join public.ci_product_identifiers barcode on barcode.product_id=p.id and barcode.kind='MANUFACTURER_BARCODE'
         where p.id=$1`, [identityBefore.id],
      );
      assert.deepEqual(finalIdentity.rows[0], {
        id: identityBefore.id, product_code: identityBefore.product_code, current_ref: '88888888888',
        barcode: '99999999998', legacy_refs: [identityBefore.current_ref,'99999999999'].sort(),
      });

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
