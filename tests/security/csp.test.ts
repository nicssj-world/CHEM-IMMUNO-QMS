import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContentSecurityPolicy } from '@/lib/csp';

test('production CSP uses a per-request nonce and only the configured Supabase origins', () => {
  const policy = buildContentSecurityPolicy({
    nonce: 'AbCdEf0123456789+/==',
    supabaseUrl: 'https://project.supabase.co',
  });
  assert.match(policy, /script-src 'self' 'nonce-AbCdEf0123456789\+\/==' 'strict-dynamic'/);
  assert.match(policy, /connect-src 'self' https:\/\/project\.supabase\.co wss:\/\/project\.supabase\.co/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /unsafe-eval|unsafe-inline/);
});

test('development CSP permits local Supabase and Next development runtime only', () => {
  const policy = buildContentSecurityPolicy({
    nonce: 'devnonce12345678',
    supabaseUrl: 'http://127.0.0.1:54321',
    development: true,
  });
  assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:54321 ws:\/\/127\.0\.0\.1:54321/);
  assert.match(policy, /script-src .*'unsafe-eval'/);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(policy, /style-src[^;]*nonce-/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test('Production local-database build does not upgrade loopback Supabase to HTTPS', () => {
  const policy = buildContentSecurityPolicy({ nonce: 'buildnonce123456', supabaseUrl: 'http://127.0.0.1:54321' });
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test('invalid nonce is rejected and URL text cannot inject directives', () => {
  assert.throws(() => buildContentSecurityPolicy({ nonce: 'bad; script-src *' }), /Invalid CSP nonce/);
  const policy = buildContentSecurityPolicy({ nonce: 'safeNonce12345678', supabaseUrl: 'https://safe.supabase.co/path;script-src=*' });
  assert.match(policy, /connect-src 'self' https:\/\/safe\.supabase\.co wss:\/\/safe\.supabase\.co/);
  assert.doesNotMatch(policy, /path|script-src=\*/);
});
