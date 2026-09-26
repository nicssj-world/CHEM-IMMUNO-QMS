import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import { resolveEnvironmentMonitor } from '../../src/lib/environment-monitor';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const STAFF_CHE = '22222222-2222-4222-8222-222222222222';
const SUP_CHE = '33333333-3333-4333-8333-333333333333';
const VIEWER_CHE = '44444444-4444-4444-8444-444444444444';
const SUP_IMM = '55555555-5555-4555-8555-555555555555';
const STAFF_IMM = '66666666-6666-4666-8666-666666666666';
const NO_ACCESS = '77777777-7777-4777-8777-777777777777';
const INACTIVE = '88888888-8888-4888-8888-888888888888';
const CHE = 1;
const IMM = 2;

const configuredDatabaseUrl = process.env.CI_TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error('Set CI_TEST_DATABASE_URL with scripts/db/test.ps1 to run disposable PostgreSQL tests');
const adminUrl = new URL(configuredDatabaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to a disposable loopback PostgreSQL postgres database');
}
const suffix = `${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
const dbName = `ci_locations_${suffix}`;
const backfillDbName = `ci_locations_backfill_${suffix}`;
const urlFor = (name: string) => { const url = new URL(adminUrl); url.pathname = `/${name}`; return url.toString(); };

async function connect(name = dbName) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  return client;
}
async function withOwner<T>(run: (client: Client) => Promise<T>, name = dbName): Promise<T> {
  const client = await connect(name);
  try { return await run(client); } finally { await client.end(); }
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
  } finally { await client.end(); }
}
async function rpc<T = unknown>(userId: string, name: string, args: unknown[], casts: string[]): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',');
  return asUser(userId, async (client) => {
    const result = await client.query<{ result: T }>(`SELECT public.${name}(${placeholders}) AS result`, args.map((arg, i) => casts[i] === 'jsonb' ? JSON.stringify(arg) : arg));
    return result.rows[0].result;
  });
}
async function rows<T extends Record<string, unknown> = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) {
  return asUser(userId, async (client) => (await client.query<T>(sql, params)).rows);
}
const createLocation = (userId: string, payload: Record<string, unknown>) => rpc<string>(userId, 'ci_create_location_v2', [payload], ['jsonb']);
const updateLocation = (userId: string, id: string, patch: Record<string, unknown>, expected: string | null) => rpc<void>(userId, 'ci_update_location', [id, patch, expected], ['uuid', 'jsonb', 'timestamptz']);
const setActive = (userId: string, id: string, active: boolean, reason: string) => rpc<void>(userId, 'ci_set_location_active', [id, active, reason], ['uuid', 'boolean', 'text']);
const rotate = (userId: string, id: string, reason: string) => rpc<void>(userId, 'ci_rotate_location_qr_token', [id, reason], ['uuid', 'text']);
const setEnv = (userId: string, id: string, env: Record<string, unknown>) => rpc<string | null>(userId, 'ci_set_location_env_config', [id, env], ['uuid', 'jsonb']);
const monitorOf = (userId: string, id: string | null) => rpc<string | null>(userId, 'ci_environment_monitor_location_id', [id], ['uuid']);
async function stamp(id: string) { return (await rows<{ t: string }>(ADMIN, 'SELECT updated_at::text AS t FROM public.ci_locations WHERE id = $1', [id]))[0].t; }
async function one<T extends Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) { return (await rows<T>(userId, sql, params))[0]; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fridgeEnv = { temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };

async function migrationFiles() {
  return (await readdir(path.join(process.cwd(), 'supabase/migrations'))).filter(file => file.endsWith('.sql')).sort();
}
async function applyFiles(client: Client, files: string[]) {
  for (const file of files) await client.query(await readFile(path.join(process.cwd(), file), 'utf8'));
}
async function seedUsers(client: Client) {
  await client.query(`INSERT INTO auth.users(id) VALUES ('${ADMIN}'),('${STAFF_CHE}'),('${SUP_CHE}'),('${VIEWER_CHE}'),('${SUP_IMM}'),('${STAFF_IMM}'),('${NO_ACCESS}'),('${INACTIVE}')`);
  await client.query(`INSERT INTO public.ci_user_profiles(user_id,ephis_id,display_name,active) VALUES
    ('${ADMIN}','a100','Admin',true),('${STAFF_CHE}','s200','Staff CHE',true),('${SUP_CHE}','p300','Supervisor CHE',true),('${VIEWER_CHE}','v400','Viewer CHE',true),
    ('${SUP_IMM}','p500','Supervisor IMM',true),('${STAFF_IMM}','s600','Staff IMM',true),('${NO_ACCESS}','n700','No access',true),('${INACTIVE}','i800','Inactive profile',false)`);
  await client.query(`INSERT INTO public.ci_user_access(user_id,warehouse_id,role) VALUES
    ('${ADMIN}',1,'admin'),('${ADMIN}',2,'admin'),('${STAFF_CHE}',1,'staff'),('${SUP_CHE}',1,'supervisor'),('${VIEWER_CHE}',1,'viewer'),
    ('${SUP_IMM}',2,'supervisor'),('${STAFF_IMM}',2,'staff'),('${INACTIVE}',1,'admin')`);
}

test('Phase 1 Location Master: hierarchy, ranges, monitor resolution, QR, audit and security boundaries', { timeout: 240_000 }, async (t) => {
  const owner = new Client({ connectionString: adminUrl.toString() });
  await owner.connect();
  try {
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.query(`CREATE DATABASE ${backfillDbName}`);
  } finally { await owner.end(); }
  try {
    await withOwner(async (client) => { await applyFiles(client, ['tests/db/bootstrap.sql', ...(await migrationFiles()).map(file => `supabase/migrations/${file}`)]); await seedUsers(client); });

    await t.test('existing locations are backfilled (token, type, timestamps) when the migration runs on populated data', async () => {
      const files = await migrationFiles();
      const master = files.find(file => file.endsWith('_ci_location_master.sql'))!;
      assert.ok(master, 'the Phase 1 migration must exist');
      await withOwner(async (client) => {
        await applyFiles(client, ['tests/db/bootstrap.sql', ...files.filter(file => file !== master).map(file => `supabase/migrations/${file}`)]);
        await client.query(`INSERT INTO public.ci_locations(warehouse_id,code,name,created_at) VALUES (1,'OLD-1','Old one','2026-01-01T00:00:00Z'),(1,'OLD-2','Old two','2026-02-01T00:00:00Z'),(2,'OLD-3','Old three','2026-03-01T00:00:00Z')`);
        const precheck = await client.query(`SELECT id FROM public.ci_locations WHERE code <> btrim(code) OR char_length(btrim(code)) NOT BETWEEN 1 AND 40 OR name <> btrim(name) OR char_length(btrim(name)) NOT BETWEEN 1 AND 120`);
        assert.equal(precheck.rowCount, 0, 'the documented pre-check query returns no rows');
        await applyFiles(client, [`supabase/migrations/${master}`]);
        const migrated = await client.query(`SELECT code, location_type, qr_token, qr_token_rotated_at, updated_at = created_at AS untouched, parent_location_id, portal_equipment_url, active FROM public.ci_locations ORDER BY code`);
        assert.equal(migrated.rowCount, 3);
        for (const row of migrated.rows) {
          assert.equal(row.location_type, 'other');
          assert.match(row.qr_token, /^[0-9a-f]{32}$/);
          assert.equal(row.qr_token_rotated_at, null);
          assert.equal(row.untouched, true, 'existing rows keep updated_at = created_at');
          assert.equal(row.parent_location_id, null);
          assert.equal(row.active, true);
        }
        assert.equal(new Set(migrated.rows.map(row => row.qr_token)).size, 3, 'every existing location gets its own token');
        const audits = await client.query(`SELECT count(*)::int AS n FROM public.ci_audit_logs WHERE entity_table = 'ci_locations'`);
        assert.equal(audits.rows[0].n, 0, 'the backfill writes no audit noise');
      }, backfillDbName);
    });

    // ------------------------------------------------------------------ fixtures
    const cheRoom = await createLocation(ADMIN, { warehouse_id: CHE, code: 'CHE-ROOM-01', name: 'ห้อง Chemistry', location_type: 'room', room: 'Clinical Chemistry' });
    const cheFridge = await createLocation(ADMIN, { warehouse_id: CHE, code: 'CHE-FR-01', name: 'ตู้เย็นน้ำยา Chemistry 1', location_type: 'refrigerator', room: 'Clinical Chemistry', storage_condition: '2–8 °C', env: fridgeEnv });
    const cheShelf = await createLocation(ADMIN, { warehouse_id: CHE, code: 'CHE-FR-01-S1', name: 'ชั้น 1', location_type: 'shelf', parent_location_id: cheFridge });
    const immFridge = await createLocation(ADMIN, { warehouse_id: IMM, code: 'IMM-FR-01', name: 'ตู้เย็น Immunology', location_type: 'refrigerator', env: fridgeEnv });
    const immShelf = await createLocation(ADMIN, { warehouse_id: IMM, code: 'IMM-FR-01-S1', name: 'ชั้น 1', location_type: 'shelf', parent_location_id: immFridge });

    await t.test('row-level security: each warehouse only reads its own locations and range versions; direct writes are impossible', async () => {
      const cheIds = (await rows<{ id: string }>(STAFF_CHE, 'SELECT id FROM public.ci_locations')).map(row => row.id);
      assert.ok(cheIds.includes(cheFridge) && cheIds.includes(cheShelf));
      assert.ok(!cheIds.includes(immFridge) && !cheIds.includes(immShelf));
      assert.deepEqual((await rows<{ location_id: string }>(STAFF_CHE, 'SELECT location_id FROM public.ci_location_env_configs')).map(row => row.location_id), [cheFridge]);
      const immIds = (await rows<{ id: string }>(SUP_IMM, 'SELECT id FROM public.ci_locations')).map(row => row.id);
      assert.ok(immIds.includes(immFridge) && !immIds.includes(cheFridge));
      assert.deepEqual((await rows<{ location_id: string }>(SUP_IMM, 'SELECT location_id FROM public.ci_location_env_configs')).map(row => row.location_id), [immFridge]);
      for (const outsider of [NO_ACCESS, INACTIVE]) {
        assert.equal((await rows(outsider, 'SELECT id FROM public.ci_locations')).length, 0);
        assert.equal((await rows(outsider, 'SELECT id FROM public.ci_location_env_configs')).length, 0);
      }
      const privileges = await withOwner(client => client.query(`SELECT
        has_table_privilege('authenticated','public.ci_locations','INSERT') AS loc_insert, has_table_privilege('authenticated','public.ci_locations','UPDATE') AS loc_update,
        has_table_privilege('authenticated','public.ci_locations','DELETE') AS loc_delete, has_table_privilege('anon','public.ci_locations','SELECT') AS loc_anon,
        has_table_privilege('authenticated','public.ci_location_env_configs','INSERT') AS env_insert, has_table_privilege('authenticated','public.ci_location_env_configs','UPDATE') AS env_update,
        has_table_privilege('authenticated','public.ci_location_env_configs','DELETE') AS env_delete, has_table_privilege('anon','public.ci_location_env_configs','SELECT') AS env_anon,
        has_table_privilege('authenticated','public.ci_location_env_configs','SELECT') AS env_select`));
      assert.deepEqual(privileges.rows[0], { loc_insert: false, loc_update: false, loc_delete: false, loc_anon: false, env_insert: false, env_update: false, env_delete: false, env_anon: false, env_select: true });
      await assert.rejects(() => asUser(ADMIN, client => client.query(`UPDATE public.ci_locations SET name = 'hacked' WHERE id = $1`, [cheFridge])), /permission denied/);
      await assert.rejects(() => asUser(ADMIN, client => client.query(`INSERT INTO public.ci_location_env_configs(warehouse_id,location_id,temperature_monitored,humidity_monitored,created_by) VALUES (1,$1,false,false,$2)`, [cheFridge, ADMIN])), /permission denied/);
    });

    await t.test('only an admin or supervisor of the location\'s own warehouse can mutate; missing and foreign ids look the same', async () => {
      const denied = /CI_ACCESS_DENIED/;
      const expected = await stamp(cheFridge);
      for (const user of [VIEWER_CHE, STAFF_CHE, SUP_IMM, STAFF_IMM, NO_ACCESS, INACTIVE]) {
        await assert.rejects(() => createLocation(user, { warehouse_id: CHE, code: `DENY-${user.slice(0, 2)}`, name: 'x' }), denied, `create by ${user}`);
        await assert.rejects(() => updateLocation(user, cheFridge, { name: 'x' }, expected), denied, `update by ${user}`);
        await assert.rejects(() => setActive(user, cheFridge, false, 'x'), denied, `active by ${user}`);
        await assert.rejects(() => rotate(user, cheFridge, 'x'), denied, `rotate by ${user}`);
        await assert.rejects(() => setEnv(user, cheFridge, fridgeEnv), denied, `env by ${user}`);
      }
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: IMM, code: 'CROSS-1', name: 'x' }), denied);
      await assert.rejects(async () => updateLocation(SUP_CHE, immFridge, { name: 'x' }, await stamp(immFridge)), denied);
      const missing = '99999999-9999-4999-8999-999999999999';
      for (const attempt of [() => updateLocation(SUP_CHE, missing, {}, expected), () => setActive(SUP_CHE, missing, false, 'x'), () => rotate(SUP_CHE, missing, 'x'), () => setEnv(SUP_CHE, missing, fridgeEnv)]) {
        await assert.rejects(attempt, denied, 'a missing id raises the same error as a forbidden one');
      }
      const created = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'SUP-OK', name: 'Created by supervisor' });
      assert.match(created, /^[0-9a-f-]{36}$/);
      await createLocation(SUP_IMM, { warehouse_id: IMM, code: 'SUP-IMM-OK', name: 'Created by IMM supervisor' });
    });

    await t.test('create stores every field, trims text, and rejects invalid or duplicate input; the legacy RPC still works', async () => {
      const portal = 'https://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-426614174000';
      const id = await createLocation(SUP_CHE, { warehouse_id: CHE, code: '  FIELDS-1  ', name: '  Fields fridge ', location_type: 'freezer', room: ' R1 ', description: 'desc', storage_condition: '-20 °C', portal_equipment_url: portal, portal_equipment_label: 'Freezer 1' });
      const row = await one(ADMIN, 'SELECT * FROM public.ci_locations WHERE id = $1', [id]);
      assert.equal(row.code, 'FIELDS-1'); assert.equal(row.name, 'Fields fridge'); assert.equal(row.location_type, 'freezer');
      assert.equal(row.room, 'R1'); assert.equal(row.description, 'desc'); assert.equal(row.storage_condition, '-20 °C');
      assert.equal(row.portal_equipment_url, portal); assert.equal(row.portal_equipment_label, 'Freezer 1');
      assert.equal(row.parent_location_id, null); assert.equal(row.active, true); assert.equal(row.updated_by, SUP_CHE);
      assert.match(String(row.qr_token), /^[0-9a-f]{32}$/);
      const blank = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'BLANKS-1', name: 'Blanks', room: '   ', description: '', portal_equipment_url: '' });
      const blankRow = await one(ADMIN, 'SELECT room, description, portal_equipment_url, location_type FROM public.ci_locations WHERE id = $1', [blank]);
      assert.deepEqual(blankRow, { room: null, description: null, portal_equipment_url: null, location_type: 'other' });

      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'fields-1'.toUpperCase(), name: 'Dup' }), /CI_LOCATION_CODE_EXISTS/);
      const invalid = /CI_LOCATION_FIELD_INVALID/;
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X1', name: 'x', location_type: 'garage' }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: '   ', name: 'x' }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X2', name: '' }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'C'.repeat(41), name: 'x' }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X3', name: 'N'.repeat(121) }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X4', name: 'x', room: 'R'.repeat(121) }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X5', name: 'x', description: 'D'.repeat(1001) }), invalid);
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X6', name: 'x', storage_condition: 'S'.repeat(121) }), invalid);
      for (const bad of ['http://lab-management-cbh.vercel.app/staff/equipment/x', 'javascript:alert(1)', 'https://host with space/x', `https://lab-management-cbh.vercel.app/${'a'.repeat(500)}`]) {
        await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X7', name: 'x', portal_equipment_url: bad }), invalid, bad.slice(0, 40));
      }
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'X8', name: 'x', portal_equipment_label: 'label without link' }), invalid);
      // Same code in the other warehouse is fine: uniqueness is per warehouse.
      await createLocation(SUP_IMM, { warehouse_id: IMM, code: 'FIELDS-1', name: 'Same code, other warehouse' });

      const legacy = await rpc<string>(SUP_CHE, 'ci_create_location', [CHE, 'LEGACY-1', 'Legacy quick add'], ['smallint', 'text', 'text']);
      const legacyRow = await one(ADMIN, 'SELECT location_type, qr_token, parent_location_id FROM public.ci_locations WHERE id = $1', [legacy]);
      assert.equal(legacyRow.location_type, 'other'); assert.match(String(legacyRow.qr_token), /^[0-9a-f]{32}$/); assert.equal(legacyRow.parent_location_id, null);
    });

    await t.test('hierarchy: depth 2 only, same warehouse, no self-parent, parents with children cannot become children', async () => {
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'DEPTH-3', name: 'grandchild', parent_location_id: cheShelf }), /CI_LOCATION_HIERARCHY_DEPTH/);
      await assert.rejects(() => createLocation(SUP_IMM, { warehouse_id: IMM, code: 'CROSS-CHILD', name: 'x', parent_location_id: cheFridge }), /CI_LOCATION_PARENT_INVALID/);
      await assert.rejects(async () => updateLocation(SUP_CHE, cheFridge, { parent_location_id: cheFridge }, await stamp(cheFridge)), /CI_LOCATION_PARENT_INVALID/);
      await assert.rejects(async () => updateLocation(SUP_CHE, cheFridge, { parent_location_id: cheRoom }, await stamp(cheFridge)), /CI_LOCATION_HAS_CHILDREN/);
      await assert.rejects(async () => updateLocation(SUP_CHE, cheRoom, { parent_location_id: cheShelf }, await stamp(cheRoom)), /CI_LOCATION_HIERARCHY_DEPTH/);
      await assert.rejects(async () => updateLocation(SUP_CHE, cheShelf, { parent_location_id: immFridge }, await stamp(cheShelf)), /CI_LOCATION_PARENT_INVALID/);
      // A fridge without children may move into a room; a shelf may be re-parented; both may be detached again.
      const loose = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'LOOSE-FR', name: 'loose fridge', location_type: 'refrigerator' });
      await updateLocation(SUP_CHE, loose, { parent_location_id: cheRoom }, await stamp(loose));
      assert.equal((await one(ADMIN, 'SELECT parent_location_id FROM public.ci_locations WHERE id = $1', [loose])).parent_location_id, cheRoom);
      await updateLocation(SUP_CHE, loose, { parent_location_id: null }, await stamp(loose));
      assert.equal((await one(ADMIN, 'SELECT parent_location_id FROM public.ci_locations WHERE id = $1', [loose])).parent_location_id, null);

      // The database enforces it even for a writer that bypasses the RPCs (the owner role).
      await withOwner(async (client) => {
        await assert.rejects(() => client.query(`INSERT INTO public.ci_locations(warehouse_id,code,name,parent_location_id) VALUES (1,'OWNER-DEPTH','x',$1)`, [cheShelf]), /CI_LOCATION_HIERARCHY_DEPTH/);
        await assert.rejects(() => client.query(`UPDATE public.ci_locations SET parent_location_id = id WHERE id = $1`, [cheRoom]), /ci_locations_not_own_parent_chk|CI_LOCATION_PARENT_INVALID/);
        await assert.rejects(() => client.query(`UPDATE public.ci_locations SET warehouse_id = 2 WHERE id = $1`, [cheRoom]), /CI_LOCATION_WAREHOUSE_IMMUTABLE/);
        await assert.rejects(() => client.query(`INSERT INTO public.ci_locations(warehouse_id,code,name,parent_location_id) VALUES (2,'OWNER-CROSS','x',$1)`, [cheFridge]), /CI_LOCATION_PARENT_INVALID|ci_locations_parent_fk/);
      });

      // A parent must be active to receive a child.
      const dormant = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'DORMANT-FR', name: 'dormant', location_type: 'refrigerator' });
      await setActive(SUP_CHE, dormant, false, 'retired');
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'DORMANT-S1', name: 'x', parent_location_id: dormant }), /CI_LOCATION_PARENT_INACTIVE/);
    });

    await t.test('concurrent hierarchy changes cannot produce a three-level tree', async () => {
      const [parent, otherTop] = await Promise.all([
        createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE-PARENT', name: 'race parent' }),
        createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE-TOP', name: 'race top' }),
      ]);
      // Adding a child while another session tries to give the parent its own parent.
      const a = await connect(); const b = await connect();
      try {
        await a.query('BEGIN');
        await a.query(`INSERT INTO public.ci_locations(warehouse_id,code,name,parent_location_id) VALUES (1,'RACE-CHILD','child',$1)`, [parent]);
        await b.query('BEGIN');
        const pending = b.query(`UPDATE public.ci_locations SET parent_location_id = $1 WHERE id = $2`, [otherTop, parent]).then(() => null, (error: Error) => error);
        await sleep(300);
        await a.query('COMMIT');
        const failure = await pending;
        assert.match(String(failure), /CI_LOCATION_HAS_CHILDREN/);
        await b.query('ROLLBACK');
      } finally { await a.end(); await b.end(); }
      // And the reverse order: the parent gets a parent first, then a child is added under it.
      const [parent2, top2] = await Promise.all([
        createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE-PARENT2', name: 'race parent 2' }),
        createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE-TOP2', name: 'race top 2' }),
      ]);
      const c = await connect(); const d = await connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE public.ci_locations SET parent_location_id = $1 WHERE id = $2`, [top2, parent2]);
        await d.query('BEGIN');
        const pending = d.query(`INSERT INTO public.ci_locations(warehouse_id,code,name,parent_location_id) VALUES (1,'RACE-CHILD2','child',$1)`, [parent2]).then(() => null, (error: Error) => error);
        await sleep(300);
        await c.query('COMMIT');
        assert.match(String(await pending), /CI_LOCATION_HIERARCHY_DEPTH/);
        await d.query('ROLLBACK');
      } finally { await c.end(); await d.end(); }
      const depth = await one<{ deepest: number }>(ADMIN, `SELECT count(*)::int AS deepest FROM public.ci_locations c JOIN public.ci_locations p ON p.id = c.parent_location_id WHERE p.parent_location_id IS NOT NULL`);
      assert.equal(depth.deepest, 0, 'no location has a grandparent');
    });

    await t.test('update: optimistic lock, partial patches, code freeze after history, portal link, audit old/new', async () => {
      const id = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'EDIT-1', name: 'Editable', room: 'Room A', storage_condition: '2–8 °C' });
      const first = await stamp(id);
      await updateLocation(SUP_CHE, id, { name: 'Renamed' }, first);
      const renamed = await one(ADMIN, 'SELECT name, room, storage_condition, updated_by, updated_at::text AS t FROM public.ci_locations WHERE id = $1', [id]);
      assert.deepEqual({ name: renamed.name, room: renamed.room, storage_condition: renamed.storage_condition, updated_by: renamed.updated_by }, { name: 'Renamed', room: 'Room A', storage_condition: '2–8 °C', updated_by: SUP_CHE });
      assert.notEqual(renamed.t, first, 'updated_at moves on every change');

      await assert.rejects(() => updateLocation(SUP_CHE, id, { name: 'Stale' }, first), /CI_STALE_UPDATE/);
      await assert.rejects(() => updateLocation(SUP_CHE, id, { name: 'Null stamp' }, null), /CI_STALE_UPDATE/);
      assert.equal((await one(ADMIN, 'SELECT name FROM public.ci_locations WHERE id = $1', [id])).name, 'Renamed', 'a stale update changes nothing');

      const base = await stamp(id);
      const attempts = await Promise.allSettled([updateLocation(SUP_CHE, id, { name: 'Concurrent A' }, base), updateLocation(ADMIN, id, { name: 'Concurrent B' }, base)]);
      assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1, 'exactly one of two concurrent edits from the same version wins');
      assert.match(String((attempts.find(item => item.status === 'rejected') as PromiseRejectedResult).reason), /CI_STALE_UPDATE/);

      const portal = 'https://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-426614174000';
      await updateLocation(SUP_CHE, id, { portal_equipment_url: portal, portal_equipment_label: 'Fridge in Portal' }, await stamp(id));
      await updateLocation(SUP_CHE, id, { room: null, storage_condition: '' }, await stamp(id));
      const cleared = await one(ADMIN, 'SELECT room, storage_condition, portal_equipment_url, portal_equipment_label FROM public.ci_locations WHERE id = $1', [id]);
      assert.deepEqual(cleared, { room: null, storage_condition: null, portal_equipment_url: portal, portal_equipment_label: 'Fridge in Portal' });
      await updateLocation(SUP_CHE, id, { portal_equipment_url: null }, await stamp(id));
      assert.deepEqual(await one(ADMIN, 'SELECT portal_equipment_url, portal_equipment_label FROM public.ci_locations WHERE id = $1', [id]), { portal_equipment_url: null, portal_equipment_label: null }, 'removing the link removes its label');
      await assert.rejects(async () => updateLocation(SUP_CHE, id, { location_type: 'garage' }, await stamp(id)), /CI_LOCATION_FIELD_INVALID/);
      await assert.rejects(async () => updateLocation(SUP_CHE, id, { code: 'EDIT-1', name: '' }, await stamp(id)), /CI_LOCATION_FIELD_INVALID/);
      await assert.rejects(async () => updateLocation(SUP_CHE, id, { code: 'CHE-FR-01' }, await stamp(id)), /CI_LOCATION_CODE_EXISTS/);

      // Codes freeze once any ledger record references the location; before that they are editable.
      await updateLocation(SUP_CHE, id, { code: 'EDIT-1B' }, await stamp(id));
      assert.equal((await one(ADMIN, 'SELECT code FROM public.ci_locations WHERE id = $1', [id])).code, 'EDIT-1B');

      const audits = await rows<{ action: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown>; actor_id: string }>(ADMIN, `SELECT action, old_value, new_value, actor_id FROM public.ci_audit_logs WHERE entity_table = 'ci_locations' AND entity_id = $1 ORDER BY id`, [id]);
      assert.equal(audits[0].action, 'INSERT'); assert.equal(audits[0].old_value, null); assert.equal(audits[0].new_value.code, 'EDIT-1');
      const rename = audits.find(audit => audit.action === 'UPDATE' && audit.new_value.name === 'Renamed')!;
      assert.equal(rename.old_value?.name, 'Editable'); assert.equal(rename.actor_id, SUP_CHE);
      const link = audits.find(audit => audit.action === 'UPDATE' && audit.new_value.portal_equipment_url === portal)!;
      assert.equal(link.old_value?.portal_equipment_url, null, 'Portal link changes carry old and new values');
      assert.ok(audits.some(audit => audit.action === 'UPDATE' && audit.old_value?.portal_equipment_url === portal && audit.new_value.portal_equipment_url === null));
    });

    // Stock fixtures: a product, a LOT and +5 on the fridge shelf, created through the real RPCs.
    const product = await rpc<string>(ADMIN, 'ci_create_product', [{ warehouse_id: CHE, product_type: 'reagent', source_name: 'Location stock reagent', current_ref: 'LOC-REF-1', manufacturer_barcode: 'LOC-BC-1' }], ['jsonb']);
    const lot = await withOwner(async (client) => (await client.query<{ id: string }>(`INSERT INTO public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date) VALUES (1,$1,'LOT-LOC-1','2027-06-30') RETURNING id`, [product])).rows[0].id);
    await rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lot, location_id: cheShelf, quantity_delta: 5, reason: 'seed for location tests', idempotency_key: 'loc-seed-1' }], ['jsonb']);
    await rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lot, location_id: cheFridge, quantity_delta: 2, reason: 'seed for location tests', idempotency_key: 'loc-seed-2' }], ['jsonb']);

    await t.test('the location code is immutable once ledger history references it, and no balance is stored on locations', async () => {
      await assert.rejects(async () => updateLocation(SUP_CHE, cheShelf, { code: 'CHE-FR-01-S1-RENAMED' }, await stamp(cheShelf)), /CI_LOCATION_CODE_IMMUTABLE/);
      await withOwner(client => assert.rejects(() => client.query(`UPDATE public.ci_locations SET code = 'DIRECT-RENAME' WHERE id = $1`, [cheShelf]), /CI_LOCATION_CODE_IMMUTABLE/));
      // Other fields of a location with history stay editable.
      await updateLocation(SUP_CHE, cheShelf, { name: 'ชั้น 1 (ล่าง)' }, await stamp(cheShelf));
      await updateLocation(SUP_CHE, cheShelf, { name: 'ชั้น 1' }, await stamp(cheShelf));
      const columns = await withOwner(client => client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ci_locations'`));
      assert.deepEqual(columns.rows.map(row => row.column_name).filter(name => /balance|quantity|stock/.test(name)), []);
      const history = await rows(ADMIN, `SELECT quantity_delta FROM public.ci_stock_movement_lines WHERE location_id = $1`, [cheShelf]);
      assert.equal(history.length, 1, 'historical movement rows are untouched');
    });

    await t.test('location stock is derived from the ledger and reconciles with the stock search for the same location', async () => {
      const derived = await rows<{ location_id: string; balance: string }>(ADMIN, `SELECT location_id, balance FROM public.ci_stock_balances WHERE location_id = ANY($1::uuid[]) AND balance <> 0 ORDER BY location_id`, [[cheFridge, cheShelf]]);
      const search = await rows<{ location_id: string; balance: string }>(ADMIN, `SELECT location_id, balance FROM public.ci_search_stock($1::smallint, '', 100, 0) WHERE location_id = ANY($2::uuid[]) ORDER BY location_id`, [CHE, [cheFridge, cheShelf]]);
      assert.deepEqual(derived.map(row => [row.location_id, Number(row.balance)]), search.map(row => [row.location_id, Number(row.balance)]));
      assert.equal(derived.reduce((sum, row) => sum + Number(row.balance), 0), 7);
      // A CHE viewer sees the same rows; an IMM user sees none of them.
      assert.equal((await rows(VIEWER_CHE, `SELECT 1 FROM public.ci_stock_balances WHERE location_id = $1`, [cheShelf])).length, 1);
      assert.equal((await rows(SUP_IMM, `SELECT 1 FROM public.ci_stock_balances WHERE location_id = $1`, [cheShelf])).length, 0);
    });

    await t.test('deactivation and reactivation: stock and active children block it, reasons are required, and both are audited', async () => {
      const stockBlock = /CI_LOCATION_HAS_STOCK/;
      await assert.rejects(() => setActive(SUP_CHE, cheShelf, false, 'retire'), stockBlock);
      await assert.rejects(() => setActive(SUP_CHE, cheFridge, false, 'retire'), /CI_LOCATION_HAS_ACTIVE_CHILDREN/);
      await assert.rejects(() => setActive(SUP_CHE, cheShelf, false, '   '), /CI_REASON_REQUIRED/);
      await assert.rejects(() => setActive(SUP_CHE, cheShelf, false, ''), /CI_REASON_REQUIRED/);

      // Empty the shelf and the fridge through the ledger; the history stays, the balance is zero.
      await rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lot, location_id: cheShelf, quantity_delta: -5, reason: 'empty shelf', idempotency_key: 'loc-empty-1' }], ['jsonb']);
      await rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lot, location_id: cheFridge, quantity_delta: -2, reason: 'empty fridge', idempotency_key: 'loc-empty-2' }], ['jsonb']);
      await assert.rejects(() => setActive(SUP_CHE, cheFridge, false, 'retire'), /CI_LOCATION_HAS_ACTIVE_CHILDREN/, 'still blocked by the active child');
      await setActive(SUP_CHE, cheShelf, false, 'shelf removed');
      await assert.rejects(() => setActive(SUP_CHE, cheShelf, true, ''), /CI_REASON_REQUIRED/);
      await setActive(SUP_CHE, cheFridge, false, 'fridge decommissioned');
      assert.equal((await one(ADMIN, 'SELECT active FROM public.ci_locations WHERE id = $1', [cheFridge])).active, false);
      await setActive(SUP_CHE, cheFridge, false, 'already inactive');
      const noop = await rows(ADMIN, `SELECT 1 FROM public.ci_audit_logs WHERE entity_id = $1 AND reason = 'already inactive'`, [cheFridge]);
      assert.equal(noop.length, 0, 'repeating the same state writes nothing');

      // A child cannot come back before its parent.
      await assert.rejects(() => setActive(SUP_CHE, cheShelf, true, 'restore shelf'), /CI_LOCATION_PARENT_INACTIVE/);
      await setActive(SUP_CHE, cheFridge, true, 'fridge returned');
      await setActive(SUP_CHE, cheShelf, true, 'restore shelf');
      // Inactive locations cannot receive stock (existing ledger rule is unchanged).
      await setActive(SUP_CHE, cheShelf, false, 'again');
      await assert.rejects(() => rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lot, location_id: cheShelf, quantity_delta: 1, reason: 'inactive', idempotency_key: 'loc-inactive-1' }], ['jsonb']), /CI_LOCATION_INVALID/);
      await setActive(SUP_CHE, cheShelf, true, 'restore for later tests');

      const audits = await rows<{ action: string; reason: string | null }>(ADMIN, `SELECT action, reason FROM public.ci_audit_logs WHERE entity_table = 'ci_locations' AND entity_id = $1 AND action IN ('ACTIVATE','DEACTIVATE') ORDER BY id`, [cheFridge]);
      assert.deepEqual(audits.map(audit => [audit.action, audit.reason]), [['DEACTIVATE', 'fridge decommissioned'], ['ACTIVATE', 'fridge returned']]);
      const trail = await rows<{ old_value: { active: boolean }; new_value: { active: boolean } }>(ADMIN, `SELECT old_value, new_value FROM public.ci_audit_logs WHERE entity_table = 'ci_locations' AND entity_id = $1 AND action = 'UPDATE' AND new_value->>'active' = 'false'`, [cheFridge]);
      assert.equal(trail.length, 1); assert.equal(trail[0].old_value.active, true);
    });

    // ---------------------------------------------------------------- concurrency: deactivation vs stock and hierarchy
    // Each race opens two real sessions. The pg_stat_activity check proves the second session really waited on a lock held
    // by the first, so the interleaving under test actually happened instead of the two calls simply running one after another.
    async function openAs(userId: string) {
      const client = await connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
      return client;
    }
    const settle = (promise: Promise<unknown>) => promise.then(() => null, (error: Error) => error);
    async function waitsOnLock(client: Client) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const row = await withOwner(owner => owner.query<{ wait_event_type: string | null }>('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [(client as unknown as { processID: number }).processID]));
        if (row.rows[0]?.wait_event_type === 'Lock') return true;
        await sleep(50);
      }
      return false;
    }
    async function finish(client: Client, error: Error | null) {
      try { await client.query(error ? 'ROLLBACK' : 'COMMIT'); } finally { await client.end(); }
    }
    let raceSeq = 0;
    async function stockFixture(initial: number) {
      const n = ++raceSeq;
      const location = await createLocation(ADMIN, { warehouse_id: CHE, code: `RACE-LOC-${n}`, name: `race location ${n}`, location_type: 'refrigerator' });
      const productId = await rpc<string>(ADMIN, 'ci_create_product', [{ warehouse_id: CHE, product_type: 'reagent', source_name: `Race reagent ${n}`, current_ref: `RACE-REF-${n}`, manufacturer_barcode: `RACE-BC-${n}` }], ['jsonb']);
      const lotId = await withOwner(async (client) => (await client.query<{ id: string }>(`INSERT INTO public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date) VALUES (1,$1,$2,'2030-01-01') RETURNING id`, [productId, `RACE-LOT-${n}`])).rows[0].id);
      if (initial) await rpc(ADMIN, 'ci_adjust_stock', [{ lot_id: lotId, location_id: location, quantity_delta: initial, reason: 'race seed', idempotency_key: `race-seed-${n}` }], ['jsonb']);
      return { location, productId, lotId, n };
    }
    const balanceAt = async (location: string) => Number((await one<{ b: string }>(ADMIN, 'SELECT coalesce(sum(quantity_delta),0)::text AS b FROM public.ci_stock_movement_lines WHERE location_id = $1', [location])).b);
    const activeOf = async (location: string) => (await one<{ active: boolean }>(ADMIN, 'SELECT active FROM public.ci_locations WHERE id = $1', [location])).active;

    await t.test('race: stock written while the location is being deactivated is refused, so an inactive location never holds stock', async () => {
      const { location, lotId, n } = await stockFixture(0);
      const a = await openAs(SUP_CHE);
      await a.query('SELECT public.ci_set_location_active($1, false, $2)', [location, 'retire during receipt']);
      const b = await openAs(ADMIN);
      const pending = settle(b.query('SELECT public.ci_adjust_stock($1::jsonb)', [JSON.stringify({ lot_id: lotId, location_id: location, quantity_delta: 4, reason: 'concurrent', idempotency_key: `race-adjust-${n}` })]));
      assert.equal(await waitsOnLock(b), true, 'the stock write must wait for the deactivation decision');
      await finish(a, null);
      const error = await pending as Error | null;
      await finish(b, error);
      assert.match(String(error), /CI_LOCATION_INACTIVE/);
      assert.equal(await activeOf(location), false);
      assert.equal(await balanceAt(location), 0, 'no stock landed in the deactivated location');
    });

    await t.test('race: a receipt confirmed while its location is being deactivated is refused as a whole', async () => {
      const { location, productId, n } = await stockFixture(0);
      const vendor = await rpc<string>(ADMIN, 'ci_create_vendor', [{ vendorCode: `V-RACE-${n}`, name: `Race vendor ${n}` }], ['jsonb']);
      const invoice = await rpc<string>(ADMIN, 'ci_create_invoice', [{ vendor_id: vendor, invoice_number: `RACE-INV-${n}`, invoice_date: '2026-09-26', lines: [{ product_id: productId, quantity: 3 }] }], ['jsonb']);
      const line = (await one<{ id: string }>(ADMIN, 'SELECT id FROM public.ci_invoice_lines WHERE invoice_id = $1', [invoice])).id;
      const a = await openAs(SUP_CHE);
      await a.query('SELECT public.ci_set_location_active($1, false, $2)', [location, 'retire during receipt']);
      const b = await openAs(STAFF_CHE);
      const pending = settle(b.query('SELECT public.ci_confirm_receipt($1::uuid, $2::jsonb, $3::text)', [invoice, JSON.stringify([{ invoice_line_id: line, quantity: 3, lot_number: `RACE-RCV-${n}`, expiry_date: '2030-02-01', location_id: location }]), `race-receipt-${n}`]));
      assert.equal(await waitsOnLock(b), true);
      await finish(a, null);
      const error = await pending as Error | null;
      await finish(b, error);
      assert.match(String(error), /CI_LOCATION_INACTIVE/);
      assert.equal(await balanceAt(location), 0);
      assert.equal((await rows(ADMIN, 'SELECT 1 FROM public.ci_receipts WHERE invoice_id = $1', [invoice])).length, 0, 'the receipt rolled back atomically');
    });

    await t.test('race: a transfer into a location being deactivated is refused, and the source keeps its stock', async () => {
      const source = await stockFixture(5);
      const target = await createLocation(ADMIN, { warehouse_id: CHE, code: `RACE-TARGET-${source.n}`, name: 'race target', location_type: 'shelf' });
      const a = await openAs(SUP_CHE);
      await a.query('SELECT public.ci_set_location_active($1, false, $2)', [target, 'retire during transfer']);
      const b = await openAs(STAFF_CHE);
      const pending = settle(b.query('SELECT public.ci_transfer_stock($1::jsonb)', [JSON.stringify({ lot_id: source.lotId, from_location_id: source.location, to_location_id: target, quantity: 2, idempotency_key: `race-transfer-${source.n}` })]));
      assert.equal(await waitsOnLock(b), true);
      await finish(a, null);
      const error = await pending as Error | null;
      await finish(b, error);
      assert.match(String(error), /CI_LOCATION_INACTIVE/);
      assert.equal(await balanceAt(target), 0);
      assert.equal(await balanceAt(source.location), 5);
    });

    await t.test('race: when the stock write comes first, the deactivation waits and then sees the stock', async () => {
      const { location, lotId, n } = await stockFixture(0);
      const b = await openAs(ADMIN);
      await b.query('SELECT public.ci_adjust_stock($1::jsonb)', [JSON.stringify({ lot_id: lotId, location_id: location, quantity_delta: 4, reason: 'first', idempotency_key: `race-first-${n}` })]);
      const a = await openAs(SUP_CHE);
      const pending = settle(a.query('SELECT public.ci_set_location_active($1, false, $2)', [location, 'retire after receipt']));
      assert.equal(await waitsOnLock(a), true);
      await finish(b, null);
      const error = await pending as Error | null;
      await finish(a, error);
      assert.match(String(error), /CI_LOCATION_HAS_STOCK/);
      assert.equal(await activeOf(location), true);
      assert.equal(await balanceAt(location), 4);
    });

    await t.test('stock can still leave an inactive location, but never re-enter it (e.g. by reversing an earlier issue)', async () => {
      const { location, productId, lotId, n } = await stockFixture(2);
      const issue = await rpc<string>(ADMIN, 'ci_issue_stock', [{ product_id: productId, lot_id: lotId, location_id: location, quantity: 2, purpose: 'Routine', idempotency_key: `race-issue-${n}` }], ['jsonb']);
      await setActive(SUP_CHE, location, false, 'emptied and retired');
      await assert.rejects(() => rpc(SUP_CHE, 'ci_reverse_transaction', [issue, 'issued by mistake', `race-reverse-${n}`], ['uuid', 'text', 'text']), /CI_LOCATION_INACTIVE/);
      assert.equal(await balanceAt(location), 0);
      await setActive(SUP_CHE, location, true, 'reopened to take the reversal');
      await rpc(SUP_CHE, 'ci_reverse_transaction', [issue, 'issued by mistake', `race-reverse-${n}-2`], ['uuid', 'text', 'text']);
      assert.equal(await balanceAt(location), 2, 'after reactivation the same reversal succeeds');
    });

    await t.test('race: a child cannot be created or reactivated under a parent that is being deactivated, and vice versa', async () => {
      const parent = await createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE-PARENT-ACT', name: 'race parent', location_type: 'refrigerator' });
      // Parent deactivation first, child creation second.
      let a = await openAs(SUP_CHE);
      await a.query('SELECT public.ci_set_location_active($1, false, $2)', [parent, 'retire parent']);
      let b = await openAs(SUP_CHE);
      let pending = settle(b.query('SELECT public.ci_create_location_v2($1::jsonb)', [JSON.stringify({ warehouse_id: CHE, code: 'RACE-CHILD-ACT', name: 'child', location_type: 'shelf', parent_location_id: parent })]));
      assert.equal(await waitsOnLock(b), true);
      await finish(a, null);
      let error = await pending as Error | null;
      await finish(b, error);
      assert.match(String(error), /CI_LOCATION_PARENT_INACTIVE/);
      assert.equal((await rows(ADMIN, `SELECT 1 FROM public.ci_locations WHERE code = 'RACE-CHILD-ACT'`)).length, 0);

      // An inactive child whose parent is being deactivated cannot be reactivated underneath it.
      await setActive(SUP_CHE, parent, true, 'back');
      const child = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'RACE-CHILD-ACT2', name: 'child 2', location_type: 'shelf', parent_location_id: parent });
      await setActive(SUP_CHE, child, false, 'child off');
      a = await openAs(SUP_CHE);
      await a.query('SELECT public.ci_set_location_active($1, false, $2)', [parent, 'retire parent again']);
      b = await openAs(SUP_CHE);
      pending = settle(b.query('SELECT public.ci_set_location_active($1, true, $2)', [child, 'child back']));
      assert.equal(await waitsOnLock(b), true);
      await finish(a, null);
      error = await pending as Error | null;
      await finish(b, error);
      assert.match(String(error), /CI_LOCATION_PARENT_INACTIVE/);
      assert.deepEqual([await activeOf(parent), await activeOf(child)], [false, false]);

      // Child reactivation first, parent deactivation second: the parent waits and then sees the active child.
      await setActive(SUP_CHE, parent, true, 'back again');
      b = await openAs(SUP_CHE);
      await b.query('SELECT public.ci_set_location_active($1, true, $2)', [child, 'child back first']);
      a = await openAs(SUP_CHE);
      pending = settle(a.query('SELECT public.ci_set_location_active($1, false, $2)', [parent, 'retire parent late']));
      assert.equal(await waitsOnLock(a), true);
      await finish(b, null);
      error = await pending as Error | null;
      await finish(a, error);
      assert.match(String(error), /CI_LOCATION_HAS_ACTIVE_CHILDREN/);
      assert.deepEqual([await activeOf(parent), await activeOf(child)], [true, true]);
      const orphans = await one<{ n: number }>(ADMIN, 'SELECT count(*)::int AS n FROM public.ci_locations c JOIN public.ci_locations p ON p.id = c.parent_location_id WHERE c.active AND NOT p.active');
      assert.equal(orphans.n, 0, 'no active child under an inactive parent anywhere');
    });

    await t.test('race: a parent cannot gain a parent while it is receiving a child (both lock orders)', async () => {
      const top = await createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE3-TOP', name: 'top', location_type: 'room' });
      const middle = await createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE3-MID', name: 'middle', location_type: 'refrigerator' });
      const leaf = await createLocation(ADMIN, { warehouse_id: CHE, code: 'RACE3-LEAF', name: 'leaf', location_type: 'shelf' });
      // Session A attaches leaf under middle (share-locks middle); session B then tries to attach middle under top.
      const a = await openAs(SUP_CHE);
      await a.query('SELECT public.ci_update_location($1, $2::jsonb, (SELECT updated_at FROM public.ci_locations WHERE id = $1))', [leaf, JSON.stringify({ parent_location_id: middle })]);
      const b = await openAs(SUP_CHE);
      const pending = settle(b.query('SELECT public.ci_update_location($1, $2::jsonb, (SELECT updated_at FROM public.ci_locations WHERE id = $1))', [middle, JSON.stringify({ parent_location_id: top })]));
      assert.equal(await waitsOnLock(b), true);
      await finish(a, null);
      const error = await pending as Error | null;
      await finish(b, error);
      assert.match(String(error), /CI_LOCATION_HAS_CHILDREN/);
      const depth = await one<{ n: number }>(ADMIN, 'SELECT count(*)::int AS n FROM public.ci_locations c JOIN public.ci_locations p ON p.id = c.parent_location_id WHERE p.parent_location_id IS NOT NULL');
      assert.equal(depth.n, 0);
    });

    await t.test('range configuration: boundary rules, one-sided limits, append-only versions and no-op saves', async () => {
      const id = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'ENV-1', name: 'Range fixture', location_type: 'refrigerator' });
      const count = async () => Number((await one<{ n: number }>(ADMIN, 'SELECT count(*)::int AS n FROM public.ci_location_env_configs WHERE location_id = $1', [id])).n);
      const off = { temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };
      assert.equal(await setEnv(SUP_CHE, id, off), null, 'switching monitoring off on a location that never had it stores nothing');
      assert.equal(await count(), 0);

      const invalid = /CI_ENV_CONFIG_INVALID/;
      const badTemps: Record<string, unknown>[] = [
        { temperature_monitored: true, temp_min_c: 8, temp_max_c: 2 }, { temperature_monitored: true, temp_min_c: 5, temp_max_c: 5 },
        { temperature_monitored: true }, { temperature_monitored: false, temp_min_c: 2 }, { temperature_monitored: false, temp_max_c: 8 },
        { temperature_monitored: true, temp_min_c: -100.01, temp_max_c: 0 }, { temperature_monitored: true, temp_min_c: 0, temp_max_c: 100.01 },
        { temperature_monitored: true, temp_min_c: 1000, temp_max_c: 2000 }, { temperature_monitored: true, temp_min_c: 'abc', temp_max_c: 8 },
      ];
      const badHumidity: Record<string, unknown>[] = [
        { humidity_monitored: true, rh_min_pct: 60, rh_max_pct: 30 }, { humidity_monitored: true, rh_min_pct: 50, rh_max_pct: 50 }, { humidity_monitored: true },
        { humidity_monitored: false, rh_min_pct: 30 }, { humidity_monitored: true, rh_min_pct: -0.01, rh_max_pct: 50 }, { humidity_monitored: true, rh_min_pct: 10, rh_max_pct: 100.01 },
      ];
      for (const bad of [...badTemps, ...badHumidity]) await assert.rejects(() => setEnv(SUP_CHE, id, bad), invalid, JSON.stringify(bad));
      assert.equal(await count(), 0, 'rejected configurations leave no version behind');

      const valid: Record<string, unknown>[] = [
        { temperature_monitored: true, temp_min_c: 2, temp_max_c: 8 },
        { temperature_monitored: true, temp_min_c: -100, temp_max_c: 100 },
        { temperature_monitored: true, temp_max_c: -20 },
        { temperature_monitored: true, temp_min_c: 15 },
        { humidity_monitored: true, rh_min_pct: 0, rh_max_pct: 100 },
        { humidity_monitored: true, rh_min_pct: 30 },
        { humidity_monitored: true, rh_max_pct: 60 },
        { temperature_monitored: true, temp_min_c: 20, temp_max_c: 25, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: 60 },
      ];
      const versionIds: string[] = [];
      for (const config of valid) {
        const versionId = await setEnv(SUP_CHE, id, { ...off, ...config });
        assert.ok(versionId, JSON.stringify(config));
        versionIds.push(versionId!);
      }
      assert.equal(await count(), valid.length);

      const original = await one(ADMIN, 'SELECT * FROM public.ci_location_env_configs WHERE id = $1', [versionIds[0]]);
      assert.equal(await setEnv(SUP_CHE, id, { ...off, ...valid.at(-1)! }), null, 'identical configuration is a no-op');
      assert.equal(await setEnv(SUP_CHE, id, { temperature_monitored: true, temp_min_c: '20.00', temp_max_c: 25.0, humidity_monitored: true, rh_min_pct: '30', rh_max_pct: 60.000 }), null, 'the same numbers in another spelling are a no-op');
      assert.equal(await count(), valid.length, 'no-op saves create no versions');

      const dated = await rows<{ effective_from: string; created_by: string }>(ADMIN, 'SELECT effective_from::text, created_by FROM public.ci_location_env_configs WHERE location_id = $1 ORDER BY effective_from', [id]);
      assert.deepEqual(dated.map(row => row.effective_from), [...dated.map(row => row.effective_from)].sort(), 'versions are strictly ordered');
      assert.equal(new Set(dated.map(row => row.effective_from)).size, dated.length);
      assert.ok(dated.every(row => row.created_by === SUP_CHE));
      assert.deepEqual(await one(ADMIN, 'SELECT * FROM public.ci_location_env_configs WHERE id = $1', [versionIds[0]]), original, 'earlier versions are never rewritten');
      const current = await one(ADMIN, 'SELECT temperature_monitored, humidity_monitored, temp_min_c::float AS t_min, rh_max_pct::float AS rh_max FROM public.ci_location_env_configs WHERE location_id = $1 ORDER BY effective_from DESC LIMIT 1', [id]);
      assert.deepEqual(current, { temperature_monitored: true, humidity_monitored: true, t_min: 20, rh_max: 60 });

      // Turning monitoring off after it was on is a real change and becomes the newest version.
      assert.ok(await setEnv(SUP_CHE, id, off));
      assert.equal(await count(), valid.length + 1);

      // Append-only, even for the owner role, and audited on insert.
      await withOwner(async (client) => {
        await assert.rejects(() => client.query(`UPDATE public.ci_location_env_configs SET temp_max_c = 9 WHERE id = $1`, [versionIds[0]]), /CI_CONFIRMED_HISTORY_IMMUTABLE/);
        await assert.rejects(() => client.query(`DELETE FROM public.ci_location_env_configs WHERE id = $1`, [versionIds[0]]), /CI_CONFIRMED_HISTORY_IMMUTABLE/);
        // The table CHECKs are the backstop behind the RPC validation.
        await assert.rejects(() => client.query(`INSERT INTO public.ci_location_env_configs(warehouse_id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,created_by) VALUES (1,$1,now() + interval '1 day',true,9,3,false,$2)`, [id, ADMIN]), /ci_location_env_configs_temperature_chk/);
        await assert.rejects(() => client.query(`INSERT INTO public.ci_location_env_configs(warehouse_id,location_id,effective_from,temperature_monitored,humidity_monitored,rh_min_pct,created_by) VALUES (1,$1,now() + interval '2 day',false,false,10,$2)`, [id, ADMIN]), /ci_location_env_configs_humidity_chk/);
        await assert.rejects(() => client.query(`INSERT INTO public.ci_location_env_configs(warehouse_id,location_id,effective_from,temperature_monitored,humidity_monitored,created_by) VALUES (2,$1,now(),false,false,$2)`, [id, ADMIN]), /ci_location_env_configs_location_fk/, 'a version cannot claim another warehouse than its location');
        await assert.rejects(() => client.query(`INSERT INTO public.ci_location_env_configs(warehouse_id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,rh_min_pct,rh_max_pct,created_by) SELECT warehouse_id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,rh_min_pct,rh_max_pct,created_by FROM public.ci_location_env_configs WHERE id = $1`, [versionIds[0]]), /ci_location_env_configs_effective_uq/);
      });
      const audits = await rows<{ action: string; new_value: { location_id: string } }>(ADMIN, `SELECT action, new_value FROM public.ci_audit_logs WHERE entity_table = 'ci_location_env_configs' AND entity_id = $1`, [versionIds[0]]);
      assert.equal(audits.length, 1); assert.equal(audits[0].action, 'INSERT'); assert.equal(audits[0].new_value.location_id, id);

      // Range changes move the location's own timestamp, so an edit form opened earlier cannot overwrite them; no-ops do not.
      const before = await stamp(id);
      assert.equal(await setEnv(SUP_CHE, id, off), null);
      assert.equal(await stamp(id), before, 'a no-op save leaves updated_at alone');
      assert.ok(await setEnv(SUP_CHE, id, { ...off, temperature_monitored: true, temp_min_c: 2, temp_max_c: 8 }));
      assert.notEqual(await stamp(id), before);
      await assert.rejects(() => updateLocation(SUP_CHE, id, { name: 'stale form' }, before), /CI_STALE_UPDATE/);
    });

    await t.test('create and update are atomic with their range configuration', async () => {
      await assert.rejects(() => createLocation(SUP_CHE, { warehouse_id: CHE, code: 'ATOMIC-1', name: 'x', location_type: 'freezer', env: { temperature_monitored: true, temp_min_c: 9, temp_max_c: 3 } }), /CI_ENV_CONFIG_INVALID/);
      assert.equal((await rows(ADMIN, `SELECT 1 FROM public.ci_locations WHERE code = 'ATOMIC-1'`)).length, 0, 'the location is rolled back with the invalid range');
      const id = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'ATOMIC-2', name: 'Atomic', location_type: 'freezer', env: { temperature_monitored: true, temp_max_c: -20 } });
      assert.equal((await rows(ADMIN, `SELECT 1 FROM public.ci_location_env_configs WHERE location_id = $1`, [id])).length, 1);
      await assert.rejects(async () => updateLocation(SUP_CHE, id, { name: 'Should not stick', env: { temperature_monitored: true, temp_min_c: 9, temp_max_c: 3 } }, await stamp(id)), /CI_ENV_CONFIG_INVALID/);
      assert.equal((await one(ADMIN, 'SELECT name FROM public.ci_locations WHERE id = $1', [id])).name, 'Atomic');
      await updateLocation(SUP_CHE, id, { name: 'Atomic edited', env: { temperature_monitored: true, temp_max_c: -18 } }, await stamp(id));
      assert.equal((await rows(ADMIN, `SELECT 1 FROM public.ci_location_env_configs WHERE location_id = $1`, [id])).length, 2);
    });

    await t.test('monitored-container resolution: own, inherited, overridden and absent monitoring', async () => {
      const off = { temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };
      const room = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'MON-ROOM', name: 'monitor room', location_type: 'room' });
      const fridge = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'MON-FR', name: 'monitor fridge', location_type: 'refrigerator', env: fridgeEnv });
      const shelf = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'MON-FR-S1', name: 'shelf', location_type: 'shelf', parent_location_id: fridge });
      const shelfOwn = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'MON-FR-S2', name: 'shelf with own monitoring', location_type: 'shelf', parent_location_id: fridge, env: { ...off, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: 60 } });
      const bareParent = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'MON-CAB', name: 'unmonitored cabinet', location_type: 'cabinet' });
      const bareShelf = await createLocation(SUP_CHE, { warehouse_id: CHE, code: 'MON-CAB-S1', name: 'shelf under unmonitored cabinet', location_type: 'shelf', parent_location_id: bareParent });

      assert.equal(await monitorOf(SUP_CHE, fridge), fridge, 'a monitored refrigerator resolves to itself');
      assert.equal(await monitorOf(SUP_CHE, shelf), fridge, 'an unconfigured shelf resolves to its monitored refrigerator');
      assert.equal(await monitorOf(SUP_CHE, shelfOwn), shelfOwn, 'a shelf with its own monitoring resolves to itself');
      assert.equal(await monitorOf(SUP_CHE, bareShelf), null, 'a shelf under an unmonitored parent resolves to null');
      assert.equal(await monitorOf(SUP_CHE, room), null);
      assert.equal(await monitorOf(SUP_CHE, null), null);
      // Readers who cannot mutate may still resolve it for display.
      assert.equal(await monitorOf(VIEWER_CHE, shelf), fridge);

      // The newest parent version wins: switch the fridge off and its shelf loses the inherited monitoring, but keeps its own.
      await setEnv(SUP_CHE, fridge, off);
      assert.equal(await monitorOf(SUP_CHE, shelf), null, 'monitoring switched off in the latest parent version');
      assert.equal(await monitorOf(SUP_CHE, fridge), null);
      assert.equal(await monitorOf(SUP_CHE, shelfOwn), shelfOwn);
      await setEnv(SUP_CHE, fridge, fridgeEnv);
      assert.equal(await monitorOf(SUP_CHE, shelf), fridge, 'a later version turns it back on');
      // Switching the shelf's own monitoring off returns it to inheritance.
      await setEnv(SUP_CHE, shelfOwn, off);
      assert.equal(await monitorOf(SUP_CHE, shelfOwn), fridge);

      // TypeScript mirror agrees with the database for every location in the fixture, for a reader of each warehouse.
      for (const user of [ADMIN, SUP_CHE, SUP_IMM]) {
        const locations = await rows<{ id: string; parent_location_id: string | null }>(user, 'SELECT id, parent_location_id FROM public.ci_locations');
        const configs = await rows<{ location_id: string; temperature_monitored: boolean; humidity_monitored: boolean; effective_from: string }>(user, 'SELECT location_id, temperature_monitored, humidity_monitored, effective_from::text FROM public.ci_location_env_configs');
        for (const location of locations) {
          assert.equal(resolveEnvironmentMonitor(location.id, locations, configs), await monitorOf(user, location.id), `${location.id} as ${user}`);
        }
      }
    });

    await t.test('the SECURITY DEFINER resolver enforces warehouse access itself and leaks nothing', async () => {
      // Unauthorized and non-existent targets are indistinguishable: a plain null, never an error.
      const nonexistent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      for (const target of [immFridge, immShelf, nonexistent]) {
        assert.equal(await monitorOf(STAFF_CHE, target), null, `CHE-only user resolving ${target}`);
        assert.equal(await monitorOf(SUP_CHE, target), null);
        assert.equal(await monitorOf(NO_ACCESS, target), null, 'a user with no access');
        assert.equal(await monitorOf(INACTIVE, target), null, 'a user whose profile is inactive');
      }
      assert.equal(await monitorOf(NO_ACCESS, cheFridge), null);
      assert.equal(await monitorOf(INACTIVE, cheFridge), null);
      assert.equal(await monitorOf(SUP_IMM, immFridge), immFridge);
      assert.equal(await monitorOf(SUP_IMM, immShelf), immFridge, 'the authorized IMM user resolves the shelf to its refrigerator');
      assert.equal(await monitorOf(STAFF_IMM, immShelf), immFridge);
      assert.equal(await monitorOf(SUP_IMM, cheFridge), null);
      assert.equal(await monitorOf(SUP_IMM, cheShelf), null);
      // An anonymous session (no user at all) gets nothing either, and cannot even call the published wrapper.
      await withOwner(async (client) => {
        await client.query('BEGIN');
        assert.equal((await client.query(`SELECT ci_private.environment_monitor_location_id($1) AS r`, [immFridge])).rows[0].r, null, 'no auth.uid() at all');
        await client.query('ROLLBACK');
      });
      await assert.rejects(() => withOwner(async (client) => { await client.query('BEGIN'); await client.query('SET LOCAL ROLE anon'); await client.query(`SELECT public.ci_environment_monitor_location_id($1)`, [immFridge]); }), /permission denied/);

      // Called through another SECURITY DEFINER function (which bypasses RLS), the authorization boundary still holds.
      await withOwner(client => client.query(`
        CREATE FUNCTION ci_private.zz_probe_monitor(p uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT ci_private.environment_monitor_location_id(p) $$;
        GRANT EXECUTE ON FUNCTION ci_private.zz_probe_monitor(uuid) TO authenticated`));
      const probe = (user: string, target: string) => one<{ r: string | null }>(user, 'SELECT ci_private.zz_probe_monitor($1::uuid) AS r', [target]).then(row => row.r);
      assert.equal(await probe(STAFF_CHE, immShelf), null, 'a CHE-only user cannot reach IMM data through a definer wrapper');
      assert.equal(await probe(STAFF_CHE, immFridge), null);
      assert.equal(await probe(STAFF_IMM, immShelf), immFridge);
      await withOwner(client => client.query('DROP FUNCTION ci_private.zz_probe_monitor(uuid)'));

      // Catalog: the mode and the fixed search_path are exactly what the plan requires.
      const catalog = await withOwner(client => client.query<{ schema: string; proname: string; prosecdef: boolean; proconfig: string[] | null; authenticated_exec: boolean; anon_exec: boolean }>(`
        SELECT n.nspname AS schema, p.proname, p.prosecdef, p.proconfig,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = ANY($1::text[]) ORDER BY n.nspname, p.proname`, [[
        'environment_monitor_location_id', 'ci_environment_monitor_location_id', 'guard_location_hierarchy', 'guard_location_code', 'next_updated_at',
        'lock_location_for_supervisor', 'apply_location_env_config', 'ci_create_location_v2', 'ci_update_location', 'ci_set_location_active',
        'ci_rotate_location_qr_token', 'ci_set_location_env_config']]));
      const fn = (schema: string, name: string) => catalog.rows.find(row => row.schema === schema && row.proname === name)!;
      assert.ok(fn('ci_private', 'environment_monitor_location_id').prosecdef, 'the resolver is SECURITY DEFINER');
      assert.ok(fn('ci_private', 'environment_monitor_location_id').proconfig?.includes('search_path=""'));
      assert.equal(fn('ci_private', 'environment_monitor_location_id').authenticated_exec, false, 'the private implementation is not directly callable by users');
      for (const helper of ['guard_location_hierarchy', 'guard_location_code', 'next_updated_at', 'lock_location_for_supervisor', 'apply_location_env_config']) {
        assert.ok(fn('ci_private', helper).proconfig?.includes('search_path=""'), `${helper} fixes its search_path`);
        assert.equal(fn('ci_private', helper).authenticated_exec, false, `${helper} is not executable by users`);
      }
      for (const name of ['ci_environment_monitor_location_id', 'ci_create_location_v2', 'ci_update_location', 'ci_set_location_active', 'ci_rotate_location_qr_token', 'ci_set_location_env_config']) {
        const priv = fn('ci_private', name); const pub = fn('public', name);
        assert.ok(priv.prosecdef, `${name} implementation is SECURITY DEFINER`);
        assert.ok(priv.proconfig?.includes('search_path=""'));
        assert.equal(pub.prosecdef, false, `${name} public wrapper is SECURITY INVOKER`);
        assert.ok(pub.proconfig?.includes('search_path=""'));
        assert.equal(pub.anon_exec, false, `${name} is not executable by anon`);
        assert.equal(pub.authenticated_exec, true);
      }
      assert.equal(catalog.rows.filter(row => row.schema === 'public' && row.prosecdef).length, 0, 'no SECURITY DEFINER implementation appears in public');
    });

    await t.test('QR tokens: random, unique, resolved under RLS, revoked by rotation, audited', async () => {
      const tokens = await rows<{ qr_token: string }>(ADMIN, 'SELECT qr_token FROM public.ci_locations');
      assert.ok(tokens.length > 10);
      assert.ok(tokens.every(row => /^[0-9a-f]{32}$/.test(row.qr_token)));
      assert.equal(new Set(tokens.map(row => row.qr_token)).size, tokens.length);
      const target = cheShelf;
      const before = (await one<{ qr_token: string }>(SUP_CHE, 'SELECT qr_token FROM public.ci_locations WHERE id = $1', [target])).qr_token;
      const lookup = (user: string, token: string) => rows<{ id: string }>(user, 'SELECT id FROM public.ci_locations WHERE qr_token = $1', [token]);
      assert.deepEqual((await lookup(VIEWER_CHE, before)).map(row => row.id), [target], 'any reader of the warehouse resolves the token');
      assert.equal((await lookup(SUP_IMM, before)).length, 0, 'another warehouse resolves nothing');
      assert.equal((await lookup(NO_ACCESS, before)).length, 0);

      await assert.rejects(() => rotate(STAFF_CHE, target, 'not allowed'), /CI_ACCESS_DENIED/);
      await assert.rejects(() => rotate(SUP_IMM, target, 'wrong warehouse'), /CI_ACCESS_DENIED/);
      await assert.rejects(() => rotate(SUP_CHE, target, '  '), /CI_REASON_REQUIRED/);
      await rotate(SUP_CHE, target, 'label peeled off');
      const after = await one<{ qr_token: string; qr_token_rotated_at: string | null }>(SUP_CHE, 'SELECT qr_token, qr_token_rotated_at::text FROM public.ci_locations WHERE id = $1', [target]);
      assert.notEqual(after.qr_token, before); assert.match(after.qr_token, /^[0-9a-f]{32}$/); assert.ok(after.qr_token_rotated_at);
      assert.equal((await lookup(SUP_CHE, before)).length, 0, 'the old printed QR no longer resolves');
      assert.equal((await lookup(SUP_CHE, after.qr_token)).length, 1);
      const audit = await rows<{ reason: string }>(ADMIN, `SELECT reason FROM public.ci_audit_logs WHERE entity_table = 'ci_locations' AND entity_id = $1 AND action = 'QR_ROTATE'`, [target]);
      assert.deepEqual(audit.map(row => row.reason), ['label peeled off']);
      const trail = await rows<{ old_value: { qr_token: string }; new_value: { qr_token: string } }>(ADMIN, `SELECT old_value, new_value FROM public.ci_audit_logs WHERE entity_table = 'ci_locations' AND entity_id = $1 AND action = 'UPDATE' AND new_value->>'qr_token' = $2`, [target, after.qr_token]);
      assert.equal(trail.length, 1); assert.equal(trail[0].old_value.qr_token, before);
      await withOwner(async (client) => {
        await assert.rejects(() => client.query(`UPDATE public.ci_locations SET qr_token = 'not-a-token' WHERE id = $1`, [target]), /ci_locations_qr_token_format_chk/);
        await assert.rejects(() => client.query(`UPDATE public.ci_locations SET qr_token = $1 WHERE id = $2`, [tokens[0].qr_token, target]), /ci_locations_qr_token_key/);
      });
    });

    await t.test('migration hygiene: no session-level SET LOCAL/search_path, and every reference is schema-qualified', async () => {
      const file = (await migrationFiles()).find(name => name.endsWith('_ci_location_master.sql'))!;
      const sql = await readFile(path.join(process.cwd(), 'supabase/migrations', file), 'utf8');
      assert.doesNotMatch(sql, /set\s+local/i, 'SET LOCAL breaks outside a transaction block');
      assert.doesNotMatch(sql, /^\s*set\s+(session\s+)?search_path/im, 'no statement-level search_path change');
      assert.doesNotMatch(sql, /\b(from|join|into|update|table)\s+ci_[a-z_]+/i, 'table references must be schema-qualified');
      const functionCount = (sql.match(/^create function /gm) ?? []).length;
      const hardened = (sql.match(/set search_path = ''/g) ?? []).length;
      assert.ok(hardened >= functionCount, 'every function declares its own search_path');
      const previous = (await migrationFiles()).filter(name => name < file);
      assert.ok(previous.length >= 16, 'the earlier migrations are still present');
    });
  } finally {
    const cleanup = new Client({ connectionString: adminUrl.toString() });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await cleanup.query(`DROP DATABASE IF EXISTS ${backfillDbName} WITH (FORCE)`); } finally { await cleanup.end(); }
  }
});
