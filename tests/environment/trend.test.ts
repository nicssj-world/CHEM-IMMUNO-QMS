import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableMetrics, bandChanges, bandSegments, bangkokDayStart, buildTrendSeries, describePoint, formatBangkokDateTime, formatLimits,
  formatMeasure, formatTick, lineRuns, metricsForView, MAX_CUSTOM_RANGE_DAYS, normalizeMetricView, resolveChartTarget, resolveTrendRange,
  summarizeSeries, timeTicks, valueDomain, versionsInForce, type TrendConfig, type TrendReading,
} from '../../src/lib/environment-trend';
import { fetchAllPages, trendMetrics } from '../../src/lib/environment-trend-data';

const cfg = (id: string, effective_from: string, temp: [number | null, number | null] | null, rh: [number | null, number | null] | null = null, location_id = 'fridge'): TrendConfig => ({
  id, location_id, effective_from,
  temperature_monitored: temp !== null, temp_min_c: temp?.[0] ?? null, temp_max_c: temp?.[1] ?? null,
  humidity_monitored: rh !== null, rh_min_pct: rh?.[0] ?? null, rh_max_pct: rh?.[1] ?? null,
});
let serial = 0;
const reading = (over: Partial<TrendReading> & Pick<TrendReading, 'observed_at'>): TrendReading => ({
  id: `r-${++serial}`, config_id: 'v1', recorded_at: over.observed_at, entry_kind: 'original', corrects_reading_id: null,
  temperature_c: 5, humidity_rh: null, temperature_status: 'in_range', humidity_status: 'not_monitored', source: 'manual', entry_mode: 'live', ...over,
});
// 2026-09-27 12:00 Bangkok
const NOW = Date.parse('2026-09-27T05:00:00Z');

test('available metrics: temperature only, humidity only, both, none', () => {
  assert.deepEqual(availableMetrics([cfg('a', '2026-09-01T00:00:00Z', [2, 8])]), ['temperature']);
  assert.deepEqual(availableMetrics([cfg('a', '2026-09-01T00:00:00Z', null, [30, 60])]), ['humidity']);
  assert.deepEqual(availableMetrics([cfg('a', '2026-09-01T00:00:00Z', [15, 25], [30, 60])]), ['temperature', 'humidity']);
  assert.deepEqual(availableMetrics([cfg('a', '2026-09-01T00:00:00Z', null, null), null, undefined]), []);
});

test('metric view: both only when both are monitored, and unavailable requests fall back to what exists', () => {
  assert.equal(normalizeMetricView(undefined, ['temperature', 'humidity']), 'both');
  assert.equal(normalizeMetricView('humidity', ['temperature', 'humidity']), 'humidity');
  assert.equal(normalizeMetricView('temperature', ['temperature', 'humidity']), 'temperature');
  assert.equal(normalizeMetricView('nonsense', ['temperature', 'humidity']), 'both');
  assert.equal(normalizeMetricView('both', ['temperature']), 'temperature');
  assert.equal(normalizeMetricView('humidity', ['temperature']), 'temperature');
  assert.equal(normalizeMetricView('temperature', ['humidity']), 'humidity');
  assert.equal(normalizeMetricView('both', []), null);
  assert.deepEqual(metricsForView('both'), ['temperature', 'humidity']);
  assert.deepEqual(metricsForView('humidity'), ['humidity']);
  assert.deepEqual(metricsForView(null), []);
});

test('Bangkok ranges: presets end today on the Bangkok calendar', () => {
  const r7 = resolveTrendRange({ range: '7d' }, '30d', NOW);
  assert.deepEqual([r7.key, r7.from, r7.to, r7.today], ['7d', '2026-09-21', '2026-09-27', '2026-09-27']);
  assert.equal(r7.start, Date.parse('2026-09-20T17:00:00Z'), 'the period starts at Bangkok midnight');
  assert.equal(r7.end, NOW, 'the x axis never runs past now');
  const r30 = resolveTrendRange({}, '30d', NOW);
  assert.deepEqual([r30.key, r30.from, r30.to], ['30d', '2026-08-29', '2026-09-27']);
  assert.deepEqual([resolveTrendRange({}, '7d', NOW).key, resolveTrendRange({ range: 'bogus' }, '7d', NOW).key], ['7d', '7d']);
  const month = resolveTrendRange({ range: 'month' }, '30d', NOW);
  assert.deepEqual([month.from, month.to], ['2026-09-01', '2026-09-27']);
  // 23:30 on 30 Sep in UTC is already 1 Oct in Bangkok: "this month" is October, not September.
  const late = resolveTrendRange({ range: 'month' }, '30d', Date.parse('2026-09-30T17:30:00Z'));
  assert.deepEqual([late.from, late.to], ['2026-10-01', '2026-10-01']);
});

