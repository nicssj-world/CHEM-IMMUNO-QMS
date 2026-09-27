// Environment trend chart domain: pure functions shared by the server loader, the chart component and the unit tests.
// No Supabase and no Intl here, so the server render and the browser render produce byte-identical text.
//
// Semantics this module guarantees (and the tests pin down):
// * Trend points are EFFECTIVE readings only. Voids are never plotted; a reading that has been corrected is replaced by its
//   correction (defence in depth on top of ci_environment_effective_readings). The raw evidence list lives elsewhere.
// * Points are placed by observed_at (when the value was seen), never by recorded_at (when it was typed in).
// * Each point is judged against the configuration version it was recorded under (config_id), and the acceptable band is
//   drawn piecewise from the versions in force over time, so a range change never repaints history.
// * A missing value is a gap in the line, never an interpolated value.

import { hasOwnMonitoring, latestConfigByLocation, resolveEnvironmentMonitor, type MonitorConfig, type MonitorLocation } from './environment-monitor';

export type TrendMetric = 'temperature' | 'humidity';
export type MetricView = 'both' | TrendMetric;
export type TrendRangeKey = '7d' | '30d' | 'month' | 'custom';

export const TREND_METRICS: readonly TrendMetric[] = ['temperature', 'humidity'];
export const METRIC_VIEW_LABEL: Record<MetricView, string> = { both: 'ทั้งคู่', temperature: 'อุณหภูมิ', humidity: 'ความชื้น' };
export const METRIC_TITLE: Record<TrendMetric, string> = { temperature: 'อุณหภูมิ', humidity: 'ความชื้นสัมพัทธ์' };
export const METRIC_UNIT: Record<TrendMetric, string> = { temperature: '°C', humidity: '%RH' };
export const RANGE_LABEL: Record<TrendRangeKey, string> = { '7d': '7 วัน', '30d': '30 วัน', month: 'เดือนนี้', custom: 'กำหนดเอง' };
export const RANGE_KEYS: readonly TrendRangeKey[] = ['7d', '30d', 'month', 'custom'];
/** A custom range longer than this is shortened (and the page says so) to keep one chart request bounded. */
export const MAX_CUSTOM_RANGE_DAYS = 366;

