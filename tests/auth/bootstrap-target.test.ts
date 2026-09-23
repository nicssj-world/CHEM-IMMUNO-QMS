import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBootstrapTarget } from '../../scripts/bootstrap-admin-target';

test('local bootstrap accepts only the local Supabase API with an explicit flag', () => {
  assert.deepEqual(resolveBootstrapTarget('http://127.0.0.1:54321', undefined, true), {
    environment: 'local', projectRef: null,
  });
  assert.throws(() => resolveBootstrapTarget('http://127.0.0.1:54321', undefined, false), /explicit --allow-local/);
  assert.throws(() => resolveBootstrapTarget('http://127.0.0.1:3000', undefined, true), /local Supabase API/);
});

test('hosted bootstrap requires HTTPS and an exact, separately approved Preview ref', () => {
  assert.deepEqual(resolveBootstrapTarget('https://preview123.supabase.co', 'preview123', false), {
    environment: 'preview', projectRef: 'preview123',
  });
  assert.throws(() => resolveBootstrapTarget('http://preview123.supabase.co', 'preview123', false), /HTTPS/);
  assert.throws(() => resolveBootstrapTarget('https://preview123.supabase.co', undefined, false), /match the separate Preview/);
  assert.throws(() => resolveBootstrapTarget('https://preview123.supabase.co', 'different123', false), /match the separate Preview/);
});

test('bootstrap refuses the protected Production project even if supplied as expected target', () => {
  assert.throws(
    () => resolveBootstrapTarget('https://lvddgcogfcvcsaajdqvl.supabase.co', 'lvddgcogfcvcsaajdqvl', false),
    /protected Production/,
  );
});

test('hosted bootstrap rejects URLs with credentials or extra URL components', () => {
  assert.throws(() => resolveBootstrapTarget('https://user:pass@preview123.supabase.co', 'preview123', false), /clean HTTPS/);
  assert.throws(() => resolveBootstrapTarget('https://preview123.supabase.co/path', 'preview123', false), /clean HTTPS/);
  assert.throws(() => resolveBootstrapTarget('https://preview123.supabase.co.attacker.example', 'preview123', false), /Supabase URL/);
});
