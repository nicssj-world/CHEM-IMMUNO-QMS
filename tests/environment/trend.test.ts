import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableMetrics, bandChanges, bandSegments, bangkokDayStart, buildTrendSeries, describePoint, formatBangkokDateTime, formatLimits,
  addMonths, bangkokDayNumber, dayAxis, daysInMonth, formatAxis, formatBangkokShort, formatMonth, isYearMonth, periodLabel, rangeQuery,
  formatMeasure, lineRuns, metricsForView, MAX_CUSTOM_RANGE_DAYS, normalizeMetricView, resolveChartTarget, resolveTrendRange,
  summarizeSeries, valueDomain, versionsInForce, type TrendConfig, type TrendReading,
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

test('the default period is the whole current Bangkok month, not a rolling window', () => {
  const range = resolveTrendRange({}, NOW);
  assert.deepEqual([range.key, range.month, range.from, range.to, range.today, range.notice], ['this', '2026-09', '2026-09-01', '2026-09-27', '2026-09-27', null]);
  assert.equal(range.start, Date.parse('2026-08-31T17:00:00Z'), 'the axis starts at Bangkok midnight on the 1st');
  assert.equal(range.end, Date.parse('2026-09-30T17:00:00Z'), 'the axis runs to the end of the month even though readings stop today');
  assert.equal(range.now, NOW);
  assert.equal(periodLabel(range), 'ก.ย. 2026');
  // Links from before the monthly view and unknown values open the current month.
  for (const legacy of ['7d', '30d', 'month', 'bogus']) assert.equal(resolveTrendRange({ range: legacy }, NOW).key, 'this', legacy);
  // The default moves on with the calendar: 23:30 on 30 Sep UTC is already 1 Oct in Bangkok.
  const next = resolveTrendRange({}, Date.parse('2026-09-30T17:30:00Z'));
  assert.deepEqual([next.month, next.from, next.to], ['2026-10', '2026-10-01', '2026-10-01']);
});

test('previous month and a chosen month show the whole month; a future or invalid month falls back with a notice', () => {
  const prev = resolveTrendRange({ range: 'month', month: '2026-08' }, NOW);
  assert.deepEqual([prev.key, prev.from, prev.to], ['prev', '2026-08-01', '2026-08-31']);
  assert.equal(prev.end - prev.start, 31 * 86_400_000);
  const picked = resolveTrendRange({ range: 'month', month: '2026-02' }, NOW);
  assert.deepEqual([picked.key, picked.from, picked.to, daysInMonth('2026-02')], ['pick', '2026-02-01', '2026-02-28', 28]);
  assert.equal(periodLabel(picked), 'ก.พ. 2026');
  const january = resolveTrendRange({ month: '2026-01' }, Date.parse('2026-02-10T05:00:00Z'));
  assert.equal(january.key, 'prev', 'the month before February is January');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(resolveTrendRange({ month: '2026-09' }, NOW).key, 'this');
  for (const bad of ['2026-13', '2026-9', 'x', '2026-10']) {
    const fallback = resolveTrendRange({ range: 'month', month: bad }, NOW);
    assert.deepEqual([fallback.key, Boolean(fallback.notice)], ['this', true], bad);
  }
  assert.equal(isYearMonth('2026-09'), true);
  assert.equal(isYearMonth('2026-00'), false);
});

test('period links: this month follows the calendar, previous/chosen months are explicit, custom keeps its dates', () => {
  const range = resolveTrendRange({ range: 'month', month: '2026-07' }, NOW);
  assert.deepEqual(rangeQuery('this', range), [['range', 'month']]);
  assert.deepEqual(rangeQuery('prev', range), [['range', 'month'], ['month', '2026-08']]);
  assert.deepEqual(rangeQuery('pick', range), [['range', 'month'], ['month', '2026-07']]);
  assert.deepEqual(rangeQuery('custom', range), [['range', 'custom'], ['from', '2026-07-01'], ['to', '2026-07-31']]);
});