export type TrendConfig = {
  id: string; location_id: string; effective_from: string;
  temperature_monitored: boolean; temp_min_c: number | string | null; temp_max_c: number | string | null;
  humidity_monitored: boolean; rh_min_pct: number | string | null; rh_max_pct: number | string | null;
};
export type TrendReading = {
  id: string; config_id: string; observed_at: string; recorded_at: string;
  entry_kind: 'original' | 'correction' | 'void'; corrects_reading_id: string | null;
  temperature_c: number | string | null; humidity_rh: number | string | null;
  temperature_status: string; humidity_status: string;
  source: 'manual' | 'qr'; entry_mode: 'live' | 'late';
};
export type Limits = { min: number | null; max: number | null };
export type TrendPoint = {
  id: string; t: number; recordedAt: number; value: number | null;
  status: 'in_range' | 'out_of_range' | 'missing' | 'not_monitored';
  corrected: boolean; late: boolean; source: 'manual' | 'qr';
  /** Limits of the configuration version this reading was recorded under; null when that version is not readable. */
  limits: Limits | null;
};
export type BandSegment = { start: number; end: number; monitored: boolean; limits: Limits; configId: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BANGKOK_OFFSET = 7 * HOUR; // Asia/Bangkok has no daylight saving time.

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
type MonitorFlags = Pick<TrendConfig, 'temperature_monitored' | 'humidity_monitored'>;

/** Metrics monitored by any of the given configuration versions, in display order. */
export function availableMetrics(configs: readonly (MonitorFlags | null | undefined)[]): TrendMetric[] {
  const on = { temperature: false, humidity: false };
  for (const config of configs) {
    if (config?.temperature_monitored) on.temperature = true;
    if (config?.humidity_monitored) on.humidity = true;
  }
  return TREND_METRICS.filter(metric => on[metric]);
}

/** `both` only when both are monitored; a metric the location does not have falls back to what it does have. */
export function normalizeMetricView(requested: string | null | undefined, available: readonly TrendMetric[]): MetricView | null {
  if (available.length === 0) return null;
  if (available.length === 1) return available[0];
  return requested === 'temperature' || requested === 'humidity' || requested === 'both' ? requested : 'both';
}

export function metricsForView(view: MetricView | null): TrendMetric[] {
  return view === null ? [] : view === 'both' ? [...TREND_METRICS] : [view];
}

// ---------------------------------------------------------------------------
// Bangkok calendar ranges
// ---------------------------------------------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is not). */
export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
/** Days from `from` to `to`, counting both ends. */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
}
/** The instant a Bangkok calendar day starts. */
export function bangkokDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+07:00`);
}
export function bangkokToday(now: number): string {
  return new Date(now + BANGKOK_OFFSET).toISOString().slice(0, 10);
}

export type TrendRange = {
  key: TrendRangeKey; from: string; to: string;
  /** Today on the Bangkok calendar, the latest date a custom period may end on. */
  today: string;
  /** Chart x domain: start of `from` (Bangkok) to the end of `to`, but never past now. */
  start: number; end: number;
  notice: string | null;
};
export type TrendRangeQuery = { range?: string | null; from?: string | null; to?: string | null };

/**
 * Resolve the chart period on the Asia/Bangkok calendar. Presets end today; a custom period is validated, never runs into the
 * future and is at most MAX_CUSTOM_RANGE_DAYS long. Anything unusable falls back to the page default with a visible notice.
 * An older link that carries only from/to (the history filter before charts) is read as a custom period.
 */
export function resolveTrendRange(query: TrendRangeQuery, fallback: Exclude<TrendRangeKey, 'custom'> = '30d', now: number = Date.now()): TrendRange {
  const today = bangkokToday(now);
  const requested = query.range ?? (query.from || query.to ? 'custom' : fallback);
  const key: TrendRangeKey = (RANGE_KEYS as readonly string[]).includes(requested) ? requested as TrendRangeKey : fallback;
  const preset = (k: Exclude<TrendRangeKey, 'custom'>, notice: string | null = null): TrendRange => {
    const from = k === '7d' ? addDays(today, -6) : k === '30d' ? addDays(today, -29) : `${today.slice(0, 7)}-01`;
    return withDomain({ key: k, from, to: today, notice }, now);
  };
  if (key !== 'custom') return preset(key);
  if (!isIsoDate(query.from) || !isIsoDate(query.to)) return preset(fallback, 'ช่วงวันที่ที่กำหนดไม่ครบหรือไม่ถูกต้อง · แสดงช่วงเริ่มต้นแทน');
  let from = query.from;
  let to = query.to;
  const notices: string[] = [];
  if (from > to) return preset(fallback, 'วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด · แสดงช่วงเริ่มต้นแทน');
  if (from > today) return preset(fallback, 'ช่วงวันที่ที่เลือกยังไม่ถึง · แสดงช่วงเริ่มต้นแทน');
  if (to > today) { to = today; notices.push('วันที่สิ้นสุดเลยวันนี้ · แสดงถึงวันนี้'); }
  if (inclusiveDays(from, to) > MAX_CUSTOM_RANGE_DAYS) {
    from = addDays(to, -(MAX_CUSTOM_RANGE_DAYS - 1));
    notices.push(`ช่วงที่กำหนดเองยาวได้ไม่เกิน ${MAX_CUSTOM_RANGE_DAYS} วัน · แสดงตั้งแต่ ${from}`);
  }
  return withDomain({ key: 'custom', from, to, notice: notices.join(' · ') || null }, now);
}
function withDomain(range: Omit<TrendRange, 'start' | 'end' | 'today'>, now: number): TrendRange {
  const start = bangkokDayStart(range.from);
  const end = Math.max(start + HOUR, Math.min(bangkokDayStart(addDays(range.to, 1)), now));
  return { ...range, today: bangkokToday(now), start, end };
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------
const toNumber = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function configLimits(config: TrendConfig, metric: TrendMetric): Limits {
  return metric === 'temperature'
    ? { min: toNumber(config.temp_min_c), max: toNumber(config.temp_max_c) }
    : { min: toNumber(config.rh_min_pct), max: toNumber(config.rh_max_pct) };
}
export function configMonitors(config: TrendConfig, metric: TrendMetric): boolean {
  return metric === 'temperature' ? config.temperature_monitored : config.humidity_monitored;
}

function compareTimestamps(a: string, b: string) {
  const byTime = Date.parse(a) - Date.parse(b);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  // PostgREST writes timestamps in one format with microseconds, which Date cannot see; text order is then time order.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Effective readings → one metric's points, ordered by observed time. Voids and superseded readings are dropped even if the
 * input contains them; a reading without a value for this metric stays in the series as a gap.
 */
export function buildTrendSeries(readings: readonly TrendReading[], configs: readonly TrendConfig[], metric: TrendMetric): TrendPoint[] {
  const superseded = new Set(readings.map(reading => reading.corrects_reading_id).filter((id): id is string => Boolean(id)));
  const byId = new Map(configs.map(config => [config.id, config]));
  return readings
    .filter(reading => reading.entry_kind !== 'void' && !superseded.has(reading.id))
    .slice().sort((a, b) => compareTimestamps(a.observed_at, b.observed_at) || compareTimestamps(a.recorded_at, b.recorded_at) || a.id.localeCompare(b.id))
    .map(reading => {
      const config = byId.get(reading.config_id);
      const status = metric === 'temperature' ? reading.temperature_status : reading.humidity_status;
      const value = toNumber(metric === 'temperature' ? reading.temperature_c : reading.humidity_rh);
      return {
        id: reading.id, t: Date.parse(reading.observed_at), recordedAt: Date.parse(reading.recorded_at),
        value: status === 'not_monitored' ? null : value,
        status: (['in_range', 'out_of_range', 'missing', 'not_monitored'].includes(status) ? status : 'missing') as TrendPoint['status'],
        corrected: reading.entry_kind === 'correction', late: reading.entry_mode === 'late', source: reading.source,
        limits: config ? configLimits(config, metric) : null,
      };
    });
}

/** Consecutive runs of plotted values. A missing value ends a run, so the line never bridges a gap. */
export function lineRuns(points: readonly TrendPoint[]): TrendPoint[][] {
  const runs: TrendPoint[][] = [];
  let current: TrendPoint[] = [];
  for (const point of points) {
    if (point.value === null) { if (current.length) runs.push(current); current = []; continue; }
    current.push(point);
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * The acceptable band as it actually was: one segment per configuration version, clipped to [start, end). A version starts at
 * its effective_from and lasts until the next version starts. Periods before the first version have no band.
 */
export function bandSegments(configs: readonly TrendConfig[], metric: TrendMetric, start: number, end: number): BandSegment[] {
  const versions = configs.slice().sort((a, b) => compareTimestamps(a.effective_from, b.effective_from));
  const segments: BandSegment[] = [];
  versions.forEach((config, index) => {
    const from = Date.parse(config.effective_from);
    const next = versions[index + 1];
    const until = next ? Date.parse(next.effective_from) : Number.POSITIVE_INFINITY;
    const segStart = Math.max(from, start);
    const segEnd = Math.min(until, end);
    if (!(segEnd > segStart)) return;
    const monitored = configMonitors(config, metric);
    const limits = monitored ? configLimits(config, metric) : { min: null, max: null };
    const previous = segments.at(-1);
    // Versions that changed something else (schedule, pause) keep the same band: merge them so no false boundary is drawn.
    if (previous && previous.end === segStart && previous.monitored === monitored && sameLimits(previous.limits, limits)) {
      previous.end = segEnd;
      return;
    }
    segments.push({ start: segStart, end: segEnd, monitored, limits, configId: config.id });
  });
  return segments;
}
/** Versions whose in-force interval [effective_from, next effective_from) overlaps [start, end). */
export function versionsInForce<T extends Pick<TrendConfig, 'effective_from'>>(configs: readonly T[], start: number, end: number): T[] {
  const versions = configs.slice().sort((a, b) => compareTimestamps(a.effective_from, b.effective_from));
  return versions.filter((config, index) => {
    const next = versions[index + 1];
    return Date.parse(config.effective_from) < end && (!next || Date.parse(next.effective_from) > start);
  });
}
export function sameLimits(a: Limits | null, b: Limits | null) {
  return a?.min === b?.min && a?.max === b?.max;
}
/** Instants inside the chart where the acceptable range changed. */
export function bandChanges(segments: readonly BandSegment[]): number[] {
  return segments.slice(1).filter((segment, index) => segments[index].end === segment.start).map(segment => segment.start);
}

// ---------------------------------------------------------------------------
// Scales and ticks
// ---------------------------------------------------------------------------
export function valueDomain(points: readonly TrendPoint[], segments: readonly BandSegment[]): [number, number] | null {
  const values: number[] = [];
  for (const point of points) if (point.value !== null) values.push(point.value);
  for (const segment of segments) if (segment.monitored) {
    if (segment.limits.min !== null) values.push(segment.limits.min);
    if (segment.limits.max !== null) values.push(segment.limits.max);
  }
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = high === low ? Math.max(1, Math.abs(high) * 0.1) : (high - low) * 0.12;
  return [low - pad, high + pad];
}

export function niceTicks(low: number, high: number, target = 5): number[] {
  const span = high - low;
  if (!(span > 0)) return [low];
  const raw = span / Math.max(1, target - 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(candidate => candidate >= raw) ?? 10 * power;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-9; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return ticks;
}

const TIME_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 61 * DAY];
/** Time ticks aligned to Bangkok midnight (or Bangkok hours for short periods), at most `maxTicks` of them. */
export function timeTicks(start: number, end: number, maxTicks: number): { t: number; step: number }[] {
  const span = end - start;
  const step = TIME_STEPS.find(candidate => span / candidate <= Math.max(1, maxTicks)) ?? TIME_STEPS.at(-1)!;
  const ticks: { t: number; step: number }[] = [];
  const first = Math.ceil((start + BANGKOK_OFFSET) / step) * step - BANGKOK_OFFSET;
  for (let t = first; t <= end; t += step) ticks.push({ t, step });
  return ticks;
}

// ---------------------------------------------------------------------------
// Deterministic Bangkok text (identical on the server and in any browser)
// ---------------------------------------------------------------------------
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pad2 = (value: number) => String(value).padStart(2, '0');
function bangkokParts(t: number) {
  const date = new Date(t + BANGKOK_OFFSET);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
}
/** `27 ก.ย. 2026 14:05` in Asia/Bangkok. */
export function formatBangkokDateTime(t: number): string {
  const p = bangkokParts(t);
  return `${p.day} ${THAI_MONTHS[p.month]} ${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
}
/** Axis label: `27 ก.ย.` for day steps, `14:00` for hour steps (with the date at midnight). */
export function formatTick(t: number, step: number): string {
  const p = bangkokParts(t);
  if (step < DAY && (p.hour !== 0 || p.minute !== 0)) return `${pad2(p.hour)}:${pad2(p.minute)}`;
  return `${p.day} ${THAI_MONTHS[p.month]}`;
}
/** `2026-09-27` → `27 ก.ย. 2026` */
export function formatIsoDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${THAI_MONTHS[month - 1]} ${year}`;
}
/** Two decimals, as stored (numeric(5,2)). `-20` → `-20.00`. */
export function formatMeasure(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2).replace(/^-0\.00$/, '0.00');
}
export function formatLimits(limits: Limits | null, unit: string): string {
  if (!limits) return 'ไม่ทราบเกณฑ์';
  if (limits.min !== null && limits.max !== null) return `${formatMeasure(limits.min)} – ${formatMeasure(limits.max)} ${unit}`;
  if (limits.max !== null) return `≤ ${formatMeasure(limits.max)} ${unit}`;
  if (limits.min !== null) return `≥ ${formatMeasure(limits.min)} ${unit}`;
  return 'ไม่ได้ตั้งเกณฑ์';
}

export const POINT_STATUS_LABEL: Record<TrendPoint['status'], string> = {
  in_range: 'อยู่ในช่วง', out_of_range: 'นอกช่วง', missing: 'ไม่มีค่า', not_monitored: 'ไม่ได้เฝ้าระวัง',
};
/** Everything a person needs about one point, without internal ids. */
export function describePoint(point: TrendPoint, metric: TrendMetric): string {
  const unit = METRIC_UNIT[metric];
  return [
    `ตรวจเมื่อ ${formatBangkokDateTime(point.t)}`,
    point.value === null ? 'ไม่มีค่า' : `${formatMeasure(point.value)} ${unit}`,
    POINT_STATUS_LABEL[point.status],
    `เกณฑ์ขณะนั้น ${formatLimits(point.limits, unit)}`,
    point.late ? 'บันทึกย้อนหลัง' : 'บันทึกทันที',
    point.corrected ? 'ค่าที่แก้ไขแล้ว (ค่าเดิมอยู่ในรายการหลักฐาน)' : 'ค่าเดิม',
    `บันทึกเมื่อ ${formatBangkokDateTime(point.recordedAt)}`,
    point.source === 'qr' ? 'ผ่าน QR' : 'บันทึกเอง',
  ].join(' · ');
}

export type SeriesSummary = { total: number; plotted: number; outOfRange: number; corrected: number; late: number; min: number | null; max: number | null; latest: TrendPoint | null };
export function summarizeSeries(points: readonly TrendPoint[]): SeriesSummary {
  const plotted = points.filter(point => point.value !== null);
  const values = plotted.map(point => point.value as number);
  return {
    total: points.length, plotted: plotted.length,
    outOfRange: plotted.filter(point => point.status === 'out_of_range').length,
    corrected: plotted.filter(point => point.corrected).length,
    late: plotted.filter(point => point.late).length,
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
    latest: plotted.at(-1) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Chart target
// ---------------------------------------------------------------------------
export type ChartTarget<L> = {
  /** Selectable chart targets: active locations whose own current version monitors something. */
  monitored: L[];
  /** The canonical monitored location the chart is drawn for (never an inherited shelf). */
  target: L | undefined;
  /** A requested shelf/rack that inherits from `target`. */
  inheritedFrom: L | undefined;
  /** A requested location with no monitoring of its own and no monitored parent. */
  notMonitored: L | undefined;
  /** A location id that is not readable in this warehouse (or not a location at all). */
  unknownRequested: boolean;
  /** Where the evidence list reads from: the resolved monitor, a location's own old rows, or null for the whole warehouse. */
  evidenceLocationId: string | null;
};
/**
 * Resolve the chart target the way ci_private.environment_monitor_location_id does. Without a request the first monitored
 * location (by the input order) is shown. Locations from other warehouses are absent from `locations`, so they are "unknown".
 */
export function resolveChartTarget<L extends MonitorLocation & { active: boolean }>(requestedId: string | null | undefined, locations: readonly L[], configs: readonly MonitorConfig[]): ChartTarget<L> {
  const byId = new Map(locations.map(location => [location.id, location]));
  const current = latestConfigByLocation(configs);
  const monitored = locations.filter(location => location.active && hasOwnMonitoring(current.get(location.id)));
  const requested = requestedId ? byId.get(requestedId) : undefined;
  const monitorId = requested ? resolveEnvironmentMonitor(requested.id, locations, configs) : null;
  const target = monitorId ? byId.get(monitorId) : requested ? undefined : monitored[0];
  return {
    monitored, target,
    inheritedFrom: requested && monitorId && monitorId !== requested.id ? requested : undefined,
    notMonitored: requested && !monitorId ? requested : undefined,
    unknownRequested: Boolean(requestedId) && !requested,
    evidenceLocationId: requested ? (monitorId ?? requested.id) : null,
  };
}
