import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOwnMonitoring, latestConfigByLocation, resolveEnvironmentMonitor, type MonitorConfig, type MonitorLocation } from '../../src/lib/environment-monitor';

const fridge = 'f-1';
const shelf = 's-1';
const shelfOwn = 's-2';
const cabinet = 'c-1';
const cabinetShelf = 'c-s-1';
const room = 'r-1';
const locations: MonitorLocation[] = [
  { id: room, parent_location_id: null }, { id: fridge, parent_location_id: null }, { id: shelf, parent_location_id: fridge }, { id: shelfOwn, parent_location_id: fridge },
  { id: cabinet, parent_location_id: null }, { id: cabinetShelf, parent_location_id: cabinet },
];
const version = (location_id: string, effective_from: string, temperature_monitored: boolean, humidity_monitored = false): MonitorConfig => ({ location_id, effective_from, temperature_monitored, humidity_monitored });

test('a monitored container resolves to itself, and an unconfigured shelf inherits its container', () => {
  const configs = [version(fridge, '2026-09-26T08:00:00.000001+00:00', true)];
  assert.equal(resolveEnvironmentMonitor(fridge, locations, configs), fridge);
  assert.equal(resolveEnvironmentMonitor(shelf, locations, configs), fridge);
  assert.equal(resolveEnvironmentMonitor(shelfOwn, locations, configs), fridge);
});

test('a shelf with its own monitoring keeps it (humidity only counts too)', () => {
  const configs = [version(fridge, '2026-09-26T08:00:00+00:00', true), version(shelfOwn, '2026-09-26T09:00:00+00:00', false, true)];
  assert.equal(resolveEnvironmentMonitor(shelfOwn, locations, configs), shelfOwn);
  assert.equal(resolveEnvironmentMonitor(shelf, locations, configs), fridge);
});

test('no monitoring anywhere resolves to null', () => {
  assert.equal(resolveEnvironmentMonitor(room, locations, []), null);
  assert.equal(resolveEnvironmentMonitor(cabinetShelf, locations, []), null);
  assert.equal(resolveEnvironmentMonitor(cabinetShelf, locations, [version(room, '2026-09-26T08:00:00+00:00', true)]), null, 'an unrelated monitored location does not leak in');
  assert.equal(resolveEnvironmentMonitor('unknown', locations, [version(fridge, '2026-09-26T08:00:00+00:00', true)]), null);
});

test('only the latest version counts: turning monitoring off removes inheritance, turning it on restores it', () => {
  const on = version(fridge, '2026-09-26T08:00:00.000001+00:00', true);
  const off = version(fridge, '2026-09-26T09:00:00.000000+00:00', false, false);
  const again = version(fridge, '2026-09-26T10:00:00.000000+00:00', false, true);
  assert.equal(resolveEnvironmentMonitor(shelf, locations, [on, off]), null);
  assert.equal(resolveEnvironmentMonitor(fridge, locations, [on, off]), null);
  assert.equal(resolveEnvironmentMonitor(shelf, locations, [off, on]), null, 'input order does not matter');
  assert.equal(resolveEnvironmentMonitor(shelf, locations, [on, off, again]), fridge);
  // Versions written microseconds apart (Date cannot tell them apart) still order correctly.
  const first = version(fridge, '2026-09-26T08:00:00.123456+00:00', true);
  const second = version(fridge, '2026-09-26T08:00:00.123457+00:00', false);
  assert.equal(resolveEnvironmentMonitor(fridge, locations, [first, second]), null);
  assert.equal(resolveEnvironmentMonitor(fridge, locations, [second, first]), null);
});

test('a child with its own monitoring off falls back to its parent again', () => {
  const configs = [version(fridge, '2026-09-26T08:00:00+00:00', true), version(shelfOwn, '2026-09-26T09:00:00+00:00', true), version(shelfOwn, '2026-09-26T10:00:00+00:00', false)];
  assert.equal(resolveEnvironmentMonitor(shelfOwn, locations, configs), fridge);
});

test('rows hidden by row-level security are simply absent, and resolve to null', () => {
  const visible = locations.filter(location => location.id !== fridge);
  const configs = [version(fridge, '2026-09-26T08:00:00+00:00', true)];
  assert.equal(resolveEnvironmentMonitor(shelf, visible, configs), null, 'the parent is not readable, so nothing is inherited from it');
  assert.equal(resolveEnvironmentMonitor(fridge, visible, configs), null);
});

test('helpers: latest configuration per location and own-monitoring check', () => {
  const latest = latestConfigByLocation([version(fridge, '2026-09-26T08:00:00+00:00', true), version(fridge, '2026-09-26T09:00:00+00:00', false), version(shelfOwn, '2026-09-26T07:00:00+00:00', true)]);
  assert.equal(latest.get(fridge)?.temperature_monitored, false);
  assert.equal(latest.get(shelfOwn)?.temperature_monitored, true);
  assert.equal(latest.size, 2);
  assert.equal(hasOwnMonitoring(undefined), false);
  assert.equal(hasOwnMonitoring(null), false);
  assert.equal(hasOwnMonitoring({ temperature_monitored: false, humidity_monitored: false }), false);
  assert.equal(hasOwnMonitoring({ temperature_monitored: false, humidity_monitored: true }), true);
});