test('custom ranges are validated, never reach the future, are bounded, and old from/to links still work', () => {
  const ok = resolveTrendRange({ range: 'custom', from: '2026-09-10', to: '2026-09-12' }, '30d', NOW);
  assert.deepEqual([ok.key, ok.from, ok.to, ok.notice], ['custom', '2026-09-10', '2026-09-12', null]);
  assert.equal(ok.end, bangkokDayStart('2026-09-13'), 'a past custom period ends at the end of its last Bangkok day');
  const legacy = resolveTrendRange({ from: '2026-09-01', to: '2026-09-05' }, '30d', NOW);
  assert.deepEqual([legacy.key, legacy.from, legacy.to], ['custom', '2026-09-01', '2026-09-05']);
  for (const bad of [{ from: '2026-09-12', to: '2026-09-10' }, { from: '2026-02-30', to: '2026-03-02' }, { from: '2026-09-10' }, { from: 'x', to: 'y' }, { from: '2026-10-01', to: '2026-10-05' }]) {
    const fallback = resolveTrendRange({ range: 'custom', ...bad }, '30d', NOW);
    assert.equal(fallback.key, '30d', JSON.stringify(bad));
    assert.ok(fallback.notice, `a notice explains the fallback for ${JSON.stringify(bad)}`);
  }
  const future = resolveTrendRange({ range: 'custom', from: '2026-09-20', to: '2026-12-31' }, '30d', NOW);
  assert.deepEqual([future.from, future.to], ['2026-09-20', '2026-09-27']);
  assert.match(future.notice ?? '', /เลยวันนี้/);
  const long = resolveTrendRange({ range: 'custom', from: '2020-01-01', to: '2026-09-27' }, '30d', NOW);
  assert.equal(long.to, '2026-09-27');
  assert.equal((Date.parse(`${long.to}T00:00:00Z`) - Date.parse(`${long.from}T00:00:00Z`)) / 86_400_000 + 1, MAX_CUSTOM_RANGE_DAYS);
  assert.match(long.notice ?? '', /ไม่เกิน 366 วัน/);
});

test('trend points are ordered by observed time, not by the time they were typed in', () => {
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [2, 8])];
  const lateEntry = reading({ observed_at: '2026-09-20T01:00:00Z', recorded_at: '2026-09-21T09:00:00Z', temperature_c: 4, entry_mode: 'late' });
  const live = reading({ observed_at: '2026-09-20T05:00:00Z', recorded_at: '2026-09-20T05:00:01Z', temperature_c: 6 });
  const first = reading({ observed_at: '2026-09-19T05:00:00Z', temperature_c: 3 });
  const points = buildTrendSeries([live, lateEntry, first], configs, 'temperature');
  assert.deepEqual(points.map(point => point.value), [3, 4, 6]);
  assert.equal(points[1].late, true);
  assert.equal(points[1].t, Date.parse('2026-09-20T01:00:00Z'));
  assert.equal(points[1].recordedAt, Date.parse('2026-09-21T09:00:00Z'));
  assert.match(describePoint(points[1], 'temperature'), /ตรวจเมื่อ 20 ก.ย. 2026 08:00 .*บันทึกย้อนหลัง.*บันทึกเมื่อ 21 ก.ย. 2026 16:00/);
});

