import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const root = process.env.CI_TEST_DATABASE_URL;
if (!root) throw new Error('Set CI_TEST_DATABASE_URL via scripts/db/test.ps1');
const adminUrl = new URL(root);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to disposable loopback PostgreSQL');
}
const dbName = `ci_env_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
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
const range = { temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };

test('Phase 3 environment: monitored ownership, immutable readings, rounds, correction and security', { timeout: 240_000 }, async t => {
  const admin = new Client({ connectionString: adminUrl.toString() }); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  try {
    await owner(async db => {
      await db.query(await readFile('tests/db/bootstrap.sql', 'utf8'));
      for (const file of (await readdir('supabase/migrations')).filter(name => name.endsWith('.sql')).sort()) {
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
    const fridge = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 1, code: 'CHE-FR-1', name: 'Fridge', location_type: 'refrigerator', env: range }], ['jsonb']);
    const shelf = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 1, code: 'CHE-FR-1-S1', name: 'Shelf', location_type: 'shelf', parent_location_id: fridge }], ['jsonb']);
    const imm = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 2, code: 'IMM-FR-1', name: 'IMM fridge', location_type: 'refrigerator', env: range }], ['jsonb']);
    const firstKey = uuid();

    await t.test('Phase 1 config is unscheduled and inherited shelf cannot be recorded', async () => {
      const today = (await owner(db => db.query<{ day: string }>(`SELECT (now() at time zone 'Asia/Bangkok')::date::text AS day`))).rows[0].day;
      const status = await user(U.staff, db => db.query(`SELECT * FROM public.ci_environment_day_status(1::smallint,$1::date)`, [today]));
      assert.deepEqual(status.rows.map(row => [row.location_id, row.state]), [[fridge, 'unscheduled']]);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ location_id: shelf, temperature_c: 4, source: 'qr', client_request_id: uuid() }], ['jsonb']), /CI_ENV_NOT_MONITORED_LOCATION/);
      assert.equal((await owner(db => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.ci_environment_readings'))).rows[0].n, 0);
      const ownShelf = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 1, code: 'CHE-FR-1-S2', name: 'Own monitor shelf', location_type: 'shelf', parent_location_id: fridge }], ['jsonb']);
      await rpc(U.supervisor, 'ci_set_location_env_config', [ownShelf, { ...range, temp_min_c: 3, temp_max_c: 7 }], ['uuid', 'jsonb']);
      const own = await rpc<{ location_id: string; overall_status: string }>(U.staff, 'ci_record_environment_reading', [{ location_id: ownShelf, temperature_c: 4, client_request_id: uuid() }], ['jsonb']);
      assert.equal(own.location_id, ownShelf);
      assert.equal(own.overall_status, 'in_range');
    });

    await t.test('range boundaries, idempotency, excursion and RLS', async () => {
      const payload = { location_id: fridge, temperature_c: 2, source: 'qr', observed_at: null, client_request_id: firstKey };
      const first = await rpc<{ id: string; overall_status: string }>(U.staff, 'ci_record_environment_reading', [payload], ['jsonb']);
      assert.equal(first.overall_status, 'in_range');
      assert.equal((await rpc<{ id: string }>(U.staff, 'ci_record_environment_reading', [payload], ['jsonb'])).id, first.id);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...payload, temperature_c: 3 }], ['jsonb']), /CI_IDEMPOTENCY_CONFLICT/);
      const out = await rpc<{ overall_status: string; excursion_id: string }>(U.staff, 'ci_record_environment_reading', [{ ...payload, temperature_c: 8.01, client_request_id: uuid() }], ['jsonb']);
      assert.equal(out.overall_status, 'out_of_range'); assert.ok(out.excursion_id);
      const again = await rpc<{ excursion_id: string }>(U.staff, 'ci_record_environment_reading', [{ ...payload, temperature_c: 9, client_request_id: uuid() }], ['jsonb']);
      assert.equal(again.excursion_id, out.excursion_id);
      await assert.rejects(() => rpc(U.viewer, 'ci_record_environment_reading', [{ ...payload, client_request_id: uuid() }], ['jsonb']), /CI_ACCESS_DENIED/);
      await assert.rejects(() => rpc(U.viewer, 'ci_acknowledge_environment_excursion', [out.excursion_id, 'ไม่ได้รับสิทธิ์'], ['uuid', 'text']), /CI_ACCESS_DENIED/);
      await assert.rejects(() => user(U.staff, db => db.query('UPDATE public.ci_environment_excursions SET status = $1 WHERE id = $2', ['resolved', out.excursion_id])), /permission denied/);
      assert.equal((await user(U.imm, db => db.query('SELECT id FROM public.ci_environment_readings'))).rowCount, 0);
      await assert.rejects(() => user(U.staff, db => db.query('UPDATE public.ci_environment_readings SET temperature_c = 5 WHERE id = $1', [first.id])), /permission denied/);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ location_id: imm, temperature_c: 3, client_request_id: uuid() }], ['jsonb']), /CI_ACCESS_DENIED/);
    });

    await t.test('schedule version preserves ranges, correction chain and pause', async () => {
      await rpc(U.supervisor, 'ci_set_location_env_config', [fridge, { check_times: ['08:30', '15:30'] }], ['uuid', 'jsonb']);
      const config = (await owner(db => db.query('SELECT * FROM public.ci_location_env_configs WHERE location_id = $1 ORDER BY effective_from DESC LIMIT 1', [fridge]))).rows[0];
      assert.deepEqual(config.check_times, ['08:30:00', '15:30:00']); assert.equal(config.temp_min_c, '2.00');
      const today = (await owner(db => db.query<{ day: string }>(`SELECT (now() at time zone 'Asia/Bangkok')::date::text AS day`))).rows[0].day;
      const rounds = await user(U.viewer, db => db.query('SELECT * FROM public.ci_environment_day_status(1::smallint,$1::date)', [today]));
      assert.ok(rounds.rows.some(row => row.location_id === fridge));
      assert.ok(rounds.rows.every(row => ['unscheduled','satisfied','due','upcoming','missed'].includes(row.state)));
      const month = today.slice(0, 7) + '-01';
      const report = await user(U.viewer, db => db.query('SELECT * FROM public.ci_environment_month_report(1::smallint,$1::date,$2::uuid)', [month, shelf]));
      assert.ok(report.rows.length > 0 && report.rows.every(row => row.location_id === fridge), 'a shelf report resolves to its monitored parent');
      const original = await rpc<{ id: string }>(U.staff, 'ci_record_environment_reading', [{ location_id: fridge, temperature_c: 4.8, client_request_id: uuid() }], ['jsonb']);
      const corrected = await rpc<{ id: string; overall_status: string }>(U.staff, 'ci_correct_environment_reading', [{ reading_id: original.id, entry_kind: 'correction', temperature_c: 4.1, reason: 'พิมพ์ผิด', client_request_id: uuid() }], ['jsonb']);
      assert.equal(corrected.overall_status, 'in_range');
      await assert.rejects(() => rpc(U.staff, 'ci_correct_environment_reading', [{ reading_id: original.id, entry_kind: 'void', reason: 'ซ้ำ', client_request_id: uuid() }], ['jsonb']), /CI_ALREADY_CORRECTED/);
      await rpc(U.staff, 'ci_correct_environment_reading', [{ reading_id: corrected.id, entry_kind: 'void', reason: 'ข้อมูลผิด', client_request_id: uuid() }], ['jsonb']);
      assert.equal((await owner(db => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.ci_environment_effective_readings WHERE id = $1 OR id = $2', [original.id, corrected.id]))).rows[0].n, 0);
      await rpc(U.supervisor, 'ci_set_location_env_config', [fridge, { monitoring_state: 'paused', pause_reason: 'ซ่อมตู้' }], ['uuid', 'jsonb']);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ location_id: fridge, temperature_c: 4, client_request_id: uuid() }], ['jsonb']), /CI_ENV_PAUSED/);
      const originalRetry = await rpc<{ id: string }>(U.staff, 'ci_record_environment_reading', [{ location_id: fridge, temperature_c: 2, source: 'qr', observed_at: null, client_request_id: firstKey }], ['jsonb']);
      assert.ok(originalRetry.id, 'an identical retry returns even after monitoring is paused');
    });

    await t.test('Bangkok UTC boundary and one-sided bounds are stable', async () => {
      const result = await owner(db => db.query(`SELECT
        ci_private.environment_round(ARRAY['08:30','15:30']::time[], '2026-09-26T16:59:00Z'::timestamptz) AS before_midnight,
        ci_private.environment_round(ARRAY['08:30','15:30']::time[], '2026-09-26T17:00:00Z'::timestamptz) AS at_midnight,
        ci_private.environment_round(ARRAY['08:30','15:30']::time[], '2026-09-27T16:59:59Z'::timestamptz) AS last_round,
        ci_private.environment_parameter_status(true,-20,null,-20) AS freezer_in,
        ci_private.environment_parameter_status(true,-19.99,null,-20) AS freezer_out`));
      assert.deepEqual(result.rows[0], { before_midnight: 2, at_midnight: 1, last_round: 2, freezer_in: 'in_range', freezer_out: 'out_of_range' });
    });

    await t.test('range-only version change does not duplicate historical rounds', async () => {
      const target = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 1, code: 'CHE-FR-VERS', name: 'Versioned fridge', location_type: 'refrigerator', env: range }], ['jsonb']);
      await owner(db => db.query(`INSERT INTO public.ci_location_env_configs
        (warehouse_id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,check_times,monitoring_state,created_by)
        VALUES (1,$1,'2026-09-19 00:00+07',true,2,8,false,ARRAY['08:30','15:30']::time[],'active',$2),
               (1,$1,'2026-09-20 12:00+07',true,3,7,false,ARRAY['08:30','15:30']::time[],'active',$2)`, [target, U.admin]));
      const result = await user(U.viewer, db => db.query(`SELECT round_no,state FROM public.ci_environment_day_status(1::smallint,'2026-09-20'::date)
        WHERE location_id = $1 ORDER BY round_no`, [target]));
      assert.deepEqual(result.rows.map(row => row.round_no), [1, 2]);
      assert.deepEqual(result.rows.map(row => row.state), ['missed', 'missed']);
      await owner(db => db.query(`INSERT INTO public.ci_location_env_configs
        (warehouse_id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,check_times,monitoring_state,pause_reason,created_by)
        VALUES (1,$1,'2026-09-20 14:00+07',true,3,7,false,ARRAY['08:30','15:30']::time[],'paused','ซ่อมตู้',$2)`, [target, U.admin]));
      const paused = await user(U.viewer, db => db.query(`SELECT round_no,state FROM public.ci_environment_day_status(1::smallint,'2026-09-20'::date)
        WHERE location_id = $1 ORDER BY round_no`, [target]));
      assert.deepEqual(paused.rows.map(row => [row.round_no, row.state]), [[1, 'missed'], [2, 'paused']]);
    });

    await t.test('late, future, missing and unmonitored parameter rules fail closed', async () => {
      const target = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 1, code: 'CHE-FR-VALID', name: 'Validation fridge', location_type: 'refrigerator', env: range }], ['jsonb']);
      await owner(db => db.query(`INSERT INTO public.ci_location_env_configs
        (warehouse_id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,created_by)
        VALUES (1,$1,now()-interval '8 days',true,2,8,false,$2)`, [target, U.admin]));
      const base = { location_id: target, source: 'manual', client_request_id: uuid() };
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), temperature_c: 4, observed_at: new Date(Date.now() - 20 * 60_000).toISOString(), reason: 'ย้อนหลัง' }], ['jsonb']), /CI_ENV_LATE_FORBIDDEN/);
      const late = await rpc<{ entry_mode: string }>(U.supervisor, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), temperature_c: 4, observed_at: new Date(Date.now() - 20 * 60_000).toISOString(), reason: 'ตรวจย้อนหลัง' }], ['jsonb']);
      assert.equal(late.entry_mode, 'late');
      await assert.rejects(() => rpc(U.supervisor, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), temperature_c: 4, observed_at: new Date(Date.now() - 73 * 60 * 60_000).toISOString(), reason: 'เกินกำหนด' }], ['jsonb']), /CI_ENV_PAYLOAD_INVALID/);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), temperature_c: 4, observed_at: new Date(Date.now() + 60_000).toISOString() }], ['jsonb']), /CI_ENV_PAYLOAD_INVALID/);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), temperature_c: 4, humidity_rh: 50 }], ['jsonb']), /CI_ENV_PARAMETER_NOT_MONITORED/);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), humidity_rh: 50 }], ['jsonb']), /CI_ENV_PARAMETER_NOT_MONITORED/);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid() }], ['jsonb']), /CI_REASON_REQUIRED/);
      await assert.rejects(() => rpc(U.staff, 'ci_record_environment_reading', [{ ...base, client_request_id: uuid(), temperature_c: 4, humidity_rh: 101 }], ['jsonb']), /CI_ENV_PAYLOAD_INVALID/);
      await assert.rejects(() => user(U.staff, db => db.query('DELETE FROM public.ci_environment_readings WHERE location_id = $1', [target])), /permission denied/);
    });

    await t.test('two connections serialize identical requests and out-of-range excursion creation', async () => {
      const target = await rpc<string>(U.admin, 'ci_create_location_v2', [{ warehouse_id: 1, code: 'CHE-FR-CONC', name: 'Concurrent fridge', location_type: 'refrigerator', env: range }], ['jsonb']);
      async function pair(payloadA: Record<string, unknown>, payloadB: Record<string, unknown>) {
        const a = new Client({ connectionString: dbUrl.toString() }); const b = new Client({ connectionString: dbUrl.toString() });
        await Promise.all([a.connect(), b.connect()]);
        try {
          for (const db of [a, b]) { await db.query('BEGIN'); await db.query('SET LOCAL ROLE authenticated'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [U.staff]); }
          const first = await a.query<{ result: { id: string; excursion_id: string | null } }>('SELECT public.ci_record_environment_reading($1::jsonb) AS result', [JSON.stringify(payloadA)]);
          const pending = b.query<{ result: { id: string; excursion_id: string | null } }>('SELECT public.ci_record_environment_reading($1::jsonb) AS result', [JSON.stringify(payloadB)]);
          await new Promise(resolve => setTimeout(resolve, 30));
          await a.query('COMMIT');
          const second = await pending; await b.query('COMMIT');
          return [first.rows[0].result, second.rows[0].result];
        } finally { await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK')]); await Promise.all([a.end(), b.end()]); }
      }
      const key = uuid();
      const same = { location_id: target, temperature_c: 4, observed_at: null, source: 'qr', client_request_id: key };
      const identical = await pair(same, same);
      assert.equal(identical[0].id, identical[1].id);
      const out = await pair({ ...same, temperature_c: 9, client_request_id: uuid() }, { ...same, temperature_c: 10, client_request_id: uuid() });
      assert.ok(out[0].excursion_id); assert.equal(out[0].excursion_id, out[1].excursion_id);
      assert.equal((await owner(db => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.ci_environment_excursions WHERE location_id = $1 AND status <> $2', [target, 'resolved']))).rows[0].n, 1);
      const a = new Client({ connectionString: dbUrl.toString() }); const b = new Client({ connectionString: dbUrl.toString() });
      await Promise.all([a.connect(), b.connect()]);
      try {
        for (const db of [a, b]) { await db.query('BEGIN'); await db.query('SET LOCAL ROLE authenticated'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [U.staff]); }
        const payload = (key: string) => JSON.stringify({ reading_id: out[0].id, entry_kind: 'correction', temperature_c: 5, reason: 'ตรวจพบการพิมพ์ผิด', client_request_id: key });
        await a.query('SELECT public.ci_correct_environment_reading($1::jsonb)', [payload(uuid())]);
        const pending = b.query('SELECT public.ci_correct_environment_reading($1::jsonb)', [payload(uuid())]);
        await new Promise(resolve => setTimeout(resolve, 30));
        await a.query('COMMIT');
        await assert.rejects(pending, /CI_ALREADY_CORRECTED/);
      } finally { await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK')]); await Promise.all([a.end(), b.end()]); }
    });
  } finally {
    const admin = new Client({ connectionString: adminUrl.toString() }); await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await admin.end(); }
  }
});
