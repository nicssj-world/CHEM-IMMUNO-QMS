import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBootstrapArguments } from '../../scripts/bootstrap-admin-args';

test('bootstrap accepts identity options and protected stdin password input', () => {
  assert.deepEqual(parseBootstrapArguments(['--allow-local','--ephis','E100','--name','Local Admin','--password-stdin']), {
    ephisId: 'E100', displayName: 'Local Admin', passwordFromStdin: true, allowLocal: true,
  });
});

test('bootstrap refuses passwords in process arguments before they can be echoed by npm', () => {
  assert.throws(
    () => parseBootstrapArguments(['--ephis','E100','--name','Local Admin','--password','test-only-value']),
    /Password arguments are refused/,
  );
});

test('bootstrap requires Ephis ID and display name and rejects unknown options', () => {
  assert.throws(() => parseBootstrapArguments(['--ephis','E100']), /Provide --ephis and --name/);
  assert.throws(() => parseBootstrapArguments(['--ephis','E100','--name','Admin','unexpected']), /Invalid bootstrap option/);
});