test('voids are never plotted and a corrected reading is replaced by its correction, which keeps a corrected flag', () => {
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [2, 8])];
  const original = reading({ id: 'orig', observed_at: '2026-09-20T01:00:00Z', temperature_c: 4.1 });
  const correction = reading({ id: 'corr', observed_at: '2026-09-20T01:00:00Z', recorded_at: '2026-09-20T03:00:00Z', entry_kind: 'correction', corrects_reading_id: 'orig', temperature_c: 4.2 });
  const voidedOriginal = reading({ id: 'gone', observed_at: '2026-09-21T01:00:00Z', temperature_c: 12, temperature_status: 'out_of_range' });
  const voidRow = reading({ id: 'void', observed_at: '2026-09-21T01:00:00Z', entry_kind: 'void', corrects_reading_id: 'gone', temperature_c: null });
  // Even if superseded rows reach the chart (they should not, the view excludes them), they are dropped.
  const points = buildTrendSeries([original, correction, voidedOriginal, voidRow], configs, 'temperature');
  assert.deepEqual(points.map(point => [point.id, point.value, point.corrected]), [['corr', 4.2, true]]);
  // The effective view alone: a void has no successor but is still never a point.
  assert.deepEqual(buildTrendSeries([voidRow], configs, 'temperature'), []);
  // A corrected value that is out of range stays out of range.
  const outCorrection = reading({ id: 'c2', observed_at: '2026-09-22T01:00:00Z', entry_kind: 'correction', corrects_reading_id: 'x', temperature_c: 9, temperature_status: 'out_of_range' });
  const [point] = buildTrendSeries([outCorrection], configs, 'temperature');
  assert.deepEqual([point.status, point.corrected], ['out_of_range', true]);
  assert.match(describePoint(point, 'temperature'), /นอกช่วง.*ค่าที่แก้ไขแล้ว/);
});

test('a missing value is a gap in the line, never interpolated', () => {
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [15, 25], [30, 60])];
  const rows = [
    reading({ observed_at: '2026-09-20T01:00:00Z', temperature_c: 20, humidity_rh: 40, humidity_status: 'in_range' }),
    reading({ observed_at: '2026-09-20T05:00:00Z', temperature_c: 21, humidity_rh: null, humidity_status: 'missing' }),
    reading({ observed_at: '2026-09-20T09:00:00Z', temperature_c: 22, humidity_rh: 45, humidity_status: 'in_range' }),
  ];
  const humidity = buildTrendSeries(rows, configs, 'humidity');
  assert.deepEqual(humidity.map(point => point.value), [40, null, 45]);
  assert.deepEqual(lineRuns(humidity).map(run => run.map(point => point.value)), [[40], [45]], 'no segment joins 40 and 45 across the gap');
  assert.deepEqual(lineRuns(buildTrendSeries(rows, configs, 'temperature')).map(run => run.length), [3]);
  const summary = summarizeSeries(humidity);
  assert.deepEqual([summary.total, summary.plotted, summary.min, summary.max, summary.latest?.value], [3, 2, 40, 45, 45]);
});

test('each point keeps the limits of the version it was recorded under', () => {
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [2, 8]), cfg('v2', '2026-09-11T00:00:00Z', [2, 6])];
  const points = buildTrendSeries([
    reading({ observed_at: '2026-09-05T01:00:00Z', config_id: 'v1', temperature_c: 7 }),
    reading({ observed_at: '2026-09-15T01:00:00Z', config_id: 'v2', temperature_c: 7, temperature_status: 'out_of_range' }),
  ], configs, 'temperature');
  assert.deepEqual(points.map(point => point.limits), [{ min: 2, max: 8 }, { min: 2, max: 6 }]);
  assert.deepEqual(points.map(point => point.status), ['in_range', 'out_of_range'], 'the stored status is used, not today’s range');
  assert.equal(buildTrendSeries([reading({ observed_at: '2026-09-05T01:00:00Z', config_id: 'unknown' })], configs, 'temperature')[0].limits, null);
});

