import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCATION_TYPES, buildLocationStock, describeEnvConfig, formatRange, isLocationType, isMonitorableType, locationBreadcrumb, locationOptionLabel, locationTypeLabel,
  parentOptions, parseDecimalInput, parseLocationForm, validateEnvConfig, type LocationRow,
} from '../../src/lib/locations';

const portalHosts = ['lab-management-cbh.vercel.app'];
const equipmentUrl = 'https://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-426614174000';
const parent = '11111111-1111-4111-8111-111111111111';

function form(fields: Record<string, string | boolean>) {
  const data = new FormData();
  data.set('code', 'CHE-FR-01'); data.set('name', 'ตู้เย็นน้ำยา Chemistry 1'); data.set('location_type', 'refrigerator');
  for (const [key, value] of Object.entries(fields)) { if (value === true) data.set(key, 'on'); else if (value !== false) data.set(key, String(value)); else data.delete(key); }
  return data;
}
const parse = (fields: Record<string, string | boolean>) => parseLocationForm(form(fields), portalHosts);
const errorsOf = (fields: Record<string, string | boolean>) => { const result = parse(fields); assert.equal(result.ok, false, JSON.stringify(fields)); return result.ok ? {} : result.errors; };
const valueOf = (fields: Record<string, string | boolean>) => { const result = parse(fields); assert.equal(result.ok, true, JSON.stringify(fields)); return result.ok ? result.value : null!; };

test('location types: fixed list, Thai labels, and which types are normally the monitored container', () => {
  assert.deepEqual(LOCATION_TYPES.map(type => type.value), ['room', 'refrigerator', 'freezer', 'cabinet', 'shelf', 'rack', 'bench', 'other']);
  for (const type of ['room', 'refrigerator', 'freezer', 'cabinet']) assert.equal(isMonitorableType(type), true, type);
  for (const type of ['shelf', 'rack', 'bench', 'other', 'unknown', null, undefined]) assert.equal(isMonitorableType(type), false, String(type));
  assert.equal(isLocationType('freezer'), true);
  assert.equal(isLocationType('garage'), false);
  assert.equal(locationTypeLabel('refrigerator'), 'ตู้เย็น');
  assert.equal(locationTypeLabel('nonsense'), 'อื่น ๆ');
});

test('ranges are shown in the lab language, one-sided limits included', () => {
  assert.equal(formatRange(2, 8, '°C'), '2 – 8 °C');
  assert.equal(formatRange('2.00', '8.00', '°C'), '2 – 8 °C', 'trailing zeros are dropped');
  assert.equal(formatRange(2.5, 7.25, '°C'), '2.5 – 7.25 °C');
  assert.equal(formatRange(null, -20, '°C'), '≤ -20 °C');
  assert.equal(formatRange(15, null, '°C'), '≥ 15 °C');
  assert.equal(formatRange(30, 60, '%RH'), '30 – 60 %RH');
  assert.equal(formatRange(null, null, '°C'), null);
  assert.equal(formatRange('', undefined, '°C'), null);
  assert.equal(formatRange(0, 100, '%RH'), '0 – 100 %RH', 'zero is a real bound');
  assert.deepEqual(describeEnvConfig({ temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null }), { temperature: '2 – 8 °C', humidity: null });
  assert.deepEqual(describeEnvConfig({ temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: null }), { temperature: null, humidity: '≥ 30 %RH' });
  assert.deepEqual(describeEnvConfig(undefined), { temperature: null, humidity: null });
});

test('decimal input accepts a phone-friendly minus sign and a decimal comma', () => {
  assert.equal(parseDecimalInput('2.5'), 2.5);
  assert.equal(parseDecimalInput(' 2,5 '), 2.5);
  assert.equal(parseDecimalInput('-20'), -20);
  assert.equal(parseDecimalInput('−20'), -20, 'the Unicode minus a phone keypad inserts');
  assert.equal(parseDecimalInput('–5.5'), -5.5, 'en dash');
  assert.equal(parseDecimalInput('4.126'), 4.13, 'rounded to the two decimals the database stores');
  assert.equal(parseDecimalInput(''), null);
  assert.equal(parseDecimalInput('   '), null);
  assert.equal(parseDecimalInput(null), null);
  for (const bad of ['abc', '1.2.3', '--5', '5-', '1e3', '2 8', '.']) assert.ok(Number.isNaN(parseDecimalInput(bad)), bad);
});

