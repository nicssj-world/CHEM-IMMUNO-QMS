import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTION_SUPABASE_PROJECT_REF,
  PRODUCTION_SUPABASE_URL,
  resolveBootstrapTarget,
} from '../../scripts/bootstrap-admin-target';

test('local bootstrap accepts only the local Supabase API with an explicit flag', () => {
  assert.deepEqual(resolveBootstrapTarget('http://127.0.0.1:54321', undefined, true), {
    environment: 'local', projectRef: null,
  });
  assert.throws(() => resolveBootstrapTarget('http://127.0.0.1:54321', undefined, false), /explicit --allow-local/);
  assert.throws(() => resolveBootstrapTarget('http://127.0.0.1:3000', undefined, true), /local Supabase API/);
  assert.throws(
    () => resolveBootstrapTarget('http://127.0.0.1:54321', undefined, true, true),
    /Production rollout flag requires the exact Production URL/,
  );
});

test('CHEM-IMMUNO Production identity is the corrected Supabase project', () => {
  assert.equal(PRODUCTION_SUPABASE_PROJECT_REF, 'nivlnbaveanoawfbrmzz');
  assert.equal(PRODUCTION_SUPABASE_URL, 'https://nivlnbaveanoawfbrmzz.supabase.co');
});

test('Production bootstrap requires an exact target and explicit rollout authorization', () => {
  assert.deepEqual(
    resolveBootstrapTarget(PRODUCTION_SUPABASE_URL, PRODUCTION_SUPABASE_PROJECT_REF, false, true),
    { environment: 'production', projectRef: PRODUCTION_SUPABASE_PROJECT_REF },
  );
  assert.throws(
    () => resolveBootstrapTarget(PRODUCTION_SUPABASE_URL, PRODUCTION_SUPABASE_PROJECT_REF, false),
    /explicit --production-rollout/,
  );
  assert.throws(
    () => resolveBootstrapTarget(PRODUCTION_SUPABASE_URL, undefined, false, true),
    /CI_EXPECTED_SUPABASE_PROJECT_REF/,
  );
  assert.throws(
    () => resolveBootstrapTarget(PRODUCTION_SUPABASE_URL, 'unexpected123', false, true),
    /CI_EXPECTED_SUPABASE_PROJECT_REF/,
  );
});

test('the previously supplied ref is rejected as an unexpected hosted project', () => {
  assert.throws(
    () => resolveBootstrapTarget(
      'https://lvddgcogfcvcsaajdqvl.supabase.co',
      'lvddgcogfcvcsaajdqvl',
      false,
      true,
    ),
    /Unexpected hosted Supabase project/,
  );
});

test('any unexpected hosted Supabase project is rejected', () => {
  assert.throws(
    () => resolveBootstrapTarget('https://otherhosted123.supabase.co', 'otherhosted123', false, true),
    /Unexpected hosted Supabase project/,
  );
});

test('hosted bootstrap rejects non-HTTPS and URLs with credentials or extra components', () => {
  assert.throws(
    () => resolveBootstrapTarget('http://nivlnbaveanoawfbrmzz.supabase.co', PRODUCTION_SUPABASE_PROJECT_REF, false, true),
    /HTTPS/,
  );
  assert.throws(
    () => resolveBootstrapTarget('https://nivlnbaveanoawfbrmzz.supabase.co:8443', PRODUCTION_SUPABASE_PROJECT_REF, false, true),
    /clean HTTPS/,
  );
  assert.throws(
    () => resolveBootstrapTarget('https://user:pass@nivlnbaveanoawfbrmzz.supabase.co', PRODUCTION_SUPABASE_PROJECT_REF, false, true),
    /clean HTTPS/,
  );
  assert.throws(
    () => resolveBootstrapTarget('https://nivlnbaveanoawfbrmzz.supabase.co/path', PRODUCTION_SUPABASE_PROJECT_REF, false, true),
    /clean HTTPS/,
  );
  assert.throws(
    () => resolveBootstrapTarget('https://nivlnbaveanoawfbrmzz.supabase.co.attacker.example', PRODUCTION_SUPABASE_PROJECT_REF, false, true),
    /Supabase URL/,
  );
});