test('acceptable band is piecewise by version: the same version, a mid-range change, one-sided limits', () => {
  const start = Date.parse('2026-09-01T00:00:00Z');
  const end = Date.parse('2026-09-21T00:00:00Z');
  const one = bandSegments([cfg('v1', '2026-08-01T00:00:00Z', [2, 8])], 'temperature', start, end);
  assert.deepEqual(one, [{ start, end, monitored: true, limits: { min: 2, max: 8 }, configId: 'v1' }]);
  assert.deepEqual(bandChanges(one), []);
  const change = Date.parse('2026-09-11T00:00:00Z');
  const two = bandSegments([cfg('v2', '2026-09-11T00:00:00Z', [2, 6]), cfg('v1', '2026-08-01T00:00:00Z', [2, 8])], 'temperature', start, end);
  assert.deepEqual(two.map(segment => [segment.start, segment.end, segment.limits]), [[start, change, { min: 2, max: 8 }], [change, end, { min: 2, max: 6 }]]);
  assert.deepEqual(bandChanges(two), [change], 'days 1–10 keep 2–8; only day 11 onward is 2–6');
  const freezer = bandSegments([cfg('fz', '2026-08-01T00:00:00Z', [null, -20])], 'temperature', start, end);
  assert.deepEqual(freezer[0].limits, { min: null, max: -20 }, 'no lower limit is invented');
  assert.equal(formatLimits(freezer[0].limits, '°C'), '≤ -20.00 °C');
  assert.equal(formatLimits({ min: 30, max: null }, '%RH'), '≥ 30.00 %RH');
  assert.equal(formatLimits(null, '°C'), 'ไม่ทราบเกณฑ์');
});

test('temperature and humidity bands come from their own limits; unrelated version changes do not draw a boundary', () => {
  const start = Date.parse('2026-09-01T00:00:00Z');
  const end = Date.parse('2026-09-21T00:00:00Z');
  const configs = [
    cfg('v1', '2026-08-01T00:00:00Z', [15, 25], [30, 60]),
    cfg('v2', '2026-09-05T00:00:00Z', [15, 25], [30, 70]), // humidity limit changes, temperature does not
    cfg('v3', '2026-09-10T00:00:00Z', [15, 25], null), // humidity switched off
  ];
  const temperature = bandSegments(configs, 'temperature', start, end);
  assert.deepEqual(temperature.map(segment => [segment.start, segment.end, segment.limits]), [[start, end, { min: 15, max: 25 }]]);
  const humidity = bandSegments(configs, 'humidity', start, end);
  assert.deepEqual(humidity.map(segment => [segment.monitored, segment.limits]), [[true, { min: 30, max: 60 }], [true, { min: 30, max: 70 }], [false, { min: null, max: null }]]);
  assert.equal(bandChanges(humidity).length, 2);
  // Nothing before the first version: no band is invented for that period.
  const late = bandSegments([cfg('v9', '2026-09-15T00:00:00Z', [2, 8])], 'temperature', start, end);
  assert.deepEqual(late.map(segment => segment.start), [Date.parse('2026-09-15T00:00:00Z')]);
  // A version that started and ended before the period is not in force.
  assert.deepEqual(versionsInForce(configs, Date.parse('2026-09-11T00:00:00Z'), end).map(config => config.id), ['v3']);
  assert.deepEqual(versionsInForce(configs, start, end).map(config => config.id), ['v1', 'v2', 'v3']);
});

test('offered metrics include a parameter monitored earlier in the period, not only today’s configuration', () => {
  const configs = [cfg('v1', '2026-08-01T00:00:00Z', [15, 25], [30, 60]), cfg('v2', '2026-09-20T00:00:00Z', [15, 25], null)];
  const range30 = resolveTrendRange({ range: '30d' }, '30d', NOW);
  assert.deepEqual(trendMetrics(configs, configs[1], range30), ['temperature', 'humidity']);
  const range7 = resolveTrendRange({ range: 'custom', from: '2026-09-21', to: '2026-09-27' }, '30d', NOW);
  assert.deepEqual(trendMetrics(configs, configs[1], range7), ['temperature']);
});

