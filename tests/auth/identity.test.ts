import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canMutateRole,
  canSuperviseRole,
  internalAuthEmail,
  normalizeEphisId,
  resolveAppAccess,
} from '../../src/lib/auth-identity';

test('normalizes Ephis IDs before deriving a private deterministic Auth email', () => {
  assert.equal(normalizeEphisId('  AbC-42.X  '), 'abc-42.x');
  assert.equal(internalAuthEmail('  AbC-42.X  '), 'ephis.abc-42.x@chem-immuno.internal');
  assert.equal(internalAuthEmail('not an id'), null);
});

test('rejects Ephis IDs that cannot safely map to one internal identity', () => {
  for (const value of ['', ' has space ', 'a@b', 'x'.repeat(65), 'é123']) {
    assert.equal(normalizeEphisId(value), null, `expected ${JSON.stringify(value)} to be invalid`);
  }
});

const profile = { ephis_id: 'chemist-7', display_name: 'Test Chemist', active: true };
const chemistryOnly = [{
  warehouse_id: 1,
  role: 'staff',
  active: true,
  ci_warehouses: { id: 1, code: 'CHE', name: 'CLINICAL CHEMISTRY' },
}];

test('resolves only active, valid warehouse permissions bound to the authenticated Ephis identity', () => {
  const access = resolveAppAccess('user-1', 'ephis.chemist-7@chem-immuno.internal', profile, chemistryOnly, 'CHEMIST-7');
  assert.deepEqual(access, {
    userId: 'user-1',
    ephisId: 'chemist-7',
    displayName: 'Test Chemist',
    warehouses: [{ id: '1', code: 'CHE', name: 'CLINICAL CHEMISTRY', role: 'staff' }],
  });
});

test('fails closed for inactive, mismatched, malformed, or empty application access', () => {
  const validEmail = 'ephis.chemist-7@chem-immuno.internal';
  assert.equal(resolveAppAccess('user-1', validEmail, { ...profile, active: false }, chemistryOnly), null);
  assert.equal(resolveAppAccess('user-1', validEmail, profile, chemistryOnly, 'someone-else'), null);
  assert.equal(resolveAppAccess('user-1', 'unrelated@example.com', profile, chemistryOnly), null);
  assert.equal(resolveAppAccess('user-1', validEmail, profile, [{ ...chemistryOnly[0], role: 'owner' }]), null);
  assert.equal(resolveAppAccess('user-1', validEmail, profile, [{ ...chemistryOnly[0], active: false }]), null);
  assert.equal(resolveAppAccess('user-1', validEmail, profile, []), null);
});

test('role helpers keep Viewer read-only and Supervisor/Admin approval rights explicit', () => {
  assert.equal(canMutateRole('viewer'), false);
  assert.equal(canMutateRole('staff'), true);
  assert.equal(canSuperviseRole('staff'), false);
  assert.equal(canSuperviseRole('supervisor'), true);
  assert.equal(canSuperviseRole('admin'), true);
});
