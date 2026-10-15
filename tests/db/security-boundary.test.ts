import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const configuredDatabaseUrl = process.env.CI_TEST_DATABASE_URL;
if (!configuredDatabaseUrl) {
  throw new Error('Set CI_TEST_DATABASE_URL via scripts/db/test.ps1 to run disposable PostgreSQL tests');
}
const adminUrl = new URL(configuredDatabaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres') {
  throw new Error('CI_TEST_DATABASE_URL must point to the disposable loopback PostgreSQL postgres database');
}
const dbName = `ci_security_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

async function connect(connectionString = testUrl.toString()): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

test('privileged RPC implementations stay private behind contract-preserving invoker wrappers', { timeout: 120_000 }, async () => {
  const owner = await connect(adminUrl.toString());
  try {
    await owner.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await owner.end();
  }

  try {
    const client = await connect();
    try {
      const migrations = (await readdir(path.join(process.cwd(), 'supabase/migrations')))
        .filter((filename) => filename.endsWith('.sql'))
        .sort();
      for (const filename of ['tests/db/bootstrap.sql', ...migrations.map((file) => `supabase/migrations/${file}`)]) {
        await client.query(await readFile(path.join(process.cwd(), filename), 'utf8'));
      }

      const publicDefiners = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'ci\\_%' ESCAPE '\\' AND p.prosecdef
      `);
      assert.equal(Number(publicDefiners.rows[0].count), 0, 'public ci_* RPCs must not be SECURITY DEFINER');

      // Function-level hardening: every private function (helpers, triggers and RPC implementations alike) fixes its own search_path.
      const unfixedSearchPath = await client.query<{ proname: string }>(`
        SELECT p.proname
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ci_private' AND NOT (coalesce(p.proconfig, '{}'::text[]) @> ARRAY['search_path=""'])
        ORDER BY p.proname
      `);
      assert.deepEqual(unfixedSearchPath.rows.map((row) => row.proname), [], 'every ci_private function must declare set search_path = \'\'');

      const wrappers = await client.query<{
        proname: string;
        identity_arguments: string;
        public_arguments: string;
        private_arguments: string;
        public_result: string;
        private_result: string;
        public_set: boolean;
        private_set: boolean;
        public_volatility: string;
        private_volatility: string;
        public_strict: boolean;
        private_strict: boolean;
        public_parallel: string;
        private_parallel: string;
        public_config: string[] | null;
        private_config: string[] | null;
        anonymous_execute: boolean;
        authenticated_grants_match: boolean;
        service_role_grants_match: boolean;
      }>(`
        SELECT
          public_fn.proname,
          pg_catalog.pg_get_function_identity_arguments(public_fn.oid) AS identity_arguments,
          pg_catalog.pg_get_function_arguments(public_fn.oid) AS public_arguments,
          pg_catalog.pg_get_function_arguments(private_fn.oid) AS private_arguments,
          pg_catalog.pg_get_function_result(public_fn.oid) AS public_result,
          pg_catalog.pg_get_function_result(private_fn.oid) AS private_result,
          public_fn.proretset AS public_set,
          private_fn.proretset AS private_set,
          public_fn.provolatile AS public_volatility,
          private_fn.provolatile AS private_volatility,
          public_fn.proisstrict AS public_strict,
          private_fn.proisstrict AS private_strict,
          public_fn.proparallel AS public_parallel,
          private_fn.proparallel AS private_parallel,
          public_fn.proconfig AS public_config,
          private_fn.proconfig AS private_config,
          has_function_privilege('anon', public_fn.oid, 'EXECUTE') AS anonymous_execute,
          has_function_privilege('authenticated', public_fn.oid, 'EXECUTE') =
            has_function_privilege('authenticated', private_fn.oid, 'EXECUTE') AS authenticated_grants_match,
          has_function_privilege('service_role', public_fn.oid, 'EXECUTE') =
            has_function_privilege('service_role', private_fn.oid, 'EXECUTE') AS service_role_grants_match
        FROM pg_catalog.pg_proc public_fn
        JOIN pg_catalog.pg_namespace public_ns ON public_ns.oid = public_fn.pronamespace
        JOIN pg_catalog.pg_proc private_fn
          ON private_fn.proname = public_fn.proname
          AND pg_catalog.pg_get_function_identity_arguments(private_fn.oid) =
            pg_catalog.pg_get_function_identity_arguments(public_fn.oid)
        JOIN pg_catalog.pg_namespace private_ns
          ON private_ns.oid = private_fn.pronamespace AND private_ns.nspname = 'ci_private'
        WHERE public_ns.nspname = 'public'
          AND public_fn.proname LIKE 'ci\\_%' ESCAPE '\\'
          AND private_fn.prosecdef
          AND NOT public_fn.prosecdef
        ORDER BY public_fn.proname, identity_arguments
      `);

      assert.ok(wrappers.rowCount && wrappers.rowCount > 0, 'the migration must move privileged RPC implementations');
      for (const wrapper of wrappers.rows) {
        assert.equal(wrapper.public_arguments, wrapper.private_arguments, `${wrapper.proname} argument contract must be preserved`);
        assert.equal(wrapper.public_result, wrapper.private_result, `${wrapper.proname} return type must be preserved`);
        assert.equal(wrapper.public_set, wrapper.private_set, `${wrapper.proname} set-return behavior must be preserved`);
        assert.equal(wrapper.public_volatility, wrapper.private_volatility, `${wrapper.proname} volatility must be preserved`);
        assert.equal(wrapper.public_strict, wrapper.private_strict, `${wrapper.proname} null behavior must be preserved`);
        assert.equal(wrapper.public_parallel, wrapper.private_parallel, `${wrapper.proname} parallel mode must be preserved`);
        assert.ok(wrapper.public_config?.includes('search_path=""'), `${wrapper.proname} wrapper search_path must be fixed`);
        assert.ok(wrapper.private_config?.includes('search_path=""'), `${wrapper.proname} private implementation search_path must be fixed`);
        assert.equal(wrapper.anonymous_execute, false, `${wrapper.proname} must not be executable by anon`);
        assert.equal(wrapper.authenticated_grants_match, true, `${wrapper.proname} authenticated grant must match the private implementation`);
        assert.equal(wrapper.service_role_grants_match, true, `${wrapper.proname} service_role grant must match the private implementation`);
      }

      const serviceRoleFunctions = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ci_private'
          AND p.prosecdef
          AND p.proname LIKE 'ci\\_%' ESCAPE '\\'
          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      `);
      if (Number(serviceRoleFunctions.rows[0].count) > 0) {
        const usage = await client.query<{ allowed: boolean }>(`SELECT has_schema_privilege('service_role', 'ci_private', 'USAGE') AS allowed`);
        assert.equal(usage.rows[0].allowed, true, 'service_role must resolve only its already-authorized private RPCs');
      }
    } finally {
      await client.end();
    }

    const config = await readFile(path.join(process.cwd(), 'supabase/config.toml'), 'utf8');
    const exposedSchemas = config.match(/^\s*schemas\s*=\s*\[([^\]]*)\]/m)?.[1];
    assert.ok(exposedSchemas, 'Supabase API schema allowlist must be explicit');
    assert.doesNotMatch(exposedSchemas, /ci_private/, 'ci_private must remain outside the PostgREST exposed schemas');
  } finally {
    const cleanup = await connect(adminUrl.toString());
    try {
      await cleanup.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