test('chart target: an inherited shelf resolves to its monitored parent; a self-monitored child is its own target', () => {
  const locations = [
    { id: 'fridge', parent_location_id: null, active: true }, { id: 'shelf', parent_location_id: 'fridge', active: true },
    { id: 'shelf-own', parent_location_id: 'fridge', active: true }, { id: 'room', parent_location_id: null, active: true },
    { id: 'old', parent_location_id: null, active: false },
  ];
  const configs = [
    { ...cfg('f1', '2026-09-01T00:00:00Z', [2, 8]), location_id: 'fridge' },
    { ...cfg('s1', '2026-09-02T00:00:00Z', null, [30, 60]), location_id: 'shelf-own' },
    { ...cfg('o1', '2026-09-01T00:00:00Z', [2, 8]), location_id: 'old' },
  ];
  const inherited = resolveChartTarget('shelf', locations, configs);
  assert.equal(inherited.target?.id, 'fridge');
  assert.equal(inherited.inheritedFrom?.id, 'shelf');
  assert.equal(inherited.evidenceLocationId, 'fridge', 'the shelf has no readings of its own');
  assert.deepEqual(inherited.monitored.map(item => item.id), ['fridge', 'shelf-own'], 'shelves that inherit are not chart targets; closed locations are not offered');
  const own = resolveChartTarget('shelf-own', locations, configs);
  assert.deepEqual([own.target?.id, own.inheritedFrom], ['shelf-own', undefined]);
  const none = resolveChartTarget(null, locations, configs);
  assert.deepEqual([none.target?.id, none.evidenceLocationId, none.unknownRequested], ['fridge', null, false]);
  const unmonitored = resolveChartTarget('room', locations, configs);
  assert.deepEqual([unmonitored.target, unmonitored.notMonitored?.id, unmonitored.evidenceLocationId], [undefined, 'room', 'room']);
  // Another warehouse's location is simply not in the list: it is indistinguishable from an unknown id.
  const other = resolveChartTarget('imm-fridge', locations, configs);
  assert.deepEqual([other.unknownRequested, other.target?.id, other.inheritedFrom, other.evidenceLocationId], [true, 'fridge', undefined, null], 'falls back to the first monitored location, with a notice');
  // A closed but still configured location can still be opened by link.
  assert.equal(resolveChartTarget('old', locations, configs).target?.id, 'old');
  assert.equal(resolveChartTarget(null, [], []).target, undefined);
});

test('chart queries page past the 1000-row cap until the counted total, and a ceiling is reported, not silent', async () => {
  const all = Array.from({ length: 2345 }, (_, index) => index);
  const calls: [number, number][] = [];
  const page = (cap: number) => async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: all.slice(from, Math.min(to + 1, from + cap)), error: null, count: all.length };
  };
  const full = await fetchAllPages(page(1000));
  assert.equal(full.rows.length, 2345);
  assert.deepEqual([full.truncated, full.total], [false, 2345]);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  // A server that returns fewer rows per request than asked for is still read to the end.
  assert.equal((await fetchAllPages(page(300))).rows.length, 2345);
  const capped = await fetchAllPages(page(1000), 1500);
  assert.deepEqual([capped.rows.length, capped.truncated, capped.total], [1500, true, 2345]);
  const failed = await fetchAllPages(async () => ({ data: null, error: { message: 'boom' } as never, count: null }));
  assert.equal(failed.error?.message, 'boom');
  const empty = await fetchAllPages(async () => ({ data: [], error: null, count: 0 }));
  assert.deepEqual([empty.rows.length, empty.truncated], [0, false]);
});

test('scales, ticks and text are deterministic Bangkok values', () => {
  assert.equal(formatBangkokDateTime(Date.parse('2026-09-26T17:05:00Z')), '27 ก.ย. 2026 00:05');
  assert.equal(formatMeasure(9), '9.00');
  assert.equal(formatMeasure(-20), '-20.00');
  assert.equal(formatMeasure(4.1), '4.10');
  const start = bangkokDayStart('2026-09-21');
  const ticks = timeTicks(start, bangkokDayStart('2026-09-28'), 8);
  assert.equal(ticks[0].t, start, 'day ticks sit on Bangkok midnight');
  assert.equal(formatTick(ticks[0].t, ticks[0].step), '21 ก.ย.');
  assert.ok(ticks.length <= 8);
  const hourly = timeTicks(start, start + 12 * 3_600_000, 6);
  assert.equal(formatTick(hourly[1].t, hourly[1].step), '03:00');
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [2, 8])];
  const points = buildTrendSeries([reading({ observed_at: '2026-09-20T01:00:00Z', temperature_c: 5 })], configs, 'temperature');
  const [low, high] = valueDomain(points, bandSegments(configs, 'temperature', start, start + 86_400_000))!;
  assert.ok(low < 2 && high > 8, 'the domain includes the acceptable limits, not only the values');
  assert.equal(valueDomain([], []), null);
  assert.doesNotMatch(describePoint(points[0], 'temperature'), /r-\d|v1/, 'no internal ids in the text');
});