test('range rules: disabled means no bounds, enabled needs one bound, min < max, valid limits', () => {
  const ok = (env: Parameters<typeof validateEnvConfig>[0]) => validateEnvConfig(env).ok;
  const off = { temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };
  assert.equal(ok(off), true);
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: 2, temp_max_c: 8 }), true);
  assert.equal(ok({ ...off, temperature_monitored: true, temp_max_c: -20 }), true, 'a freezer may have only an upper limit');
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: 15 }), true);
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: -100, temp_max_c: 100 }), true, 'inclusive limits');
  assert.equal(ok({ ...off, humidity_monitored: true, rh_min_pct: 0, rh_max_pct: 100 }), true);
  assert.equal(ok({ ...off, temperature_monitored: true }), false, 'monitored with no bound');
  assert.equal(ok({ ...off, temp_min_c: 2 }), false, 'a bound while temperature monitoring is off');
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: 8, temp_max_c: 2 }), false);
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: 5, temp_max_c: 5 }), false, 'min must be strictly below max');
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: -100.01, temp_max_c: 0 }), false);
  assert.equal(ok({ ...off, temperature_monitored: true, temp_min_c: 0, temp_max_c: 100.01 }), false);
  assert.equal(ok({ ...off, humidity_monitored: true }), false);
  assert.equal(ok({ ...off, humidity_monitored: true, rh_min_pct: 60, rh_max_pct: 30 }), false);
  assert.equal(ok({ ...off, humidity_monitored: true, rh_min_pct: -0.01, rh_max_pct: 50 }), false);
  assert.equal(ok({ ...off, humidity_monitored: true, rh_min_pct: 10, rh_max_pct: 100.01 }), false);
  assert.equal(ok({ ...off, humidity_monitored: false, rh_max_pct: 50 }), false);
});

test('the location form builds the RPC payload: trimming, limits, parent, and no schedule fields', () => {
  const value = valueOf({ code: '  CHE-FR-01  ', name: ' ตู้เย็นน้ำยา 1 ', room: ' Clinical Chemistry ', storage_condition: '2–8 °C', description: '', parent_location_id: '', temperature_monitored: true, temp_min_c: '2', temp_max_c: '8' });
  assert.deepEqual(value, {
    code: 'CHE-FR-01', name: 'ตู้เย็นน้ำยา 1', location_type: 'refrigerator', parent_location_id: null, room: 'Clinical Chemistry', description: null, storage_condition: '2–8 °C',
    portal_equipment_url: null, portal_equipment_label: null,
    env: { temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null },
  });
  assert.equal(Object.keys(value.env).some(key => /check|schedule|pause|state/.test(key)), false, 'Phase 1 stores ranges only');
  assert.equal(valueOf({ location_type: 'shelf', parent_location_id: parent }).parent_location_id, parent);
  assert.equal(valueOf({ humidity_monitored: true, rh_min_pct: '30', rh_max_pct: '60', location_type: 'room' }).env.rh_max_pct, 60);
  assert.equal(valueOf({ temperature_monitored: true, temp_max_c: '−20', location_type: 'freezer' }).env.temp_max_c, -20);
});

test('form validation reports one message per field', () => {
  assert.ok(errorsOf({ code: '   ' }).code);
  assert.ok(errorsOf({ code: 'C'.repeat(41) }).code);
  assert.ok(errorsOf({ name: '' }).name);
  assert.ok(errorsOf({ name: 'N'.repeat(121) }).name);
  assert.ok(errorsOf({ location_type: 'garage' }).location_type);
  assert.ok(errorsOf({ parent_location_id: 'not-a-uuid' }).parent_location_id);
  assert.ok(errorsOf({ room: 'R'.repeat(121) }).room);
  assert.ok(errorsOf({ description: 'D'.repeat(1001) }).description);
  assert.ok(errorsOf({ storage_condition: 'S'.repeat(121) }).storage_condition);
  assert.ok(errorsOf({ temperature_monitored: true }).temp_min_c, 'monitored without any bound');
  assert.ok(errorsOf({ temperature_monitored: true, temp_min_c: '9', temp_max_c: '3' }).temp_min_c, 'min must be below max');
  assert.ok(errorsOf({ temperature_monitored: true, temp_min_c: 'abc' }).temp_min_c, 'not a number');
  assert.ok(errorsOf({ temperature_monitored: true, temp_min_c: '0', temp_max_c: '101' }).temp_max_c, 'out of the temperature range');
  assert.ok(errorsOf({ humidity_monitored: true, rh_min_pct: '10', rh_max_pct: '101' }).rh_max_pct, 'out of the humidity range');
  assert.ok(errorsOf({ temp_min_c: '4' }).temp_min_c, 'a bound while monitoring is switched off');
  assert.deepEqual(Object.keys(errorsOf({ code: '', name: '' })).sort(), ['code', 'name']);
});

test('shelves, racks and benches inherit unless the explicit own-monitoring override is ticked', () => {
  const inherit = valueOf({ location_type: 'shelf', temperature_monitored: true, temp_min_c: '2', temp_max_c: '8' });
  assert.deepEqual(inherit.env, { temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null }, 'ignored without the override');
  for (const type of ['shelf', 'rack', 'bench', 'other']) {
    const own = valueOf({ location_type: type, own_monitoring: true, humidity_monitored: true, rh_min_pct: '30', rh_max_pct: '60' });
    assert.equal(own.env.humidity_monitored, true, type);
    assert.equal(own.env.rh_min_pct, 30);
  }
  assert.ok(errorsOf({ location_type: 'shelf', own_monitoring: true, temperature_monitored: true }).temp_min_c, 'the override is validated like any range');
  for (const type of ['room', 'refrigerator', 'freezer', 'cabinet']) assert.equal(valueOf({ location_type: type, temperature_monitored: true, temp_max_c: '8' }).env.temperature_monitored, true, `${type} needs no override`);
  // Switching a fridge to a shelf without the override switches its own monitoring off (a new version), so it inherits again.
  assert.equal(valueOf({ location_type: 'shelf', temperature_monitored: true, temp_max_c: '8' }).env.temperature_monitored, false);
});

