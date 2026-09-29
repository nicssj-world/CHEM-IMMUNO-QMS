import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PORTAL_HOSTS, PORTAL_URL_MAX_LENGTH, portalAllowedHosts, validatePortalEquipmentUrl } from '../../src/lib/portal-link';

const id = '123e4567-e89b-42d3-a456-426614174000';
const valid = `https://lab-management-cbh.vercel.app/staff/equipment/${id}`;
const reason = (input: string, hosts?: readonly string[]) => { const result = validatePortalEquipmentUrl(input, hosts); return result.ok ? 'ok' : result.reason; };

test('a production Portal equipment URL is accepted and normalised', () => {
  assert.deepEqual(validatePortalEquipmentUrl(valid), { ok: true, url: valid });
  assert.deepEqual(validatePortalEquipmentUrl(`  ${valid}  `), { ok: true, url: valid }, 'surrounding spaces are trimmed');
  assert.equal(reason(`${valid}/history`), 'ok', 'a sub-page of the same equipment is allowed');
  assert.equal(reason(`${valid}?open=1#top`), 'ok');
  assert.equal(reason(`https://lab-management-cbh.vercel.app/STAFF/EQUIPMENT/${id}`), 'path', 'the route segments are case-sensitive, like the Portal routes');
  assert.equal(reason(`https://LAB-MANAGEMENT-CBH.VERCEL.APP/staff/equipment/${id}`), 'ok', 'host case does not matter');
  assert.equal(reason(`https://lab-management-cbh.vercel.app/staff/equipment/${id.toUpperCase()}`), 'ok', 'uuid case does not matter');
});

test('unsafe or non-Portal values are rejected with a reason', () => {
  assert.equal(reason(''), 'empty');
  assert.equal(reason('   '), 'empty');
  assert.equal(reason(valid.replace('https:', 'http:')), 'not_https', 'http');
  assert.equal(reason(`javascript:alert(1)//${valid}`), 'not_https', 'javascript: hiding a real URL after it');
  assert.equal(reason('javascript:alert(1)'), 'not_https');
  assert.equal(reason('data:text/html,<script>alert(1)</script>'), 'not_https', 'data:');
  assert.equal(reason(`ftp://lab-management-cbh.vercel.app/staff/equipment/${id}`), 'not_https');
  assert.equal(reason(`//lab-management-cbh.vercel.app/staff/equipment/${id}`), 'invalid', 'protocol-relative');
  assert.equal(reason(`https://evil.example/staff/equipment/${id}`), 'host', 'wrong host');
  assert.equal(reason(`https://lab-management-cbh.vercel.app.evil.example/staff/equipment/${id}`), 'host', 'allowed host as a prefix of another');
  assert.equal(reason(`https://evil.example/lab-management-cbh.vercel.app/staff/equipment/${id}`), 'host', 'allowed host only in the path');
  assert.equal(reason(`https://x.lab-management-cbh.vercel.app/staff/equipment/${id}`), 'host', 'subdomains are not allowed unless listed');
  assert.equal(reason(`https://lab-management-cbh.vercel.app@evil.example/staff/equipment/${id}`), 'credentials', 'userinfo that hides the real host');
  assert.equal(reason(`https://user:pass@lab-management-cbh.vercel.app/staff/equipment/${id}`), 'credentials', 'userinfo');
  assert.equal(reason(`https://lab-management-cbh.vercel.app:8443/staff/equipment/${id}`), 'port');
  assert.equal(reason('https://lab-management-cbh.vercel.app/staff/equipment/not-a-uuid'), 'path', 'malformed uuid');
  assert.equal(reason('https://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-42661417400'), 'path', 'short uuid');
  assert.equal(reason('https://lab-management-cbh.vercel.app/staff/equipment'), 'path', 'no equipment id');
  assert.equal(reason('https://lab-management-cbh.vercel.app/staff/tests/abc'), 'path', 'another Portal area');
  assert.equal(reason(`https://lab-management-cbh.vercel.app/staff/equipmentx/${id}`), 'path');
  assert.equal(reason(`https://lab-management-cbh.vercel.app/x/staff/equipment/${id}`), 'path');
  assert.equal(reason(`https://lab-management-cbh.vercel.app/staff/equipment/${id}extra`), 'path');
  assert.equal(reason('not a url'), 'invalid');
  assert.equal(reason(`${valid}\nx`), 'invalid', 'control characters are refused, not silently removed');
  assert.equal(reason(`https://lab-management-cbh.vercel.app/staff/equip\tment/${id}`), 'invalid', 'tabs inside the URL');
});

test('IDN and look-alike hosts never equal an allowed ASCII host', () => {
  assert.equal(reason(`https://lаb-management-cbh.vercel.app/staff/equipment/${id}`), 'host', 'Cyrillic а in the host');
  assert.equal(reason(`https://lab-management-cbh.vercеl.app/staff/equipment/${id}`), 'host', 'Cyrillic е in the host');
  assert.equal(reason(`https://xn--lab-management-cbh-x0e.vercel.app/staff/equipment/${id}`), 'invalid', 'a punycode label that is not a valid IDN is refused outright');
  assert.equal(reason(`https://xn--b1abfaaepdrnnbgefbadotcwatmq2g4l.vercel.app/staff/equipment/${id}`), 'host', 'a valid punycode look-alike is simply a different host');
  assert.equal(reason(`https://lab-management-cbh.vercel.app．evil.example/staff/equipment/${id}`), 'host', 'full-width dot separator');
  // Compatibility characters that the URL standard maps onto the real ASCII host are only accepted in canonical form.
  assert.deepEqual(validatePortalEquipmentUrl(`https://ⓛab-management-cbh.vercel.app/staff/equipment/${id}`), { ok: true, url: valid }, 'a circled letter normalises to the real host; the canonical URL is what gets stored');
  assert.equal(reason(`https://lab-management-cbh.vercel.app./staff/equipment/${id}`), 'host', 'trailing-dot root label is a different host string');
});

test('length is capped at 500 characters', () => {
  assert.equal(PORTAL_URL_MAX_LENGTH, 500);
  const long = `${valid}/${'a'.repeat(500)}`;
  assert.ok(long.length > 500);
  assert.equal(reason(long), 'too_long');
  const exact = `${valid}/${'a'.repeat(500 - valid.length - 1)}`;
  assert.equal(exact.length, 500);
  assert.equal(reason(exact), 'ok');
});

test('the allowed host list defaults to the production Portal and can be configured', () => {
  assert.deepEqual(portalAllowedHosts(undefined), DEFAULT_PORTAL_HOSTS);
  assert.deepEqual(portalAllowedHosts(''), DEFAULT_PORTAL_HOSTS);
  assert.deepEqual(portalAllowedHosts(' Portal.Example.org , portal2.example.org ,, '), ['portal.example.org', 'portal2.example.org']);
  const moved = `https://portal.example.org/staff/equipment/${id}`;
  assert.equal(reason(moved), 'host', 'not allowed by default');
  assert.equal(reason(moved, ['portal.example.org']), 'ok');
  assert.equal(reason(valid, ['portal.example.org']), 'host', 'a stored link on the old host stops validating after the domain changes (fail closed)');
});
