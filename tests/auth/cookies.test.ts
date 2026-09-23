import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_COOKIE_OPTIONS } from '../../src/lib/supabase/cookies';

test('CHEM-IMMUNO Auth uses its own HttpOnly same-site session cookie', () => {
  assert.equal(AUTH_COOKIE_OPTIONS.name, 'chem-immuno-cbh-auth');
  assert.equal(AUTH_COOKIE_OPTIONS.httpOnly, true);
  assert.equal(AUTH_COOKIE_OPTIONS.sameSite, 'lax');
  assert.equal(AUTH_COOKIE_OPTIONS.path, '/');
});