test('the Portal link is validated with the allowed hosts and normalised before saving', () => {
  assert.equal(valueOf({ portal_equipment_url: equipmentUrl, portal_equipment_label: 'ตู้เย็น 1' }).portal_equipment_url, equipmentUrl);
  assert.equal(valueOf({ portal_equipment_url: `  ${equipmentUrl}  ` }).portal_equipment_url, equipmentUrl);
  assert.ok(errorsOf({ portal_equipment_url: 'http://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-426614174000' }).portal_equipment_url);
  assert.ok(errorsOf({ portal_equipment_url: 'javascript:alert(1)' }).portal_equipment_url);
  assert.ok(errorsOf({ portal_equipment_url: 'https://evil.example/staff/equipment/123e4567-e89b-42d3-a456-426614174000' }).portal_equipment_url);
  assert.ok(errorsOf({ portal_equipment_url: equipmentUrl, portal_equipment_label: 'x'.repeat(121) }).portal_equipment_label);
  assert.ok(errorsOf({ portal_equipment_label: 'a label without a link' }).portal_equipment_label);
  const custom = parseLocationForm(form({ portal_equipment_url: 'https://portal.example.org/staff/equipment/123e4567-e89b-42d3-a456-426614174000' }), ['portal.example.org']);
  assert.equal(custom.ok, true, 'the host list is configurable');
});

const row = (id: string, code: string, parent_location_id: string | null, extra: Partial<LocationRow> = {}): LocationRow => ({
  id, warehouse_id: 1, code, name: `name ${code}`, active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', location_type: 'other',
  parent_location_id, room: null, description: null, storage_condition: null, portal_equipment_url: null, portal_equipment_label: null, qr_token: 'a'.repeat(32), ...extra,
});

test('breadcrumbs and picker labels show the parent, and parent choices follow the depth-2 rule', () => {
  const rows = [row('a', 'CHE-FR-01', null), row('b', 'S1', 'a'), row('c', 'CHE-FR-02', null), row('d', 'OLD', null, { active: false }), row('e', 'IMM-FR', null, { warehouse_id: 2 })];
  const byId = new Map(rows.map(item => [item.id, item]));
  assert.equal(locationBreadcrumb(rows[0], byId), 'CHE-FR-01');
  assert.equal(locationBreadcrumb(rows[1], byId), 'CHE-FR-01 › S1');
  assert.equal(locationOptionLabel(rows[1], byId), 'CHE-FR-01 › S1 · name S1');
  assert.deepEqual(parentOptions(rows, { warehouseId: 1 }).map(item => item.id), ['a', 'c'], 'top-level, active, same warehouse only');
  assert.deepEqual(parentOptions(rows, { warehouseId: 1, selfId: 'c' }).map(item => item.id), ['a'], 'never itself');
  assert.deepEqual(parentOptions(rows, { warehouseId: 1, selfId: 'a' }), [], 'a location that already has children cannot become a child');
  assert.deepEqual(parentOptions(rows, { warehouseId: 2 }).map(item => item.id), ['e']);
});

test('location stock keeps non-zero ledger balances for the container and its children, oldest expiry first', () => {
  const products = [{ id: 'p1', product_code: 'CHE-0001', display_name: 'Reagent A', base_stock_unit: 'กล่อง' }, { id: 'p2', product_code: 'CHE-0002', display_name: 'Reagent B', base_stock_unit: null }];
  const balances = [
    { product_id: 'p2', lot_id: 'l2', lot_number: 'B-2', expiry_date: '2027-03-01', location_id: 'shelf', balance: '3.000' },
    { product_id: 'p1', lot_id: 'l1', lot_number: 'A-1', expiry_date: '2027-01-01', location_id: 'fridge', balance: 2 },
    { product_id: 'p1', lot_id: 'l3', lot_number: 'A-3', expiry_date: '2027-02-01', location_id: 'fridge', balance: 0 },
    { product_id: 'p1', lot_id: 'l1', lot_number: 'A-1', expiry_date: '2027-01-01', location_id: 'elsewhere', balance: 9 },
  ];
  const stock = buildLocationStock(balances, products, new Map([['fridge', 'CHE-FR-01'], ['shelf', 'CHE-FR-01-S1']]));
  assert.deepEqual(stock.map(item => [item.product_code, item.lot_number, item.location_code, item.quantity, item.unit]), [
    ['CHE-0001', 'A-1', 'CHE-FR-01', 2, 'กล่อง'], ['CHE-0002', 'B-2', 'CHE-FR-01-S1', 3, null],
  ]);
  assert.equal(stock.reduce((sum, item) => sum + item.quantity, 0), 5, 'zero balances and other locations are excluded');
  assert.deepEqual(buildLocationStock([], products, new Map()), []);
});
