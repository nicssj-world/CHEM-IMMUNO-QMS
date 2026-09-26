import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_APP_ORIGIN, appOrigin, detectLocationQr, isLocationQrToken, locationQrPath, locationQrScan, locationQrUrl, looksLikeLocationQr } from '../../src/lib/location-qr';
import { qrDataUri, qrSvg } from '../../src/lib/qr';
import { parseBarcode } from '../../src/lib/barcode';

const token = '0123456789abcdef0123456789abcdef';

test('a QR token is exactly 32 lower-case hex characters', () => {
  assert.ok(isLocationQrToken(token));
  for (const bad of ['', token.slice(1), `${token}0`, token.toUpperCase(), `${token.slice(0, 31)}g`, ` ${token}`, `${token}\n`, '0123456789abcdef-123456789abcdef', 'x'.repeat(32)]) assert.equal(isLocationQrToken(bad), false, JSON.stringify(bad));
  assert.equal(isLocationQrToken(null), false);
  assert.equal(isLocationQrToken(undefined), false);
});

test('the printed origin comes from configuration, never from a request', () => {
  assert.equal(appOrigin(undefined), DEFAULT_APP_ORIGIN);
  assert.equal(appOrigin(''), DEFAULT_APP_ORIGIN);
  assert.equal(appOrigin('https://example.org/'), 'https://example.org');
  assert.equal(appOrigin('  https://example.org/some/path?x=1  '), 'https://example.org', 'only the origin is kept');
  assert.equal(appOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(appOrigin('javascript:alert(1)'), DEFAULT_APP_ORIGIN);
  assert.equal(appOrigin('not a url'), DEFAULT_APP_ORIGIN);
  assert.equal(DEFAULT_APP_ORIGIN, 'https://chem-immuno-cbh.vercel.app');
  assert.equal(locationQrUrl(token), `${DEFAULT_APP_ORIGIN}/q/${token}`);
  assert.equal(locationQrUrl(token, 'https://example.org'), `https://example.org/q/${token}`);
  assert.equal(locationQrPath(token), `/q/${token}`);
});

test('detectLocationQr accepts exactly a /q/{token} link and always returns an app-relative path', () => {
  assert.deepEqual(detectLocationQr(`https://chem-immuno-cbh.vercel.app/q/${token}`), { token, path: `/q/${token}` });
  assert.deepEqual(detectLocationQr(`https://chem-immuno-cbh.vercel.app/q/${token}/`), { token, path: `/q/${token}` }, 'trailing slash');
  assert.deepEqual(detectLocationQr(`  https://chem-immuno-cbh.vercel.app/q/${token}  `), { token, path: `/q/${token}` }, 'surrounding whitespace from a scanner');
  assert.deepEqual(detectLocationQr(`http://localhost:3000/q/${token}`), { token, path: `/q/${token}` }, 'a label printed from a developer machine');
  const otherHost = detectLocationQr(`https://elsewhere.example/q/${token}`);
  assert.deepEqual(otherHost, { token, path: `/q/${token}` }, 'the host is ignored and never followed: the link is relative to this app');
  for (const bad of [
    `https://chem-immuno-cbh.vercel.app/q/${token.toUpperCase()}`, `https://chem-immuno-cbh.vercel.app/q/${token.slice(1)}`, `https://chem-immuno-cbh.vercel.app/q/${token}0`,
    `https://chem-immuno-cbh.vercel.app/q/${token}?x=1`, `https://chem-immuno-cbh.vercel.app/q/${token}#x`, `https://chem-immuno-cbh.vercel.app/x/q/${token}`,
    `https://chem-immuno-cbh.vercel.app/q/${token}/extra`, `ftp://chem-immuno-cbh.vercel.app/q/${token}`, `javascript:alert(1)//q/${token}`, `/q/${token}`, token, `q/${token}`, '', '(01)00012345678905',
  ]) assert.equal(detectLocationQr(bad), null, JSON.stringify(bad));
  assert.equal(detectLocationQr(null), null);
});

test('looksLikeLocationQr is the broader check used to refuse barcode mappings', () => {
  assert.ok(looksLikeLocationQr(`https://chem-immuno-cbh.vercel.app/q/${token}`));
  assert.ok(looksLikeLocationQr(`https://chem-immuno-cbh.vercel.app/q/${token.toUpperCase()}`), 'upper case');
  assert.ok(looksLikeLocationQr(`https://chem-immuno-cbh.vercel.app/q/${token}?utm=x`), 'query string');
  assert.ok(looksLikeLocationQr(`HTTPS://CHEM-IMMUNO-CBH.VERCEL.APP/q/${token}/#frag`));
  // Hardware-scanner and hand-typed variants that must still be refused as barcodes.
  assert.ok(looksLikeLocationQr(`chem-immuno-cbh.vercel.app/q/${token}`), 'no scheme');
  assert.ok(looksLikeLocationQr(`]Q1https://chem-immuno-cbh.vercel.app/q/${token}`), 'AIM symbology prefix from a scanner');
  assert.ok(looksLikeLocationQr(`/q/${token}`), 'path only');
  assert.ok(looksLikeLocationQr(`q/${token}`), 'bare token path');
  assert.ok(looksLikeLocationQr(`https://chem-immuno-cbh.vercel.app/q/${token}\r\n`), 'trailing CR/LF');
  assert.ok(looksLikeLocationQr(`https://evil.example/app/q/${token}?x=1`), 'foreign host with a similar path');
  for (const other of [
    '(01)00012345678905(17)270101(10)LOT-A', '+H123ABC0100/$$52001510X3', 'E2E-MAP-APPROVE', `https://chem-immuno-cbh.vercel.app/q/short`,
    `https://example.org/products/${token}`, `https://chem-immuno-cbh.vercel.app/qr/${token}`, `https://x.example/q/${token.slice(1)}`, `https://x.example/q/${token}0`,
    `+HABCQ/${token}`, `ABCq/${token}`, '', null, undefined,
  ]) {
    assert.equal(looksLikeLocationQr(other as string), false, String(other));
  }
});

test('the scanner guard turns a Location QR into a distinct result before any barcode parsing', () => {
  const scanned = `https://chem-immuno-cbh.vercel.app/q/${token}`;
  const result = locationQrScan(scanned, 'QR_CODE');
  assert.ok(result);
  assert.deepEqual(result.locationQr, { path: `/q/${token}` });
  assert.match(result.message, /นี่คือ QR ตำแหน่งจัดเก็บ/);
  assert.equal(result.parsed.raw, scanned);
  assert.equal(result.parsed.standard, 'UNKNOWN');
  assert.deepEqual(result.parsed.warnings, [], 'it is not reported as an unrecognised barcode');
  assert.equal((result as Record<string, unknown>).productId, undefined, 'it carries no product');
  assert.equal((result as Record<string, unknown>).invoiceLineId, undefined);
  // Loose matches (upper case, query string) are still recognised and refused, but get no link.
  assert.deepEqual(locationQrScan(`${scanned}?x=1`, 'manual')?.locationQr, { path: null });
  assert.deepEqual(locationQrScan(`https://x.example/q/${token.toUpperCase()}`, 'manual')?.locationQr, { path: null });
  assert.deepEqual(locationQrScan(`]Q1https://chem-immuno-cbh.vercel.app/q/${token}`, 'manual')?.locationQr, { path: null }, 'refused even with a scanner prefix');
  assert.deepEqual(locationQrScan(`chem-immuno-cbh.vercel.app/q/${token}`, 'manual')?.locationQr, { path: null });
  // Real barcodes are untouched and keep going through the normal parser.
  for (const barcode of ['(01)00012345678905(17)270101(10)LOT-A', '(240)E2E-MAP-APPROVE', '+H123ABC0100/$$52001510X3', 'ABC-123', 'https://example.org/product/42']) {
    assert.equal(locationQrScan(barcode, 'manual'), null, barcode);
  }
  assert.equal(parseBarcode('(01)00012345678905(17)270101(10)LOT-A').standard, 'GS1', 'GS1 parsing is unchanged');
});

test('the scanner actions call the guard before parsing and refuse Location QR barcode proposals', async () => {
  const source = (await readFile(path.join(process.cwd(), 'src/app/actions/scanner.ts'), 'utf8')).replace(/\r\n/g, '\n');
  const resolveScan = source.slice(source.indexOf('export async function resolveScan'), source.indexOf('export async function proposeScanMapping'));
  const resolveProduct = source.slice(source.indexOf('export async function resolveProductScan'));
  for (const [name, body] of [['resolveScan', resolveScan], ['resolveProductScan', resolveProduct]] as const) {
    const guard = body.indexOf('locationQrScan(raw, symbology)');
    assert.ok(guard > 0, `${name} runs the Location QR guard`);
    assert.ok(guard < body.indexOf('parseBarcode('), `${name}: the guard runs before barcode parsing`);
    assert.ok(guard < body.indexOf('matchApprovedIdentifiers('), `${name}: the guard runs before any product lookup`);
    assert.ok(guard < body.indexOf('ci_record_scan'), `${name}: a Location QR is not recorded as a scan`);
  }
  const propose = source.slice(source.indexOf('export async function proposeScanMapping'), source.indexOf('export async function decideScanMapping'));
  assert.match(propose, /looksLikeLocationQr\(raw\) \|\| looksLikeLocationQr\(value\)/);
  assert.ok(propose.indexOf('CI_LOCATION_QR_NOT_A_BARCODE') < propose.indexOf('ci_propose_identifier_mapping'), 'the refusal comes before the mapping RPC');
  const camera = await readFile(path.join(process.cwd(), 'src/components/barcode-scanner.tsx'), 'utf8');
  assert.match(camera, /DATA_MATRIX/); assert.match(camera, /CODE_128/);
  assert.doesNotMatch(camera, /QR_CODE/, 'the product scanner camera still decodes only Data Matrix and Code 128 in Phase 1');
});

test('QR generation returns a scannable SVG for a label URL', async () => {
  const svg = await qrSvg(locationQrUrl(token));
  assert.match(svg, /^<\?xml|^<svg/);
  assert.match(svg, /<svg[^>]+viewBox=/);
  const uri = await qrDataUri(locationQrUrl(token));
  assert.ok(uri.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.doesNotMatch(uri, /<svg/, 'the SVG is percent-encoded inside the data URI');
  assert.notEqual(await qrSvg(locationQrUrl('f'.repeat(32))), svg, 'different tokens give different codes');
});