test('custom ranges are validated, never reach the future, are bounded, and old from/to links still work', () => {
  const ok = resolveTrendRange({ range: 'custom', from: '2026-09-10', to: '2026-09-12' }, NOW);
  assert.deepEqual([ok.key, ok.month, ok.from, ok.to, ok.notice], ['custom', null, '2026-09-10', '2026-09-12', null]);
  assert.equal(ok.start, bangkokDayStart('2026-09-10'));
  assert.equal(ok.end, bangkokDayStart('2026-09-13'), 'a custom period spans its whole last Bangkok day');
  assert.equal(periodLabel(ok), '10 ก.ย. 2026 – 12 ก.ย. 2026');
  const legacy = resolveTrendRange({ from: '2026-09-01', to: '2026-09-05' }, NOW);
  assert.deepEqual([legacy.key, legacy.from, legacy.to], ['custom', '2026-09-01', '2026-09-05']);
  for (const bad of [{ from: '2026-09-12', to: '2026-09-10' }, { from: '2026-02-30', to: '2026-03-02' }, { from: '2026-09-10' }, { from: 'x', to: 'y' }, { from: '2026-10-01', to: '2026-10-05' }]) {
    const fallback = resolveTrendRange({ range: 'custom', ...bad }, NOW);
    assert.equal(fallback.key, 'this', JSON.stringify(bad));
    assert.ok(fallback.notice, `a notice explains the fallback for ${JSON.stringify(bad)}`);
  }
  const future = resolveTrendRange({ range: 'custom', from: '2026-09-20', to: '2026-12-31' }, NOW);
  assert.deepEqual([future.from, future.to], ['2026-09-20', '2026-09-27']);
  assert.match(future.notice ?? '', /เลยวันนี้/);
  const long = resolveTrendRange({ range: 'custom', from: '2020-01-01', to: '2026-09-27' }, NOW);
  assert.equal(long.to, '2026-09-27');
  assert.equal((Date.parse(`${long.to}T00:00:00Z`) - Date.parse(`${long.from}T00:00:00Z`)) / 86_400_000 + 1, MAX_CUSTOM_RANGE_DAYS);
  assert.match(long.notice ?? '', /ไม่เกิน 366 วัน/);
});

test('the x axis is the full month: one slot per day, days without readings keep their place', () => {
  const september = resolveTrendRange({}, NOW);
  const slots = dayAxis(september.start, september.end, 31);
  assert.equal(slots.length, 30, 'all 30 days of September, not just the 27 so far or the days with readings');
  assert.deepEqual(slots.slice(0, 3).map(slot => slot.label), ['1', '2', '3']);
  assert.equal(slots[29].start, bangkokDayStart('2026-09-30'));
  const narrow = dayAxis(september.start, september.end, 7);
  const labels = narrow.filter(slot => slot.label).map(slot => slot.label);
  assert.ok(labels.length <= 8 && labels[0] === '1', labels.join(','));
  assert.equal(narrow.length, 30, 'fewer labels never means fewer days');
  const february = resolveTrendRange({ month: '2026-02' }, NOW);
  assert.equal(dayAxis(february.start, february.end, 31).length, 28);
  const across = dayAxis(bangkokDayStart('2026-08-30'), bangkokDayStart('2026-09-03'), 10);
  assert.deepEqual(across.map(slot => slot.label), ['30', '31', '1 ก.ย.', '2']);
});

test('the line breaks at a day with no reading; several readings on one day stay separate, in observed order', () => {
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [2, 8])];
  const points = buildTrendSeries([
    reading({ observed_at: '2026-09-03T08:00:00Z', temperature_c: 6 }),
    reading({ observed_at: '2026-09-03T02:00:00Z', temperature_c: 4 }), // same Bangkok day, earlier
    reading({ observed_at: '2026-09-04T02:00:00Z', temperature_c: 5 }), // next day: still connected
    reading({ observed_at: '2026-09-07T02:00:00Z', temperature_c: 7 }), // 5th and 6th have no reading: a new run
    reading({ observed_at: '2026-09-07T09:00:00Z', temperature_c: 7.2 }),
  ], configs, 'temperature');
  assert.deepEqual(points.map(point => point.value), [4, 6, 5, 7, 7.2], 'no averaging, ordered by observed time');
  assert.deepEqual(lineRuns(points).map(run => run.map(point => point.value)), [[4, 6, 5], [7, 7.2]]);
  assert.equal(bangkokDayNumber(Date.parse('2026-09-03T16:59:00Z')), bangkokDayNumber(Date.parse('2026-09-03T02:00:00Z')));
  assert.equal(bangkokDayNumber(Date.parse('2026-09-03T17:00:00Z')) - bangkokDayNumber(Date.parse('2026-09-03T02:00:00Z')), 1, 'Bangkok midnight');
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
  const range30 = resolveTrendRange({}, NOW);
  assert.deepEqual(trendMetrics(configs, configs[1], range30), ['temperature', 'humidity']);
  const range7 = resolveTrendRange({ range: 'custom', from: '2026-09-21', to: '2026-09-27' }, NOW);
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
  assert.equal(formatBangkokShort(Date.parse('2026-09-26T17:05:00Z')), '27 ก.ย. 00:05');
  assert.equal(formatMonth('2026-12'), 'ธ.ค. 2026');
  assert.deepEqual([formatAxis(8), formatAxis(2.5), formatAxis(-20), formatAxis(4.123)], ['8', '2.5', '-20', '4.12']);
  const configs = [cfg('v1', '2026-09-01T00:00:00Z', [2, 8])];
  const points = buildTrendSeries([reading({ observed_at: '2026-09-20T01:00:00Z', temperature_c: 5 })], configs, 'temperature');
  const [low, high] = valueDomain(points, bandSegments(configs, 'temperature', start, start + 86_400_000))!;
  assert.ok(low < 2 && high > 8, 'the domain includes the acceptable limits, not only the values');
  assert.equal(valueDomain([], []), null);
  assert.doesNotMatch(describePoint(points[0], 'temperature'), /r-\d|v1/, 'no internal ids in the text');
});
