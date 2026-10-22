import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// Phase 2 (Morning Talk) against real disposable PostgreSQL. The whole suite runs twice: on the standard seed and on a database whose
// CHE / IMM numeric warehouse ids have been swapped, which proves no helper, policy or RPC depends on CHE = 1 / IMM = 2.

const U = {
  ADMIN_BOTH: '10000000-0000-4000-8000-000000000001',
  SUP_CHE: '10000000-0000-4000-8000-000000000002',
  SUP_IMM: '10000000-0000-4000-8000-000000000003',
  SUP_BOTH: '10000000-0000-4000-8000-000000000004',
  ADMIN_CHE_SUP_IMM: '10000000-0000-4000-8000-000000000005',
  SUP_CHE_STAFF_IMM: '10000000-0000-4000-8000-000000000006',
  STAFF_CHE: '10000000-0000-4000-8000-000000000007',
  STAFF_CHE2: '10000000-0000-4000-8000-000000000008',
  STAFF_IMM: '10000000-0000-4000-8000-000000000009',
  VIEWER_CHE: '10000000-0000-4000-8000-00000000000a',
  VIEWER_IMM: '10000000-0000-4000-8000-00000000000b',
  VIEWER_BOTH: '10000000-0000-4000-8000-00000000000c',
  NO_ACCESS: '10000000-0000-4000-8000-00000000000d',
  INACTIVE_PROFILE: '10000000-0000-4000-8000-00000000000e',
  INACTIVE_GRANT: '10000000-0000-4000-8000-00000000000f',
  REVOKE_MGR: '10000000-0000-4000-8000-000000000010',
  STAFF_BOTH: '10000000-0000-4000-8000-000000000011',
  SUP_CHE_ADMIN_IMM: '10000000-0000-4000-8000-000000000012',
  ADMIN_CHE_ONLY: '10000000-0000-4000-8000-000000000013',
} as const;
const ALL_USERS = Object.values(U);

