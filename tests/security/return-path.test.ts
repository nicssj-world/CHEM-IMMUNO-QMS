import assert from 'node:assert/strict';
import test from 'node:test';
import { safeReturnPath } from '@/lib/return-path';

test('login return path keeps same-site app paths with their query', () => {
  assert.equal(safeReturnPath('/issue?warehouse=IMM&product=abc'), '/issue?warehouse=IMM&product=abc');
  assert.equal(safeReturnPath('/counts/123'), '/counts/123');
});

test('login return path refuses other hosts, protocol-relative and backslash tricks', () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined]) assert.equal(safeReturnPath(value), null);
});

test('login return path never loops back to the login page', () => {
  assert.equal(safeReturnPath('/login'), null);
  assert.equal(safeReturnPath('/login?next=/issue'), null);
});