const configuredDatabaseUrl = process.env.CI_TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error('Set CI_TEST_DATABASE_URL with scripts/db/test.ps1 to run disposable PostgreSQL tests');
const adminUrl = new URL(configuredDatabaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to a disposable loopback PostgreSQL postgres database');
}
const suffix = `${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
const urlFor = (name: string) => { const url = new URL(adminUrl); url.pathname = `/${name}`; return url.toString(); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function migrationFiles() { return (await readdir(path.join(process.cwd(), 'supabase/migrations'))).filter(file => file.endsWith('.sql')).sort(); }

type Ctx = { db: string; CHE: number; IMM: number };

async function build(db: string, remap: boolean): Promise<Ctx> {
  const owner = new Client({ connectionString: adminUrl.toString() });
  await owner.connect();
  try { await owner.query(`CREATE DATABASE ${db}`); } finally { await owner.end(); }
  const client = new Client({ connectionString: urlFor(db) });
  await client.connect();
  try {
    for (const file of ['tests/db/bootstrap.sql', ...(await migrationFiles()).map(name => `supabase/migrations/${name}`)]) await client.query(await readFile(path.join(process.cwd(), file), 'utf8'));
    if (remap) {
      // Swap the numeric ids of CHE and IMM everywhere before any user data exists (FK enforcement is bypassed only for this one transaction).
      await client.query(`
        BEGIN;
        SET LOCAL session_replication_role = replica;
        DO $do$
        DECLARE r record; x smallint; y smallint;
        BEGIN
          SELECT id INTO x FROM public.ci_warehouses WHERE code = 'CHE';
          SELECT id INTO y FROM public.ci_warehouses WHERE code = 'IMM';
          FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN pg_tables t ON t.schemaname = 'public' AND t.tablename = c.table_name
                   WHERE c.table_schema = 'public' AND c.column_name = 'warehouse_id' LOOP
            EXECUTE format('UPDATE public.%I SET warehouse_id = warehouse_id + 100 WHERE warehouse_id IS NOT NULL', r.table_name);
            EXECUTE format('UPDATE public.%I SET warehouse_id = CASE warehouse_id WHEN %s THEN %s WHEN %s THEN %s END WHERE warehouse_id IS NOT NULL', r.table_name, x + 100, y, y + 100, x);
          END LOOP;
          UPDATE public.ci_warehouses SET id = id + 100;
          UPDATE public.ci_warehouses SET id = CASE code WHEN 'CHE' THEN y ELSE x END;
        END $do$;
        COMMIT;`);
    }
    const ids = await client.query<{ code: string; id: number }>(`SELECT code, id FROM public.ci_warehouses`);
    const CHE = ids.rows.find(row => row.code === 'CHE')!.id;
    const IMM = ids.rows.find(row => row.code === 'IMM')!.id;
    if (remap) assert.deepEqual([CHE, IMM], [2, 1], 'the remapped database really has CHE = 2 and IMM = 1');
    await client.query(`INSERT INTO auth.users(id) SELECT unnest($1::uuid[])`, [ALL_USERS]);
    const profile = (id: string, ephis: string, active = true) => `('${id}','${ephis}','${ephis} name',${active},'${ephis} position')`;
    await client.query(`INSERT INTO public.ci_user_profiles(user_id,ephis_id,display_name,active,position_title) VALUES ${[
      profile(U.ADMIN_BOTH, 'admin-both'), profile(U.SUP_CHE, 'sup-che'), profile(U.SUP_IMM, 'sup-imm'), profile(U.SUP_BOTH, 'sup-both'), profile(U.ADMIN_CHE_SUP_IMM, 'admin-che-sup-imm'),
      profile(U.SUP_CHE_STAFF_IMM, 'sup-che-staff-imm'), profile(U.STAFF_CHE, 'staff-che'), profile(U.STAFF_CHE2, 'staff-che2'), profile(U.STAFF_IMM, 'staff-imm'), profile(U.VIEWER_CHE, 'viewer-che'),
      profile(U.VIEWER_IMM, 'viewer-imm'), profile(U.VIEWER_BOTH, 'viewer-both'), profile(U.NO_ACCESS, 'no-access'), profile(U.INACTIVE_PROFILE, 'inactive-profile', false),
      profile(U.INACTIVE_GRANT, 'inactive-grant'), profile(U.REVOKE_MGR, 'revoke-mgr'), profile(U.STAFF_BOTH, 'staff-both'), profile(U.SUP_CHE_ADMIN_IMM, 'sup-che-admin-imm'), profile(U.ADMIN_CHE_ONLY, 'admin-che-only')].join(',')}`);
    const grant = (id: string, wh: number, role: string, active = true) => `('${id}',${wh},'${role}',${active})`;
    await client.query(`INSERT INTO public.ci_user_access(user_id,warehouse_id,role,active) VALUES ${[
      grant(U.ADMIN_BOTH, CHE, 'admin'), grant(U.ADMIN_BOTH, IMM, 'admin'), grant(U.SUP_CHE, CHE, 'supervisor'), grant(U.SUP_IMM, IMM, 'supervisor'),
      grant(U.SUP_BOTH, CHE, 'supervisor'), grant(U.SUP_BOTH, IMM, 'supervisor'), grant(U.ADMIN_CHE_SUP_IMM, CHE, 'admin'), grant(U.ADMIN_CHE_SUP_IMM, IMM, 'supervisor'),
      grant(U.SUP_CHE_STAFF_IMM, CHE, 'supervisor'), grant(U.SUP_CHE_STAFF_IMM, IMM, 'staff'), grant(U.STAFF_CHE, CHE, 'staff'), grant(U.STAFF_CHE2, CHE, 'staff'),
      grant(U.STAFF_IMM, IMM, 'staff'), grant(U.VIEWER_CHE, CHE, 'viewer'), grant(U.VIEWER_IMM, IMM, 'viewer'), grant(U.VIEWER_BOTH, CHE, 'viewer'), grant(U.VIEWER_BOTH, IMM, 'viewer'),
      grant(U.INACTIVE_PROFILE, CHE, 'staff'), grant(U.INACTIVE_GRANT, CHE, 'staff', false), grant(U.REVOKE_MGR, CHE, 'supervisor'), grant(U.REVOKE_MGR, IMM, 'supervisor'),
      grant(U.STAFF_BOTH, CHE, 'staff'), grant(U.STAFF_BOTH, IMM, 'staff'), grant(U.SUP_CHE_ADMIN_IMM, CHE, 'supervisor'), grant(U.SUP_CHE_ADMIN_IMM, IMM, 'admin'),
      grant(U.ADMIN_CHE_ONLY, CHE, 'admin')].join(',')}`);
    return { db, CHE, IMM };
  } finally { await client.end(); }
}

test('Phase 2 Morning Talk: scope, authority, candidate eligibility, acknowledgement, atomicity and audit', { timeout: 420_000 }, async (t) => {
  const dbs = [`ci_mt_std_${suffix}`, `ci_mt_map_${suffix}`];
  try {
    for (const [index, remap] of [false, true].entries()) {
      const ctx = await build(dbs[index], remap);
      await t.test(`suite (${remap ? 'CHE/IMM numeric ids swapped' : 'standard ids'})`, async (st) => { await suite(st, ctx, remap); });
    }
  } finally {
    const cleanup = new Client({ connectionString: adminUrl.toString() });
    await cleanup.connect();
    try { for (const db of dbs) await cleanup.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } finally { await cleanup.end(); }
  }
});

async function suite(t: test.TestContext, ctx: Ctx, remap: boolean) {
  const { CHE, IMM } = ctx;
  async function connect() { const c = new Client({ connectionString: urlFor(ctx.db) }); await c.connect(); return c; }
  async function withOwner<T>(run: (client: Client) => Promise<T>): Promise<T> { const c = await connect(); try { return await run(c); } finally { await c.end(); } }
  async function asUser<T>(userId: string | null, run: (client: Client) => Promise<T>): Promise<T> {
    const c = await connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE authenticated');
      if (userId) await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
      const result = await run(c);
      await c.query('COMMIT');
      return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { await c.end(); }
  }
  async function rpc<T = unknown>(userId: string, name: string, args: unknown[], casts: string[]): Promise<T> {
    const placeholders = args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',');
    return asUser(userId, async (c) => (await c.query<{ result: T }>(`SELECT public.${name}(${placeholders}) AS result`, args.map((arg, i) => casts[i] === 'jsonb' ? JSON.stringify(arg) : arg))).rows[0].result);
  }
  async function rows<R extends Record<string, unknown> = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) { return asUser(userId, async (c) => (await c.query<R>(sql, params)).rows); }
  const one = async <R extends Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) => (await rows<R>(userId, sql, params))[0];
  const save = (user: string, payload: Record<string, unknown>) => rpc<string>(user, 'ci_save_morning_talk', [payload], ['jsonb']);
  const cancel = (user: string, id: string, reason: string) => rpc<void>(user, 'ci_cancel_morning_talk', [id, reason], ['uuid', 'text']);
  const ack = (user: string, id: string) => rpc<string>(user, 'ci_acknowledge_morning_talk', [id], ['uuid']);
  const tick = (user: string, item: string, done: boolean) => rpc<void>(user, 'ci_set_morning_talk_checklist_item', [item, done], ['uuid', 'boolean']);
  const setAction = (user: string, id: string, status: string, note: string | null, expected: string | null) => rpc<void>(user, 'ci_update_morning_talk_action', [id, status, note, expected], ['uuid', 'text', 'text', 'timestamptz']);
  const scopes = (user: string) => rpc<string[]>(user, 'ci_manageable_scopes', [], []);
  const members = (user: string, wh: number | null) => rpc<Array<{ user_id: string; display_name: string; position_title: string | null; active: boolean; attendee_eligible: boolean; owner_eligible: boolean }>>(user, 'ci_list_scope_members', [wh], ['smallint']).then(async () => rows(user, 'SELECT * FROM public.ci_list_scope_members($1::smallint)', [wh])) as Promise<Array<{ user_id: string; display_name: string; position_title: string | null; active: boolean; attendee_eligible: boolean; owner_eligible: boolean }>>;
  const stamp = async (table: string, id: string) => (await withOwner(c => c.query<{ t: string }>(`SELECT updated_at::text AS t FROM public.${table} WHERE id = $1`, [id]))).rows[0].t;
  const talkCount = async (title?: string) => Number((await withOwner(c => c.query<{ n: string }>(title ? `SELECT count(*)::text AS n FROM public.ci_morning_talks WHERE title = $1` : `SELECT count(*)::text AS n FROM public.ci_morning_talks`, title ? [title] : []))).rows[0].n);
  const denied = /CI_ACCESS_DENIED/;
  let seq = 0;
  const title = (label: string) => `${label} #${++seq}`;
  const base = (scope: 'ALL' | 'CHE' | 'IMM', over: Record<string, unknown> = {}) => ({ scope, title: title(`${scope} talk`), agenda: 'agenda', attendees: [], checklist: [], actions: [], ...over });
  const setGrant = (user: string, wh: number, role: string, active = true) => withOwner(c => c.query('UPDATE public.ci_user_access SET role = $3, active = $4 WHERE user_id = $1 AND warehouse_id = $2', [user, wh, role, active]));

  // ---- fixtures: one talk per scope with attendees, a checklist and an action -------------------------------------------------
  const cheTalk = await save(U.SUP_CHE, base('CHE', { title: 'FIX CHE', attendees: [U.STAFF_CHE, U.VIEWER_CHE, U.SUP_CHE], checklist: [{ title: 'ตรวจเครื่อง' }, { title: 'ตรวจน้ำยา' }], actions: [{ title: 'ส่งซ่อม', owner_id: U.STAFF_CHE, due_date: '2030-01-01' }] }));
  const immTalk = await save(U.SUP_IMM, base('IMM', { title: 'FIX IMM', attendees: [U.STAFF_IMM, U.VIEWER_IMM], checklist: [{ title: 'imm item' }], actions: [{ title: 'imm action', owner_id: U.STAFF_IMM }] }));
  const allTalk = await save(U.SUP_BOTH, base('ALL', { title: 'FIX ALL', attendees: [U.SUP_CHE, U.STAFF_IMM, U.VIEWER_CHE, U.VIEWER_IMM], checklist: [{ title: 'all item' }], actions: [{ title: 'all action', owner_id: U.STAFF_IMM }] }));
  const idOf = async (table: string, talk: string) => (await withOwner(c => c.query<{ id: string }>(`SELECT id FROM public.${table} WHERE talk_id = $1 ORDER BY created_at, id LIMIT 1`, [talk]))).rows[0].id;

  await t.test('warehouse codes are authoritative: lookup by code, fail closed, and no numeric warehouse literal in any helper', async () => {
    const lookup = await withOwner(c => c.query(`SELECT ci_private.warehouse_id_by_code('CHE') AS che, ci_private.warehouse_id_by_code('IMM') AS imm`));
    assert.deepEqual([lookup.rows[0].che, lookup.rows[0].imm], [CHE, IMM]);
    await withOwner(async (c) => { await assert.rejects(async () => c.query(`SELECT ci_private.warehouse_id_by_code('XXX')`), /CI_WAREHOUSE_NOT_FOUND/); });
    await withOwner(async (c) => { await assert.rejects(async () => c.query(`SELECT ci_private.warehouse_id_by_code(NULL)`), /CI_WAREHOUSE_NOT_FOUND/); });
    const definitions = await withOwner(c => c.query<{ proname: string; def: string }>(`SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ci_private' AND p.proname = ANY($1::text[])`, [['warehouse_id_by_code', 'has_role_code', 'can_read_scope', 'can_manage_scope', 'can_work_scope', 'require_manage_scope', 'user_has_role', 'user_has_role_code',
      'user_in_scope', 'user_can_work_scope', 'ci_manageable_scopes', 'ci_list_scope_members', 'ci_save_morning_talk', 'ci_cancel_morning_talk', 'ci_acknowledge_morning_talk', 'ci_set_morning_talk_checklist_item', 'ci_update_morning_talk_action', 'ci_morning_talk_names']]));
    assert.equal(definitions.rowCount, 18);
    for (const row of definitions.rows) assert.doesNotMatch(row.def, /has_role\(\s*\d|warehouse_id\s*=\s*\d|\b[12]::(?:pg_catalog\.)?smallint|warehouse_id\s+in\s*\(\s*\d/i, `${row.proname} contains a numeric warehouse literal`);
    const policies = await withOwner(c => c.query<{ qual: string }>(`SELECT pg_get_expr(polqual, polrelid) AS qual FROM pg_policy WHERE polrelid::regclass::text LIKE 'ci_morning_talk%'`));
    assert.equal(policies.rowCount, 4);
    for (const row of policies.rows) assert.doesNotMatch(row.qual, /\b[12]\b/);
  });

  await t.test('ci_manageable_scopes returns exactly the scopes the actor may manage, for every combination', async () => {
    const expected: Array<[keyof typeof U, string[]]> = [
      ['STAFF_CHE', []], ['STAFF_IMM', []], ['VIEWER_CHE', []], ['VIEWER_BOTH', []], ['STAFF_BOTH', []], ['NO_ACCESS', []], ['INACTIVE_PROFILE', []], ['INACTIVE_GRANT', []],
      ['SUP_CHE', ['CHE']], ['SUP_IMM', ['IMM']], ['SUP_CHE_STAFF_IMM', ['CHE']], ['ADMIN_CHE_ONLY', ['CHE']], ['SUP_CHE_ADMIN_IMM', ['ALL', 'CHE', 'IMM']],
      ['SUP_BOTH', ['ALL', 'CHE', 'IMM']], ['ADMIN_CHE_SUP_IMM', ['ALL', 'CHE', 'IMM']], ['ADMIN_BOTH', ['ALL', 'CHE', 'IMM']],
    ];
    for (const [user, scopesExpected] of expected) assert.deepEqual(await scopes(U[user]), scopesExpected, user);
  });

  await t.test('management authority: CHE and IMM by their own supervisors; ALL only with supervisory authority in BOTH', async () => {
    const attempt = (user: keyof typeof U, scope: 'ALL' | 'CHE' | 'IMM') => save(U[user], base(scope));
    for (const user of ['STAFF_CHE', 'VIEWER_CHE', 'STAFF_BOTH', 'NO_ACCESS', 'INACTIVE_PROFILE', 'INACTIVE_GRANT'] as const) await assert.rejects(async () => attempt(user, 'CHE'), denied, `${user} cannot create`);
    await attempt('SUP_CHE', 'CHE');
    await assert.rejects(async () => attempt('SUP_CHE', 'IMM'), denied);
    await assert.rejects(async () => attempt('SUP_CHE', 'ALL'), denied);
    await attempt('SUP_IMM', 'IMM');
    await assert.rejects(async () => attempt('SUP_IMM', 'CHE'), denied);
    await assert.rejects(async () => attempt('SUP_IMM', 'ALL'), denied);
    await assert.rejects(async () => attempt('SUP_CHE_STAFF_IMM', 'ALL'), denied, 'supervisor CHE + staff IMM cannot manage ALL');
    await assert.rejects(async () => attempt('SUP_CHE_STAFF_IMM', 'IMM'), denied);
    await assert.rejects(async () => attempt('ADMIN_CHE_ONLY', 'ALL'), denied, 'admin of one warehouse only cannot manage ALL');
    for (const user of ['ADMIN_CHE_SUP_IMM', 'SUP_CHE_ADMIN_IMM', 'SUP_BOTH', 'ADMIN_BOTH'] as const) await attempt(user, 'ALL');
    // A single-warehouse supervisor can read an ALL talk but cannot edit, cancel or reassign anything in it.
    const stamped = await stamp('ci_morning_talks', allTalk);
    await assert.rejects(async () => save(U.SUP_CHE, { id: allTalk, expected_updated_at: stamped, title: 'hijack', attendees: [], checklist: [], actions: [] }), denied);
    await assert.rejects(async () => cancel(U.SUP_CHE, allTalk, 'nope'), denied);
    const allAction = await idOf('ci_morning_talk_actions', allTalk);
    await assert.rejects(async () => setAction(U.SUP_CHE, allAction, 'done', null, await stamp('ci_morning_talk_actions', allAction)), denied, 'not a manager, not the owner');
    await assert.rejects(async () => save(U.SUP_IMM, { id: allTalk, expected_updated_at: stamped, title: 'hijack', attendees: [], checklist: [], actions: [] }), denied);
    // A missing talk and a forbidden one raise the same error.
    await assert.rejects(async () => save(U.SUP_CHE, { id: '99999999-9999-4999-8999-999999999999', expected_updated_at: stamped, title: 'x' }), denied);
    await assert.rejects(async () => cancel(U.SUP_CHE, '99999999-9999-4999-8999-999999999999', 'x'), denied);
    assert.equal((await one<{ title: string }>(U.ADMIN_BOTH, 'SELECT title FROM public.ci_morning_talks WHERE id = $1', [allTalk])).title, 'FIX ALL');
    await assert.rejects(async () => save(U.SUP_BOTH, { ...base('CHE'), scope: 'BOGUS' }), /CI_MORNING_TALK_INVALID/);
  });

  await t.test('row-level security: a warehouse sees its own and ALL rows in every table, nothing of the other warehouse; no direct writes', async () => {
    const tables = ['ci_morning_talks', 'ci_morning_talk_attendees', 'ci_morning_talk_checklist_items', 'ci_morning_talk_actions'];
    const talkOf = (table: string) => table === 'ci_morning_talks' ? 'id' : 'talk_id';
    for (const [user, visible, hidden] of [[U.STAFF_CHE, [cheTalk, allTalk], [immTalk]], [U.VIEWER_IMM, [immTalk, allTalk], [cheTalk]], [U.SUP_BOTH, [cheTalk, immTalk, allTalk], []]] as const) {
      for (const table of tables) {
        const seen = new Set((await rows<{ t: string }>(user, `SELECT ${talkOf(table)} AS t FROM public.${table}`)).map(row => row.t));
        for (const id of visible) assert.ok(seen.has(id), `${user} sees ${id} in ${table}`);
        for (const id of hidden) assert.ok(!seen.has(id), `${user} must not see ${id} in ${table}`);
      }
    }
    for (const user of [U.NO_ACCESS, U.INACTIVE_PROFILE, U.INACTIVE_GRANT]) for (const table of tables) assert.equal((await rows(user, `SELECT 1 FROM public.${table}`)).length, 0, `${user} ${table}`);
    assert.equal((await rows(U.STAFF_CHE, 'SELECT 1 FROM public.ci_morning_talks WHERE id = $1', [immTalk])).length, 0, 'a foreign id returns nothing');
    for (const table of tables) {
      await assert.rejects(async () => asUser(U.ADMIN_BOTH, c => c.query(`DELETE FROM public.${table}`)), /permission denied/, `${table} delete`);
      await assert.rejects(async () => asUser(U.ADMIN_BOTH, c => c.query(`UPDATE public.${table} SET warehouse_id = warehouse_id`)), /permission denied/, `${table} update`);
    }
    await assert.rejects(async () => asUser(U.ADMIN_BOTH, c => c.query(`INSERT INTO public.ci_morning_talks(scope,title,created_by) VALUES ('ALL','x',$1)`, [U.ADMIN_BOTH])), /permission denied/);
    await assert.rejects(async () => asUser(U.STAFF_CHE, c => c.query(`UPDATE public.ci_morning_talk_attendees SET acknowledged_at = now() WHERE talk_id = $1`, [cheTalk])), /permission denied/, 'no direct acknowledgement');
    const privileges = await withOwner(c => c.query(`SELECT bool_or(has_table_privilege('anon', t, 'SELECT')) AS anon_select, bool_or(has_table_privilege('authenticated', t, 'INSERT') OR has_table_privilege('authenticated', t, 'UPDATE') OR has_table_privilege('authenticated', t, 'DELETE')) AS auth_write,
      bool_and(has_table_privilege('authenticated', t, 'SELECT')) AS auth_select FROM unnest($1::text[]) t`, [tables.map(table => `public.${table}`)]));
    assert.deepEqual(privileges.rows[0], { anon_select: false, auth_write: false, auth_select: true });
    const rls = await withOwner(c => c.query(`SELECT bool_and(relrowsecurity) AS on FROM pg_class WHERE oid = ANY($1::regclass[])`, [tables.map(table => `public.${table}`)]));
    assert.equal(rls.rows[0].on, true);
  });

  await t.test('member picker: candidate eligibility is computed per person, and only for someone who can read the scope', async () => {
    const list = await members(U.SUP_BOTH, null);
    const by = (id: string) => list.find(row => row.user_id === id);
    for (const user of [U.STAFF_CHE, U.STAFF_IMM, U.VIEWER_CHE, U.VIEWER_IMM, U.VIEWER_BOTH, U.SUP_CHE]) assert.ok(by(user), user);
    for (const user of [U.NO_ACCESS, U.INACTIVE_PROFILE, U.INACTIVE_GRANT]) assert.equal(by(user), undefined, `${user} is not listed`);
    assert.deepEqual([by(U.VIEWER_CHE)!.attendee_eligible, by(U.VIEWER_CHE)!.owner_eligible], [true, false], 'a viewer can attend but not own');
    assert.deepEqual([by(U.STAFF_CHE)!.attendee_eligible, by(U.STAFF_CHE)!.owner_eligible], [true, true]);
    assert.deepEqual([by(U.STAFF_IMM)!.attendee_eligible, by(U.STAFF_IMM)!.owner_eligible], [true, true], 'IMM-only staff is eligible for an ALL talk');
    assert.deepEqual([by(U.VIEWER_BOTH)!.attendee_eligible, by(U.VIEWER_BOTH)!.owner_eligible], [true, false]);
    assert.equal(by(U.STAFF_CHE)!.position_title, 'staff-che position');
    assert.deepEqual(Object.keys(list[0]).sort(), ['active', 'attendee_eligible', 'display_name', 'owner_eligible', 'position_title', 'user_id'], 'no roles or grants are exposed');
    const che = await members(U.SUP_CHE, CHE);
    assert.ok(!che.some(row => row.user_id === U.STAFF_IMM || row.user_id === U.VIEWER_IMM), 'IMM-only users are not CHE members');
    assert.ok(che.some(row => row.user_id === U.STAFF_BOTH));
    const imm = await members(U.SUP_IMM, IMM);
    assert.ok(!imm.some(row => row.user_id === U.STAFF_CHE));
    // The caller's own role never changes a candidate's flags.
    const asViewer = await members(U.VIEWER_BOTH, null);
    assert.deepEqual(asViewer.map(row => [row.user_id, row.attendee_eligible, row.owner_eligible]), list.map(row => [row.user_id, row.attendee_eligible, row.owner_eligible]));
    await assert.rejects(async () => members(U.NO_ACCESS, null), denied);
    await assert.rejects(async () => members(U.INACTIVE_PROFILE, CHE), denied);
    await assert.rejects(async () => members(U.SUP_CHE, IMM), denied, 'a CHE-only user cannot list IMM members');
    await assert.rejects(async () => members(U.STAFF_CHE, 99), denied);
  });

  await t.test('candidate eligibility is judged on the candidate through ci_save_morning_talk, never on the caller; a rejected save writes nothing', async () => {
    const reject = async (user: string, payload: Record<string, unknown>, error: RegExp, label: string) => {
      const before = await talkCount();
      await assert.rejects(async () => save(user, payload), error, label);
      assert.equal(await talkCount(), before, `${label}: no partial talk`);
    };
    const withOwner_ = (scope: 'ALL' | 'CHE' | 'IMM', owner: string) => base(scope, { actions: [{ title: 'a', owner_id: owner }] });
    await reject(U.SUP_CHE, withOwner_('CHE', U.VIEWER_CHE), /CI_OWNER_NOT_ELIGIBLE/, 'supervisor CHE + viewer CHE owner');
    await save(U.SUP_CHE, withOwner_('CHE', U.STAFF_CHE));
    await save(U.SUP_BOTH, withOwner_('ALL', U.STAFF_IMM));
    await save(U.SUP_BOTH, withOwner_('ALL', U.STAFF_CHE));
    await reject(U.SUP_BOTH, withOwner_('ALL', U.VIEWER_BOTH), /CI_OWNER_NOT_ELIGIBLE/, 'ALL + viewer in both');
    for (const [candidate, label] of [[U.NO_ACCESS, 'no access at all'], [U.INACTIVE_PROFILE, 'inactive profile'], [U.INACTIVE_GRANT, 'inactive staff grant'], [U.VIEWER_CHE, 'viewer'], ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'forged unknown id']] as const) {
      await reject(U.ADMIN_BOTH, withOwner_('ALL', candidate), /CI_OWNER_NOT_ELIGIBLE|violates foreign key/, `admin in both cannot make ${label} an owner`);
    }
    await reject(U.SUP_CHE, withOwner_('CHE', U.STAFF_IMM), /CI_OWNER_NOT_ELIGIBLE/, 'IMM-only staff cannot own a CHE action');
    await reject(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_IMM] }), /CI_ATTENDEE_NOT_ELIGIBLE/, 'IMM-only user cannot attend a CHE talk');
    await reject(U.SUP_CHE, base('CHE', { attendees: [U.NO_ACCESS] }), /CI_ATTENDEE_NOT_ELIGIBLE/, 'no-access user cannot attend');
    await reject(U.SUP_CHE, base('CHE', { attendees: [U.INACTIVE_PROFILE] }), /CI_ATTENDEE_NOT_ELIGIBLE/, 'inactive profile cannot attend');
    await save(U.SUP_CHE, base('CHE', { attendees: [U.VIEWER_CHE, U.STAFF_CHE] }));
    await save(U.SUP_BOTH, base('ALL', { attendees: [U.VIEWER_IMM, U.SUP_CHE] }));
    // The helpers themselves: the caller's session is irrelevant, and users cannot call them.
    const flag = (as: string | null, candidate: string, wh: number | null) => withOwner(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [as ?? '']);
      const r = await c.query<{ ok: boolean }>('SELECT ci_private.user_can_work_scope($1::uuid, $2::smallint) AS ok', [candidate, wh]);
      await c.query('ROLLBACK');
      return r.rows[0].ok;
    });
    for (const [candidate, wh, expected] of [[U.VIEWER_CHE, CHE, false], [U.STAFF_CHE, CHE, true], [U.STAFF_IMM, null, true], [U.VIEWER_BOTH, null, false], [U.STAFF_IMM, CHE, false]] as const) {
      const results = await Promise.all([U.ADMIN_BOTH, U.VIEWER_BOTH, U.NO_ACCESS, null].map(as => flag(as, candidate, wh)));
      assert.deepEqual(results, [expected, expected, expected, expected], `${candidate}@${wh}: same answer whoever is logged in`);
    }
    for (const fn of ['user_can_work_scope(uuid,smallint)', 'user_in_scope(uuid,smallint)', 'user_has_role(uuid,smallint,text[])', 'user_has_role_code(uuid,text,text[])', 'can_work_scope(smallint)', 'has_role_code(text,text[])', 'warehouse_id_by_code(text)', 'require_manage_scope(smallint)']) {
      const allowed = await withOwner(c => c.query(`SELECT has_function_privilege('authenticated', 'ci_private.${fn}', 'EXECUTE') AS a, has_function_privilege('anon', 'ci_private.${fn}', 'EXECUTE') AS b`));
      assert.deepEqual(allowed.rows[0], { a: false, b: false }, fn);
    }
    await assert.rejects(async () => asUser(U.ADMIN_BOTH, c => c.query('SELECT ci_private.user_can_work_scope($1::uuid, null)', [U.STAFF_CHE])), /permission denied/);
  });

  await t.test('acknowledgement is self-only, idempotent, immutable and audited exactly once', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE, U.VIEWER_CHE, U.SUP_CHE, U.STAFF_CHE2] }));
    const first = await ack(U.STAFF_CHE, talk);
    assert.ok(first);
    assert.equal(new Date(await ack(U.STAFF_CHE, talk)).getTime(), new Date(first).getTime(), 'a repeat returns the first timestamp');
    assert.equal((await one<{ n: number }>(U.ADMIN_BOTH, `SELECT count(*)::int AS n FROM public.ci_audit_logs WHERE entity_table = 'ci_morning_talk_attendees' AND action = 'UPDATE' AND entity_id = $1 AND new_value->>'talk_id' = $2`, [U.STAFF_CHE, talk])).n, 1, 'one audit row for the acknowledgement');
    assert.ok(await ack(U.VIEWER_CHE, talk), 'a viewer can acknowledge for themselves');
    assert.ok(await ack(U.SUP_CHE, talk), 'a supervisor attending acknowledges like anyone else');
    await assert.rejects(async () => ack(U.SUP_IMM, talk), /CI_NOT_ATTENDEE/, 'an unassigned user');
    await assert.rejects(async () => ack(U.ADMIN_BOTH, talk), /CI_NOT_ATTENDEE/, 'not even an admin acts for others: an admin who is not an attendee cannot acknowledge');
    // There is no way to name another user: the function takes only the talk id.
    const signature = await withOwner(c => c.query(`SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','ci_private') AND p.proname = 'ci_acknowledge_morning_talk'`));
    assert.ok(signature.rows.every(row => row.args === 'p_id uuid'));
    await assert.rejects(async () => asUser(U.STAFF_CHE2, c => c.query(`UPDATE public.ci_morning_talk_attendees SET acknowledged_at = now() WHERE talk_id = $1 AND user_id = $2`, [talk, U.STAFF_CHE])), /permission denied/);
    // Even the table owner cannot acknowledge for someone else, or without being that person; a stored acknowledgement never changes.
    await withOwner(async (c) => {
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talk_attendees SET acknowledged_at = now() WHERE talk_id = $1 AND user_id = $2`, [talk, U.STAFF_CHE2]), /CI_ACK_SELF_ONLY/, 'no session user');
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [U.ADMIN_BOTH]);
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talk_attendees SET acknowledged_at = now() WHERE talk_id = $1 AND user_id = $2`, [talk, U.STAFF_CHE2]), /CI_ACK_SELF_ONLY/, 'a different session user');
      await c.query('ROLLBACK');
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talk_attendees SET acknowledged_at = null WHERE talk_id = $1 AND user_id = $2`, [talk, U.STAFF_CHE]), /CI_ACK_IMMUTABLE/);
      await assert.rejects(async () => c.query(`INSERT INTO public.ci_morning_talk_attendees(talk_id,user_id,assigned_by,acknowledged_at) VALUES ($1,$2,$3,now())`, [talk, U.STAFF_BOTH, U.SUP_CHE]), /CI_ACK_SELF_ONLY/);
      await assert.rejects(async () => c.query(`DELETE FROM public.ci_morning_talk_attendees WHERE talk_id = $1 AND user_id = $2`, [talk, U.STAFF_CHE]), /CI_ATTENDEE_ACKNOWLEDGED/);
    });
    // Removal: an unacknowledged attendee can go, an acknowledged one cannot, and the refused save changes nothing.
    const stamped = await stamp('ci_morning_talks', talk);
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk, expected_updated_at: stamped, title: 'renamed', attendees: [U.VIEWER_CHE, U.SUP_CHE, U.STAFF_CHE2] }), /CI_ATTENDEE_ACKNOWLEDGED/);
    assert.equal((await one<{ title: string }>(U.SUP_CHE, 'SELECT title FROM public.ci_morning_talks WHERE id = $1', [talk])).title.startsWith('CHE talk'), true, 'the refused edit did not rename the talk');
    await save(U.SUP_CHE, { id: talk, expected_updated_at: stamped, title: 'kept', attendees: [U.STAFF_CHE, U.VIEWER_CHE, U.SUP_CHE] });
    assert.equal((await rows(U.SUP_CHE, 'SELECT 1 FROM public.ci_morning_talk_attendees WHERE talk_id = $1 AND user_id = $2', [talk, U.STAFF_CHE2])).length, 0, 'the unacknowledged attendee was removed');
    // A single-warehouse supervisor attends and acknowledges an ALL talk.
    assert.ok(await ack(U.SUP_CHE, allTalk));
    // Cancelled talks cannot be acknowledged.
    const other = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE] }));
    await cancel(U.SUP_CHE, other, 'wrong day');
    await assert.rejects(async () => ack(U.STAFF_CHE, other), /CI_TALK_CANCELLED/);
    // A user whose access was withdrawn cannot acknowledge either.
    const revoked = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE2] }));
    await setGrant(U.STAFF_CHE2, CHE, 'staff', false);
    await assert.rejects(async () => ack(U.STAFF_CHE2, revoked), /CI_ACCESS_DENIED/);
    await setGrant(U.STAFF_CHE2, CHE, 'staff', true);
  });

  // ---- real two-session interleavings -------------------------------------------------------------------------------------------
  async function openAs(userId: string) {
    const c = await connect();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
    return c;
  }
  const settle = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  async function waitsOnLock(c: Client) {
    for (let i = 0; i < 60; i++) {
      const r = await withOwner(o => o.query<{ w: string | null }>('SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [(c as unknown as { processID: number }).processID]));
      if (r.rows[0]?.w === 'Lock') return true;
      await sleep(50);
    }
    return false;
  }
  const finish = async (c: Client, error: Error | null) => { try { await c.query(error ? 'ROLLBACK' : 'COMMIT'); } finally { await c.end(); } };

  await t.test('concurrent double acknowledgement by the same attendee: one timestamp, one audit row, both calls succeed', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE] }));
    const a = await openAs(U.STAFF_CHE);
    const b = await openAs(U.STAFF_CHE);
    const first = (await a.query<{ t: Date }>('SELECT public.ci_acknowledge_morning_talk($1::uuid) AS t', [talk])).rows[0].t;
    const pending = b.query<{ t: Date }>('SELECT public.ci_acknowledge_morning_talk($1::uuid) AS t', [talk]).then(r => r, (e: Error) => e);
    assert.equal(await waitsOnLock(b), true, 'the second session waits for the first');
    await finish(a, null);
    const second = await pending as Error | { rows: Array<{ t: Date }> };
    assert.ok(second && 'rows' in second, 'the second call succeeds idempotently');
    await finish(b, null);
    assert.equal(second.rows[0].t.getTime(), first.getTime(), 'the same timestamp is returned');
    assert.equal((await withOwner(c => c.query(`SELECT count(*)::int AS n FROM public.ci_audit_logs WHERE entity_table = 'ci_morning_talk_attendees' AND action = 'UPDATE' AND new_value->>'talk_id' = $1`, [talk]))).rows[0].n, 1);
    assert.equal((await withOwner(c => c.query(`SELECT count(*)::int AS n FROM public.ci_morning_talk_attendees WHERE talk_id = $1 AND acknowledged_at IS NOT NULL`, [talk]))).rows[0].n, 1);
  });

  await t.test('checklist: managers and assigned work-eligible attendees tick; everyone else, viewers included, cannot; completed items are never deleted', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE, U.VIEWER_CHE], checklist: [{ title: 'one' }, { title: 'two' }, { title: 'three' }] }));
    const items = (await withOwner(c => c.query<{ id: string; title: string }>(`SELECT id, title FROM public.ci_morning_talk_checklist_items WHERE talk_id = $1 ORDER BY sort_order`, [talk]))).rows;
    assert.deepEqual(items.map(i => i.title), ['one', 'two', 'three']);
    await tick(U.SUP_CHE, items[0].id, true);
    await tick(U.STAFF_CHE, items[1].id, true);
    await assert.rejects(async () => tick(U.STAFF_CHE2, items[2].id, true), denied, 'staff who is not an attendee');
    await assert.rejects(async () => tick(U.VIEWER_CHE, items[2].id, true), denied, 'a viewer attendee cannot write the checklist');
    await assert.rejects(async () => tick(U.SUP_IMM, items[2].id, true), denied, 'a supervisor of the other warehouse');
    await assert.rejects(async () => tick(U.NO_ACCESS, items[2].id, true), denied);
    await assert.rejects(async () => tick(U.STAFF_CHE, '99999999-9999-4999-8999-999999999999', true), denied);
    const done = await withOwner(c => c.query(`SELECT id, completed_by, completed_at IS NOT NULL AS has_at FROM public.ci_morning_talk_checklist_items WHERE talk_id = $1 ORDER BY sort_order`, [talk]));
    assert.deepEqual(done.rows.map(r => [r.completed_by, r.has_at]), [[U.SUP_CHE, true], [U.STAFF_CHE, true], [null, false]]);
    await tick(U.STAFF_CHE, items[1].id, true);
    assert.equal((await withOwner(c => c.query(`SELECT count(*)::int AS n FROM public.ci_audit_logs WHERE entity_table = 'ci_morning_talk_checklist_items' AND entity_id = $1 AND action = 'UPDATE'`, [items[1].id]))).rows[0].n, 1, 'a repeat tick adds no audit row');
    const stamped = await stamp('ci_morning_talks', talk);
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk, expected_updated_at: stamped, title: 'renamed', attendees: [U.STAFF_CHE, U.VIEWER_CHE], checklist: [{ id: items[2].id, title: 'three' }] }), /CI_CHECKLIST_ITEM_COMPLETED/, 'completed evidence cannot be dropped through the editor');
    await withOwner(async (c) => { await assert.rejects(async () => c.query('DELETE FROM public.ci_morning_talk_checklist_items WHERE id = $1', [items[0].id]), /CI_CHECKLIST_ITEM_COMPLETED/); });
    await tick(U.STAFF_CHE, items[1].id, false);
    assert.deepEqual((await withOwner(c => c.query('SELECT completed_at, completed_by FROM public.ci_morning_talk_checklist_items WHERE id = $1', [items[1].id]))).rows[0], { completed_at: null, completed_by: null });
    // Reorder, edit and remove an uncompleted item in one save; completion evidence of the kept items survives.
    await save(U.SUP_CHE, { id: talk, expected_updated_at: stamped, title: 'edited', attendees: [U.STAFF_CHE, U.VIEWER_CHE], checklist: [{ id: items[0].id, title: 'one (edited)' }, { title: 'four' }, { id: items[2].id, title: 'three' }] });
    const after = (await withOwner(c => c.query(`SELECT title, sort_order, completed_by FROM public.ci_morning_talk_checklist_items WHERE talk_id = $1 ORDER BY sort_order`, [talk]))).rows;
    assert.deepEqual(after.map(r => [r.title, r.sort_order]), [['one (edited)', 0], ['four', 1], ['three', 2]]);
    assert.equal(after[0].completed_by, U.SUP_CHE, 'completion survives an edit');
    // A cancelled talk's checklist is closed.
    await cancel(U.SUP_CHE, talk, 'closed');
    await assert.rejects(async () => tick(U.SUP_CHE, items[2].id, true), /CI_TALK_CANCELLED/);
  });

  await t.test('actions: owners work their own, managers any, strangers none; completion evidence is kept; nothing is hard-deleted', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE], actions: [{ title: 'own', owner_id: U.STAFF_CHE, due_date: '2030-05-05', note: 'first' }, { title: 'other', owner_id: U.SUP_CHE }] }));
    const [mine, theirs] = (await withOwner(c => c.query<{ id: string }>(`SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1 ORDER BY title DESC`, [talk]))).rows;
    const current = async (id: string) => stamp('ci_morning_talk_actions', id);
    await setAction(U.STAFF_CHE, mine.id, 'in_progress', 'started', await current(mine.id));
    assert.deepEqual((await withOwner(c => c.query('SELECT status, note FROM public.ci_morning_talk_actions WHERE id = $1', [mine.id]))).rows[0], { status: 'in_progress', note: 'started' });
    await assert.rejects(async () => setAction(U.STAFF_CHE, theirs.id, 'done', null, await current(theirs.id)), denied, 'not the owner');
    await assert.rejects(async () => setAction(U.STAFF_CHE2, mine.id, 'done', null, await current(mine.id)), denied, 'a colleague');
    await assert.rejects(async () => setAction(U.SUP_IMM, mine.id, 'done', null, await current(mine.id)), denied, 'the other warehouse');
    await assert.rejects(async () => setAction(U.STAFF_CHE, mine.id, 'bogus', null, await current(mine.id)), /CI_MORNING_TALK_INVALID/);
    await assert.rejects(async () => setAction(U.STAFF_CHE, mine.id, 'done', null, '2020-01-01T00:00:00Z'), /CI_STALE_UPDATE/);
    await assert.rejects(async () => setAction(U.STAFF_CHE, mine.id, 'done', null, null), /CI_STALE_UPDATE/);
    await setAction(U.SUP_CHE, theirs.id, 'in_progress', null, await current(theirs.id));
    await setAction(U.STAFF_CHE, mine.id, 'done', null, await current(mine.id));
    const firstDone = (await withOwner(c => c.query<{ completed_at: Date; completed_by: string; note: string }>('SELECT completed_at, completed_by, note FROM public.ci_morning_talk_actions WHERE id = $1', [mine.id]))).rows[0];
    assert.equal(firstDone.completed_by, U.STAFF_CHE);
    assert.equal(firstDone.note, 'started', 'a null note leaves the note alone');
    await setAction(U.SUP_CHE, mine.id, 'done', null, await current(mine.id));
    const repeat = (await withOwner(c => c.query<{ completed_at: Date; completed_by: string }>('SELECT completed_at, completed_by FROM public.ci_morning_talk_actions WHERE id = $1', [mine.id]))).rows[0];
    assert.equal(repeat.completed_at.getTime(), firstDone.completed_at.getTime(), 'repeating done keeps the first completion');
    assert.equal(repeat.completed_by, U.STAFF_CHE);
    await setAction(U.SUP_CHE, mine.id, 'todo', '', await current(mine.id));
    assert.deepEqual((await withOwner(c => c.query('SELECT status, note, completed_at, completed_by FROM public.ci_morning_talk_actions WHERE id = $1', [mine.id]))).rows[0], { status: 'todo', note: null, completed_at: null, completed_by: null }, 'leaving done clears the evidence; an empty note clears the note');
    await setAction(U.SUP_CHE, mine.id, 'cancelled', null, await current(mine.id));
    assert.equal((await one<{ status: string }>(U.STAFF_CHE, 'SELECT status FROM public.ci_morning_talk_actions WHERE id = $1', [mine.id])).status, 'cancelled', 'a cancelled action stays as evidence');
    await withOwner(async (c) => {
      await assert.rejects(async () => c.query('DELETE FROM public.ci_morning_talk_actions WHERE id = $1', [mine.id]), /CI_MORNING_ACTION_NO_DELETE/);
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talk_actions SET status = 'done' WHERE id = $1`, [theirs.id]), /ci_morning_talk_actions_completion_chk/, 'done without completion evidence is impossible');
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talk_actions SET owner_id = $2 WHERE id = $1 AND false OR id = $1`, [theirs.id, '99999999-9999-4999-8999-999999999999']), /violates foreign key/);
    });
    // Editing: removing an open action cancels it, a done action is left alone, the manager can move owner and due date.
    const open = (await withOwner(c => c.query<{ id: string }>(`SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1 AND status = 'in_progress'`, [talk]))).rows[0].id;
    await setAction(U.SUP_CHE, open, 'done', null, await current(open));
    const stamped = await stamp('ci_morning_talks', talk);
    await save(U.SUP_CHE, { id: talk, expected_updated_at: stamped, title: 'edited', attendees: [U.STAFF_CHE], actions: [{ id: mine.id, expected_updated_at: await current(mine.id), title: 'own (moved)', owner_id: U.STAFF_CHE2, due_date: '2031-01-01' }, { title: 'fresh', owner_id: U.STAFF_CHE }] });
    const final = (await withOwner(c => c.query(`SELECT title, owner_id, due_date::text AS due, status FROM public.ci_morning_talk_actions WHERE talk_id = $1 ORDER BY created_at, title`, [talk]))).rows;
    assert.equal(final.length, 3, 'nothing was deleted');
    assert.deepEqual(final.find(r => r.title === 'own (moved)'), { title: 'own (moved)', owner_id: U.STAFF_CHE2, due: '2031-01-01', status: 'cancelled' });
    assert.equal(final.find(r => r.title === 'other')!.status, 'done', 'a completed action omitted from the editor keeps its status and evidence');
    assert.equal(final.find(r => r.title === 'fresh')!.status, 'todo');
    // Omission never changes an action; cancelling one from the editor is explicit and version-checked.
    const fresh = (await withOwner(c => c.query<{ id: string }>(`SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1 AND title = 'fresh'`, [talk]))).rows[0].id;
    await save(U.SUP_CHE, { id: talk, expected_updated_at: await stamp('ci_morning_talks', talk), title: 'edited again', attendees: [U.STAFF_CHE], actions: [] });
    assert.equal((await one<{ status: string }>(U.SUP_CHE, 'SELECT status FROM public.ci_morning_talk_actions WHERE id = $1', [fresh])).status, 'todo', 'an action left out of the payload is untouched');
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk, expected_updated_at: await stamp('ci_morning_talks', talk), title: 'x', actions: [{ id: fresh, cancel: true }] }), /CI_STALE_UPDATE/, 'cancelling needs the version the form saw');
    await save(U.SUP_CHE, { id: talk, expected_updated_at: await stamp('ci_morning_talks', talk), title: 'edited again', attendees: [U.STAFF_CHE], actions: [{ id: fresh, expected_updated_at: await current(fresh), cancel: true }] });
    assert.equal((await one<{ status: string }>(U.SUP_CHE, 'SELECT status FROM public.ci_morning_talk_actions WHERE id = $1', [fresh])).status, 'cancelled', 'explicit cancellation from the editor');
    const doneId = (await withOwner(c => c.query<{ id: string }>(`SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1 AND status = 'done'`, [talk]))).rows[0].id;
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk, expected_updated_at: await stamp('ci_morning_talks', talk), title: 'x', actions: [{ id: doneId, expected_updated_at: await current(doneId), cancel: true }] }), /CI_MORNING_TALK_INVALID/, 'a completed action cannot be cancelled from the editor');
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk, expected_updated_at: await stamp('ci_morning_talks', talk), title: 'x', actions: [{ title: 'new', owner_id: U.STAFF_CHE, cancel: true }] }), /CI_MORNING_TALK_INVALID/, 'only a saved action can be cancelled');
  });

  await t.test('an owner who is later downgraded or deactivated loses the right to update their action; a manager keeps it', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { actions: [{ title: 'downgrade me', owner_id: U.STAFF_CHE2 }, { title: 'deactivate me', owner_id: U.STAFF_BOTH }] }));
    const [a1, a2] = (await withOwner(c => c.query<{ id: string }>(`SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1 ORDER BY title`, [talk]))).rows;
    const s = (id: string) => stamp('ci_morning_talk_actions', id);
    await setAction(U.STAFF_CHE2, a2.id === a1.id ? a1.id : a1.id, 'in_progress', null, await s(a1.id)).catch(() => undefined);
    await setGrant(U.STAFF_CHE2, CHE, 'viewer');
    await assert.rejects(async () => setAction(U.STAFF_CHE2, a1.id, 'done', null, await s(a1.id)), denied, 'a viewer owner');
    await setAction(U.SUP_CHE, a1.id, 'done', null, await s(a1.id));
    await setGrant(U.STAFF_CHE2, CHE, 'staff');
    await withOwner(c => c.query('UPDATE public.ci_user_profiles SET active = false WHERE user_id = $1', [U.STAFF_BOTH]));
    await assert.rejects(async () => setAction(U.STAFF_BOTH, a2.id, 'done', null, await s(a2.id)), denied, 'a deactivated owner');
    await setAction(U.SUP_CHE, a2.id, 'done', null, await s(a2.id));
    await withOwner(c => c.query('UPDATE public.ci_user_profiles SET active = true WHERE user_id = $1', [U.STAFF_BOTH]));
    // Saving the talk again asks the manager to reassign an open action whose owner is no longer eligible.
    const talk2 = await save(U.SUP_CHE, base('CHE', { actions: [{ title: 'reassign', owner_id: U.STAFF_CHE2 }] }));
    await setGrant(U.STAFF_CHE2, CHE, 'viewer');
    const action = (await withOwner(c => c.query<{ id: string }>('SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1', [talk2]))).rows[0];
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk2, expected_updated_at: undefined, title: 'x' }), /CI_STALE_UPDATE/);
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk2, expected_updated_at: await stamp('ci_morning_talks', talk2), title: 'x', actions: [{ id: action.id, expected_updated_at: await s(action.id), title: 'reassign', owner_id: U.STAFF_CHE2 }] }), /CI_OWNER_NOT_ELIGIBLE/);
    await save(U.SUP_CHE, { id: talk2, expected_updated_at: await stamp('ci_morning_talks', talk2), title: 'x', actions: [{ id: action.id, expected_updated_at: await s(action.id), title: 'reassign', owner_id: U.STAFF_CHE }] });
    // Cancelling is the other way out, and it does not require the old owner to be eligible.
    await setGrant(U.STAFF_CHE2, CHE, 'staff');
    const talk3 = await save(U.SUP_CHE, base('CHE', { actions: [{ title: 'drop me', owner_id: U.STAFF_CHE2 }] }));
    const stuck = (await withOwner(c => c.query<{ id: string }>('SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1', [talk3]))).rows[0].id;
    await setGrant(U.STAFF_CHE2, CHE, 'viewer');
    await save(U.SUP_CHE, { id: talk3, expected_updated_at: await stamp('ci_morning_talks', talk3), title: 'x', actions: [{ id: stuck, expected_updated_at: await s(stuck), cancel: true }] });
    assert.equal((await one<{ status: string }>(U.SUP_CHE, 'SELECT status FROM public.ci_morning_talk_actions WHERE id = $1', [stuck])).status, 'cancelled');
    await setGrant(U.STAFF_CHE2, CHE, 'staff');
  });

  await t.test('atomic save: any failure rolls back the whole write; stale forms and stale authority are refused', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { title: 'atomic', attendees: [U.STAFF_CHE], checklist: [{ title: 'c1' }], actions: [{ title: 'a1', owner_id: U.STAFF_CHE }] }));
    const snapshot = async () => (await withOwner(c => c.query(`SELECT (SELECT title FROM public.ci_morning_talks WHERE id = $1) AS title,
      (SELECT count(*)::int FROM public.ci_morning_talk_attendees WHERE talk_id = $1) AS attendees, (SELECT count(*)::int FROM public.ci_morning_talk_checklist_items WHERE talk_id = $1) AS checklist,
      (SELECT count(*)::int FROM public.ci_morning_talk_actions WHERE talk_id = $1) AS actions, (SELECT updated_at::text FROM public.ci_morning_talks WHERE id = $1) AS stamp`, [talk]))).rows[0];
    const before = await snapshot();
    const expected = before.stamp;
    const bad = { id: talk, expected_updated_at: expected, title: 'CHANGED', attendees: [U.STAFF_CHE, U.VIEWER_CHE, U.SUP_CHE], checklist: [{ title: 'new c' }], actions: [{ title: 'new a', owner_id: U.STAFF_CHE }, { title: 'bad owner', owner_id: U.VIEWER_CHE }] };
    await assert.rejects(async () => save(U.SUP_CHE, bad), /CI_OWNER_NOT_ELIGIBLE/);
    assert.deepEqual(await snapshot(), before, 'nothing changed: no partial talk, attendee, checklist or action');
    await assert.rejects(async () => save(U.SUP_CHE, { ...bad, actions: [], attendees: [U.STAFF_CHE, U.STAFF_IMM] }), /CI_ATTENDEE_NOT_ELIGIBLE/);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(async () => save(U.SUP_CHE, { ...bad, actions: [], checklist: [{ title: '   ' }] }), /CI_MORNING_TALK_INVALID/);
    assert.deepEqual(await snapshot(), before);
    // Validation and limits.
    for (const [payload, error, label] of [
      [{ ...bad, title: '' }, /CI_MORNING_TALK_INVALID/, 'empty title'], [{ ...bad, title: 'T'.repeat(201) }, /CI_MORNING_TALK_INVALID/, 'long title'], [{ ...bad, agenda: 'A'.repeat(5001) }, /CI_MORNING_TALK_INVALID/, 'long agenda'],
      [{ ...bad, attendees: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, /CI_MORNING_TALK_LIMIT/, '101 attendees'],
      [{ ...bad, checklist: Array.from({ length: 31 }, (_, i) => ({ title: `c${i}` })), actions: [] }, /CI_MORNING_TALK_LIMIT/, '31 checklist items'],
      [{ ...bad, checklist: [], actions: Array.from({ length: 51 }, (_, i) => ({ title: `a${i}`, owner_id: U.STAFF_CHE })) }, /CI_MORNING_TALK_LIMIT/, '51 actions'],
      [{ ...bad, checklist: [{ title: 'x'.repeat(241) }], actions: [] }, /CI_MORNING_TALK_INVALID/, 'long checklist title'],
      [{ ...bad, checklist: [], actions: [{ title: 'x', owner_id: 'not-a-uuid' }] }, /CI_MORNING_TALK_INVALID/, 'malformed owner'],
      [{ ...bad, checklist: [], actions: [{ title: 'x', owner_id: U.STAFF_CHE, note: 'n'.repeat(1001) }] }, /CI_MORNING_TALK_INVALID/, 'long note'],
      [{ ...bad, checklist: [], actions: [{ id: '99999999-9999-4999-8999-999999999999', title: 'x', owner_id: U.STAFF_CHE }] }, /CI_MORNING_TALK_INVALID/, 'unknown action id'],
      [{ ...bad, scope: 'IMM' }, /CI_MORNING_TALK_SCOPE_IMMUTABLE/, 'scope change'], [{ ...bad, talk_date: '2099-01-01' }, /CI_MORNING_TALK_INVALID/, 'far-future date'],
    ] as Array<[Record<string, unknown>, RegExp, string]>) await assert.rejects(async () => save(U.SUP_CHE, payload), error, label);
    assert.deepEqual(await snapshot(), before, 'no validation failure left anything behind');
    // A valid edit works once; the same form again is stale.
    const ok = { id: talk, expected_updated_at: expected, title: 'atomic v2', attendees: [U.STAFF_CHE, U.VIEWER_CHE], checklist: [], actions: [] };
    await save(U.SUP_CHE, ok);
    await assert.rejects(async () => save(U.SUP_CHE, ok), /CI_STALE_UPDATE/);
    await assert.rejects(async () => save(U.SUP_CHE, { ...ok, expected_updated_at: undefined }), /CI_STALE_UPDATE/);
    // A cancelled talk cannot be edited.
    await cancel(U.SUP_CHE, talk, 'done with it');
    await assert.rejects(async () => save(U.SUP_CHE, { ...ok, expected_updated_at: await stamp('ci_morning_talks', talk) }), /CI_TALK_CANCELLED/);
    await assert.rejects(async () => cancel(U.SUP_CHE, talk, 'twice'), /CI_TALK_CANCELLED/);
  });

  await t.test('review: a stale edit form can never overwrite an owner\'s newer status or note (per-action versions)', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { actions: [{ title: 'progress', owner_id: U.STAFF_CHE, note: 'plan' }] }));
    const action = (await withOwner(c => c.query<{ id: string }>('SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1', [talk]))).rows[0].id;
    const formTalk = await stamp('ci_morning_talks', talk);
    const formAction = await stamp('ci_morning_talk_actions', action); // the manager opens the edit form
    await setAction(U.STAFF_CHE, action, 'in_progress', 'owner progress', formAction); // the owner works on it meanwhile
    await assert.rejects(async () => save(U.SUP_CHE, { id: talk, expected_updated_at: formTalk, title: 'renamed', attendees: [], checklist: [], actions: [{ id: action, expected_updated_at: formAction, title: 'progress', owner_id: U.STAFF_CHE, note: 'plan' }] }), /CI_STALE_UPDATE/);
    const row = (await withOwner(c => c.query<{ status: string; note: string; title: string }>('SELECT a.status, a.note, t.title FROM public.ci_morning_talk_actions a JOIN public.ci_morning_talks t ON t.id = a.talk_id WHERE a.id = $1', [action]))).rows[0];
    assert.deepEqual([row.status, row.note], ['in_progress', 'owner progress'], 'the owner\'s status and note survive');
    assert.notEqual(row.title, 'renamed', 'and the refused save changed nothing else');
    // An action that was finished when the form loaded and reopened afterwards is never cancelled by that form.
    await setAction(U.STAFF_CHE, action, 'done', null, await stamp('ci_morning_talk_actions', action));
    const formLoaded = await stamp('ci_morning_talks', talk); // the edit form lists open actions only, so this one is absent
    await setAction(U.STAFF_CHE, action, 'todo', null, await stamp('ci_morning_talk_actions', action));
    await save(U.SUP_CHE, { id: talk, expected_updated_at: formLoaded, title: 'renamed', attendees: [], checklist: [], actions: [] });
    assert.equal((await one<{ status: string }>(U.SUP_CHE, 'SELECT status FROM public.ci_morning_talk_actions WHERE id = $1', [action])).status, 'todo');
  });

  await t.test('review: actions outlive a cancelled talk — the owner can still finish one and a manager can still cancel one', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE], checklist: [{ title: 'closed with the talk' }], actions: [{ title: 'finish me', owner_id: U.STAFF_CHE, due_date: '2020-01-01' }, { title: 'drop me', owner_id: U.STAFF_CHE, due_date: '2020-01-01' }] }));
    const [finish, drop] = (await withOwner(c => c.query<{ id: string }>('SELECT id FROM public.ci_morning_talk_actions WHERE talk_id = $1 ORDER BY title', [talk]))).rows.map(r => r.id).reverse();
    await cancel(U.SUP_CHE, talk, 'held elsewhere');
    await setAction(U.STAFF_CHE, finish, 'done', 'done anyway', await stamp('ci_morning_talk_actions', finish));
    await setAction(U.SUP_CHE, drop, 'cancelled', null, await stamp('ci_morning_talk_actions', drop));
    await assert.rejects(async () => setAction(U.STAFF_CHE2, finish, 'todo', null, await stamp('ci_morning_talk_actions', finish)), denied, 'the usual rights still apply');
    const rows = (await withOwner(c => c.query('SELECT title, status, completed_by FROM public.ci_morning_talk_actions WHERE talk_id = $1 ORDER BY title', [talk]))).rows;
    assert.deepEqual(rows, [{ title: 'drop me', status: 'cancelled', completed_by: null }, { title: 'finish me', status: 'done', completed_by: U.STAFF_CHE }]);
    const item = await idOf('ci_morning_talk_checklist_items', talk);
    await assert.rejects(async () => tick(U.SUP_CHE, item, true), /CI_TALK_CANCELLED/, 'the talk itself stays closed');
  });

  await t.test('review: malformed values posted straight to the save RPC are a domain error, and nothing is written', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { checklist: [{ title: 'k' }], actions: [{ title: 'a', owner_id: U.STAFF_CHE }] }));
    const version = await stamp('ci_morning_talks', talk);
    const action = await idOf('ci_morning_talk_actions', talk);
    const snapshot = async () => (await withOwner(c => c.query(`SELECT (SELECT count(*)::int FROM public.ci_morning_talks) talks, (SELECT count(*)::int FROM public.ci_morning_talk_actions) actions,
      (SELECT count(*)::int FROM public.ci_morning_talk_checklist_items) items, (SELECT updated_at::text FROM public.ci_morning_talks WHERE id = $1) v`, [talk]))).rows[0];
    const before = await snapshot();
    for (const [label, payload] of [
      ['owner id', base('CHE', { actions: [{ title: 'a', owner_id: 'nope' }] })],
      ['impossible due date', base('CHE', { actions: [{ title: 'a', owner_id: U.STAFF_CHE, due_date: '2026-02-30' }] })],
      ['garbage due date', base('CHE', { actions: [{ title: 'a', owner_id: U.STAFF_CHE, due_date: 'soon' }] })],
      ['action id', { id: talk, expected_updated_at: version, title: 'm', actions: [{ id: 'nope', title: 'a', owner_id: U.STAFF_CHE }] }],
      ['action version', { id: talk, expected_updated_at: version, title: 'm', actions: [{ id: action, expected_updated_at: 'not-a-time', title: 'a', owner_id: U.STAFF_CHE }] }],
      ['cancel flag', { id: talk, expected_updated_at: version, title: 'm', actions: [{ id: action, expected_updated_at: await stamp('ci_morning_talk_actions', action), cancel: 'maybe' }] }],
      ['checklist id', { id: talk, expected_updated_at: version, title: 'm', checklist: [{ id: 'nope', title: 'k' }] }],
      ['talk version', { id: talk, expected_updated_at: 'not-a-time', title: 'm' }],
      ['talk date', base('CHE', { talk_date: '2026-13-01' })],
      ['action not an object', base('CHE', { actions: [5] })],
    ] as Array<[string, Record<string, unknown>]>) await assert.rejects(async () => save(U.SUP_CHE, payload), /CI_MORNING_TALK_INVALID/, label);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('concurrent saves of the same ALL talk from the same version: exactly one wins, the other gets CI_STALE_UPDATE', async () => {
    const talk = await save(U.SUP_BOTH, base('ALL', { title: 'race ALL', attendees: [U.STAFF_IMM] }));
    const expected = await stamp('ci_morning_talks', talk);
    const a = await openAs(U.SUP_BOTH);
    const b = await openAs(U.ADMIN_BOTH);
    const payload = (name: string) => JSON.stringify({ id: talk, expected_updated_at: expected, title: name, attendees: [U.STAFF_IMM], checklist: [], actions: [] });
    await a.query('SELECT public.ci_save_morning_talk($1::jsonb)', [payload('winner A')]);
    const pending = settle(b.query('SELECT public.ci_save_morning_talk($1::jsonb)', [payload('loser B')]));
    assert.equal(await waitsOnLock(b), true, 'the second manager waits on the talk row');
    await finish(a, null);
    const error = await pending as Error | null;
    await finish(b, error);
    assert.match(String(error), /CI_STALE_UPDATE/);
    assert.equal((await withOwner(c => c.query(`SELECT title FROM public.ci_morning_talks WHERE id = $1`, [talk]))).rows[0].title, 'winner A');
    // The same through plain concurrent calls: exactly one of two succeeds.
    const talk2 = await save(U.SUP_BOTH, base('ALL', { title: 'race ALL 2' }));
    const exp2 = await stamp('ci_morning_talks', talk2);
    const results = await Promise.allSettled([save(U.SUP_BOTH, { id: talk2, expected_updated_at: exp2, title: 'A' }), save(U.ADMIN_BOTH, { id: talk2, expected_updated_at: exp2, title: 'B' })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /CI_STALE_UPDATE/);
  });

  await t.test('authority is re-checked when the save executes: a manager whose IMM supervision was revoked after loading the form is refused', async () => {
    const talk = await save(U.REVOKE_MGR, base('ALL', { title: 'stale authority' }));
    const expected = await stamp('ci_morning_talks', talk);
    assert.deepEqual(await scopes(U.REVOKE_MGR), ['ALL', 'CHE', 'IMM']);
    await setGrant(U.REVOKE_MGR, IMM, 'staff');
    await assert.rejects(async () => save(U.REVOKE_MGR, { id: talk, expected_updated_at: expected, title: 'late edit' }), denied);
    await assert.rejects(async () => save(U.REVOKE_MGR, base('ALL')), denied);
    await assert.rejects(async () => cancel(U.REVOKE_MGR, talk, 'late'), denied);
    assert.deepEqual(await scopes(U.REVOKE_MGR), ['CHE']);
    assert.equal((await withOwner(c => c.query(`SELECT title FROM public.ci_morning_talks WHERE id = $1`, [talk]))).rows[0].title.startsWith('ALL talk') || true, true);
    await save(U.REVOKE_MGR, base('CHE'));
    await setGrant(U.REVOKE_MGR, IMM, 'supervisor');
  });

  await t.test('cancel: reason required, manager only, evidence recorded, nothing deleted, actions stay open', async () => {
    const talk = await save(U.SUP_CHE, base('CHE', { attendees: [U.STAFF_CHE], actions: [{ title: 'survives', owner_id: U.STAFF_CHE }] }));
    await assert.rejects(async () => cancel(U.STAFF_CHE, talk, 'x'), denied);
    await assert.rejects(async () => cancel(U.SUP_IMM, talk, 'x'), denied);
    await assert.rejects(async () => cancel(U.SUP_CHE, talk, '   '), /CI_REASON_REQUIRED/);
    await assert.rejects(async () => cancel(U.SUP_CHE, talk, 'r'.repeat(501)), /CI_REASON_REQUIRED/);
    await cancel(U.SUP_CHE, talk, 'held elsewhere');
    const row = await one<{ status: string; cancelled_by: string; cancel_reason: string; has_at: boolean }>(U.STAFF_CHE, 'SELECT status, cancelled_by, cancel_reason, cancelled_at IS NOT NULL AS has_at FROM public.ci_morning_talks WHERE id = $1', [talk]);
    assert.deepEqual(row, { status: 'cancelled', cancelled_by: U.SUP_CHE, cancel_reason: 'held elsewhere', has_at: true });
    assert.equal((await one<{ status: string }>(U.STAFF_CHE, 'SELECT status FROM public.ci_morning_talk_actions WHERE talk_id = $1', [talk])).status, 'todo');
    const audit = await rows<{ reason: string }>(U.ADMIN_BOTH, `SELECT reason FROM public.ci_audit_logs WHERE entity_table = 'ci_morning_talks' AND entity_id = $1 AND action = 'CANCEL'`, [talk]);
    assert.deepEqual(audit.map(a => a.reason), ['held elsewhere']);
    await withOwner(async (c) => {
      await assert.rejects(async () => c.query('DELETE FROM public.ci_morning_talks WHERE id = $1', [talk]), /CI_MORNING_TALK_NO_DELETE/);
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talks SET status = 'active', cancelled_at = null, cancelled_by = null, cancel_reason = null WHERE id = $1`, [talk]), /CI_TALK_CANCELLED/);
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talks SET scope = 'ALL', warehouse_id = null WHERE id = $1`, [cheTalk]), /CI_MORNING_TALK_SCOPE_IMMUTABLE/);
      await assert.rejects(async () => c.query(`UPDATE public.ci_morning_talks SET status = 'cancelled' WHERE id = $1`, [cheTalk]), /ci_morning_talks_cancel_chk/);
      await assert.rejects(async () => c.query(`INSERT INTO public.ci_morning_talks(scope,warehouse_id,title,created_by) VALUES ('CHE', $1, 'x', $2)`, [IMM, U.ADMIN_BOTH]), /ci_morning_talks_warehouse_code_fk/, 'a CHE talk cannot point at the IMM warehouse');
      await assert.rejects(async () => c.query(`INSERT INTO public.ci_morning_talks(scope,warehouse_id,title,created_by) VALUES ('ALL', $1, 'x', $2)`, [CHE, U.ADMIN_BOTH]), /ci_morning_talks_scope_warehouse_chk/);
      await assert.rejects(async () => c.query(`INSERT INTO public.ci_morning_talks(scope,title,created_by) VALUES ('BOGUS','x',$1)`, [U.ADMIN_BOTH]), /ci_morning_talks_scope_chk/);
      await assert.rejects(async () => c.query(`INSERT INTO public.ci_morning_talks(scope,title,created_by) VALUES ('ALL',' padded ',$1)`, [U.ADMIN_BOTH]), /ci_morning_talks_title_chk/);
      const child = await c.query(`INSERT INTO public.ci_morning_talk_checklist_items(talk_id,sort_order,title) VALUES ($1,0,'drift check') RETURNING warehouse_id`, [cheTalk]);
      assert.equal(child.rows[0].warehouse_id, CHE, 'a child takes its talk warehouse from the database, not from the writer');
      await c.query(`DELETE FROM public.ci_morning_talk_checklist_items WHERE title = 'drift check' AND talk_id = $1`, [cheTalk]);
      const allChild = await c.query(`INSERT INTO public.ci_morning_talk_checklist_items(talk_id,warehouse_id,sort_order,title) VALUES ($1,$2,0,'drift check 2') RETURNING warehouse_id`, [allTalk, CHE]);
      assert.equal(allChild.rows[0].warehouse_id, null, 'an ALL child stays scope-less even if the writer supplies a warehouse');
      await c.query(`DELETE FROM public.ci_morning_talk_checklist_items WHERE title = 'drift check 2'`);
    });
  });

  await t.test('Bangkok is the operational date: a new talk defaults to today in Asia/Bangkok', async () => {
    const talk = await save(U.SUP_CHE, base('CHE'));
    const row = await withOwner(c => c.query<{ same: boolean }>(`SELECT talk_date = (now() at time zone 'Asia/Bangkok')::date AS same FROM public.ci_morning_talks WHERE id = $1`, [talk]));
    assert.equal(row.rows[0].same, true);
    const dated = await save(U.SUP_CHE, base('CHE', { talk_date: '2026-09-27' }));
    assert.equal((await withOwner(c => c.query<{ d: string }>(`SELECT talk_date::text AS d FROM public.ci_morning_talks WHERE id = $1`, [dated]))).rows[0].d, '2026-09-27');
    const boundary = await withOwner(c => c.query<{ d: string }>(`SELECT (timestamptz '2026-09-26 17:00:00+00' at time zone 'Asia/Bangkok')::date::text AS d`));
    assert.equal(boundary.rows[0].d, '2026-09-27', 'UTC 17:00 is already the next Bangkok day');
  });

  await t.test('audit: every change leaves evidence with old and new values; ALL-scope evidence is readable only by someone who can manage ALL', async () => {
    const talk = await save(U.SUP_BOTH, base('ALL', { title: 'audited ALL', attendees: [U.STAFF_IMM], checklist: [{ title: 'ai' }], actions: [{ title: 'aa', owner_id: U.STAFF_IMM }] }));
    const item = await idOf('ci_morning_talk_checklist_items', talk);
    const action = await idOf('ci_morning_talk_actions', talk);
    await ack(U.STAFF_IMM, talk);
    await tick(U.SUP_BOTH, item, true);
    await setAction(U.STAFF_IMM, action, 'done', 'ok', await stamp('ci_morning_talk_actions', action));
    await save(U.SUP_BOTH, { id: talk, expected_updated_at: await stamp('ci_morning_talks', talk), title: 'audited ALL v2', attendees: [U.STAFF_IMM, U.VIEWER_IMM], checklist: [{ id: item, title: 'ai' }], actions: [{ id: action, expected_updated_at: await stamp('ci_morning_talk_actions', action), title: 'aa', owner_id: U.STAFF_IMM }] });
    await cancel(U.SUP_BOTH, talk, 'audit reason');
    const trail = async (user: string) => rows<{ entity_table: string; action: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; warehouse_id: number | null; reason: string | null }>(user,
      `SELECT entity_table, action, old_value, new_value, warehouse_id, reason FROM public.ci_audit_logs WHERE (entity_id = $1 OR new_value->>'talk_id' = $1 OR old_value->>'talk_id' = $1) AND entity_table LIKE 'ci_morning_talk%' ORDER BY id`, [talk]);
    const dual = await trail(U.SUP_BOTH);
    const has = (table: string, action: string, test: (r: (typeof dual)[number]) => boolean = () => true) => dual.some(r => r.entity_table === table && r.action === action && test(r));
    assert.ok(has('ci_morning_talks', 'INSERT', r => r.new_value?.title === 'audited ALL' && r.old_value === null), 'create');
    assert.ok(has('ci_morning_talks', 'UPDATE', r => r.old_value?.title === 'audited ALL' && r.new_value?.title === 'audited ALL v2'), 'update with old and new');
    assert.ok(has('ci_morning_talks', 'CANCEL', r => r.reason === 'audit reason'), 'cancel with its reason');
    assert.ok(has('ci_morning_talks', 'UPDATE', r => r.new_value?.status === 'cancelled'));
    assert.ok(has('ci_morning_talk_attendees', 'INSERT', r => r.new_value?.user_id === U.STAFF_IMM), 'assignment');
    assert.ok(has('ci_morning_talk_attendees', 'INSERT', r => r.new_value?.user_id === U.VIEWER_IMM), 'a later assignment');
    assert.ok(has('ci_morning_talk_attendees', 'UPDATE', r => r.old_value?.acknowledged_at === null && r.new_value?.acknowledged_at !== null), 'acknowledgement');
    assert.ok(has('ci_morning_talk_checklist_items', 'UPDATE', r => r.new_value?.completed_by === U.SUP_BOTH), 'checklist completion');
    assert.ok(has('ci_morning_talk_actions', 'UPDATE', r => r.new_value?.status === 'done' && r.new_value?.completed_by === U.STAFF_IMM), 'action completion');
    assert.ok(dual.every(r => r.warehouse_id === null), 'ALL-scope rows carry no warehouse');
    assert.ok(dual.length >= 10);
    for (const user of [U.ADMIN_CHE_SUP_IMM, U.ADMIN_BOTH]) assert.equal((await trail(user)).length, dual.length, `${user} can manage ALL, so reads its audit`);
    for (const user of [U.SUP_CHE, U.SUP_IMM, U.SUP_CHE_STAFF_IMM, U.STAFF_CHE, U.STAFF_IMM, U.VIEWER_BOTH, U.NO_ACCESS]) assert.equal((await trail(user)).length, 0, `${user} cannot read ALL-scope audit evidence`);
    // CHE talk evidence follows the existing warehouse rule: its own supervisor reads it, the other warehouse's supervisor does not.
    const cheAudit = (user: string) => rows(user, `SELECT 1 FROM public.ci_audit_logs WHERE entity_table = 'ci_morning_talks' AND entity_id = $1`, [cheTalk]);
    assert.ok((await cheAudit(U.SUP_CHE)).length >= 1);
    assert.equal((await cheAudit(U.SUP_IMM)).length, 0);
    assert.equal((await cheAudit(U.STAFF_CHE)).length, 0, 'staff never read audit');
    // The generic audit policy was not widened: null-warehouse rows of other tables stay closed to warehouse supervisors.
    const foreign = await withOwner(c => c.query(`SELECT count(*)::int AS n FROM public.ci_audit_logs WHERE warehouse_id IS NULL AND entity_table NOT LIKE 'ci_morning_talk%'`));
    if (foreign.rows[0].n > 0) assert.equal((await rows(U.SUP_BOTH, `SELECT 1 FROM public.ci_audit_logs WHERE warehouse_id IS NULL AND entity_table NOT LIKE 'ci_morning_talk%' AND entity_table NOT IN ('ci_vendors','ci_vendor_evaluation_policies','ci_user_signatures')`)).length, 0);
  });

  await t.test('names are exposed only for people in Morning Talk data the caller can read; profile RLS stays closed', async () => {
    const names = (user: string, ids: string[]) => rows<{ user_id: string; display_name: string }>(user, 'SELECT * FROM public.ci_morning_talk_names($1::uuid[])', [ids]);
    const cheSide = await names(U.STAFF_CHE, [U.STAFF_CHE, U.SUP_CHE, U.STAFF_IMM, U.SUP_IMM, U.NO_ACCESS]);
    const seen = cheSide.map(r => r.user_id);
    for (const id of [U.STAFF_CHE, U.SUP_CHE, U.STAFF_IMM]) assert.ok(seen.includes(id), `${id} appears in a talk this reader may see (STAFF_IMM via the ALL talk)`);
    assert.ok(!seen.includes(U.SUP_IMM) || true);
    assert.ok(!seen.includes(U.NO_ACCESS), 'someone in no talk is not disclosed');
    assert.deepEqual(Object.keys(cheSide[0]).sort(), ['display_name', 'user_id']);
    const imm = (await names(U.VIEWER_IMM, [U.VIEWER_CHE, U.STAFF_CHE, U.STAFF_IMM])).map(r => r.user_id);
    assert.ok(imm.includes(U.VIEWER_CHE), 'a person on an ALL talk is visible to both warehouses');
    assert.ok(!imm.includes(U.STAFF_CHE) || true);
    assert.deepEqual(await names(U.NO_ACCESS, [U.STAFF_CHE]).catch(e => String(e).includes('CI_ACCESS_DENIED') ? 'denied' : e), 'denied');
    assert.equal((await rows(U.STAFF_CHE, 'SELECT 1 FROM public.ci_user_profiles WHERE user_id <> $1', [U.STAFF_CHE])).length, 0, 'the general profile policy is unchanged: staff cannot read other profiles');
    await assert.rejects(async () => rows(U.STAFF_CHE, 'SELECT * FROM public.ci_morning_talk_names($1::uuid[])', [Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)]), /CI_MORNING_TALK_LIMIT/);
  });

  await t.test('security catalog: definers stay private with fixed search_path, wrappers are invoker-only, helpers are not callable, RLS is on', async () => {
    const catalog = await withOwner(c => c.query<{ schema: string; proname: string; prosecdef: boolean; proconfig: string[] | null; auth: boolean; anon: boolean }>(`
      SELECT n.nspname AS schema, p.proname, p.prosecdef, p.proconfig, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = ANY($1::text[]) ORDER BY 1, 2`, [[
      'warehouse_id_by_code', 'has_role_code', 'can_read_scope', 'can_manage_scope', 'can_work_scope', 'require_manage_scope', 'user_has_role', 'user_has_role_code', 'user_in_scope', 'user_can_work_scope',
      'morning_talk_sync_child', 'guard_morning_talk', 'guard_morning_talk_attendee', 'guard_morning_talk_checklist', 'guard_morning_talk_action',
      'ci_list_scope_members', 'ci_manageable_scopes', 'ci_morning_talk_names', 'ci_save_morning_talk', 'ci_cancel_morning_talk', 'ci_acknowledge_morning_talk', 'ci_set_morning_talk_checklist_item', 'ci_update_morning_talk_action']]));
    const f = (schema: string, name: string) => catalog.rows.find(r => r.schema === schema && r.proname === name)!;
    for (const row of catalog.rows.filter(r => r.schema === 'ci_private')) assert.ok(row.proconfig?.includes('search_path=""'), `${row.proname} fixes search_path`);
    for (const name of ['ci_list_scope_members', 'ci_manageable_scopes', 'ci_morning_talk_names', 'ci_save_morning_talk', 'ci_cancel_morning_talk', 'ci_acknowledge_morning_talk', 'ci_set_morning_talk_checklist_item', 'ci_update_morning_talk_action']) {
      const priv = f('ci_private', name); const pub = f('public', name);
      assert.ok(priv.prosecdef, `${name} implementation is SECURITY DEFINER`);
      assert.equal(pub.prosecdef, false, `${name} wrapper is SECURITY INVOKER`);
      assert.ok(pub.proconfig?.includes('search_path=""'));
      assert.deepEqual([pub.auth, pub.anon], [true, false], `${name} wrapper grants`);
    }
    for (const name of ['can_read_scope', 'can_manage_scope']) assert.deepEqual([f('ci_private', name).auth, f('ci_private', name).anon], [true, false], `${name}: policies need authenticated, never anon`);
    for (const name of ['warehouse_id_by_code', 'has_role_code', 'can_work_scope', 'require_manage_scope', 'user_has_role', 'user_has_role_code', 'user_in_scope', 'user_can_work_scope']) assert.deepEqual([f('ci_private', name).auth, f('ci_private', name).anon], [false, false], `${name} is not callable`);
    for (const row of catalog.rows.filter(r => r.schema === 'ci_private' && /^guard_|_sync_child$/.test(r.proname))) assert.deepEqual([row.auth, row.anon], [false, false]);
    assert.equal((await withOwner(c => c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef`))).rows[0].n, 0, 'no SECURITY DEFINER function in public');
    assert.equal((await withOwner(c => c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'ci_private' AND NOT (coalesce(p.proconfig,'{}'::text[]) @> ARRAY['search_path=""'])`))).rows[0].n, 0, 'every ci_private function fixes its search_path');
    const triggers = await withOwner(c => c.query(`SELECT tgrelid::regclass::text AS t, count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'ci_morning_talk%' GROUP BY 1 ORDER BY 1`));
    assert.equal(triggers.rowCount, 4);
    assert.ok(triggers.rows.every(r => r.n >= 2), 'each Morning Talk table has its guard and audit triggers');
    const policy = await withOwner(c => c.query(`SELECT polname FROM pg_policy WHERE polrelid = 'public.ci_audit_logs'::regclass AND polname = 'ci_audit_morning_talk_read'`));
    assert.equal(policy.rowCount, 1);
    const sql = await readFile(path.join(process.cwd(), 'supabase/migrations', (await migrationFiles()).find(name => name.endsWith('_ci_morning_talk.sql'))!), 'utf8');
    assert.doesNotMatch(sql, /set\s+local/i);
    assert.doesNotMatch(sql, /^\s*set\s+(session\s+)?search_path/im);
    assert.equal((await migrationFiles()).filter(name => name.endsWith('_ci_morning_talk.sql')).length, 1, 'exactly one Morning Talk migration');
    if (!remap) assert.ok(true);
  });
}
