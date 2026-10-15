import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { ENV_CONFIG_COLUMNS, type MonitorConfig } from './environment';
import { availableMetrics, versionsInForce, type TrendConfig, type TrendRange, type TrendReading } from './environment-trend';

// Read-only RLS queries for the trend chart. Nothing here writes, and nothing decides authority: the database already limits
// every row to warehouses the caller may read.

const TREND_READING_COLUMNS = 'id,config_id,observed_at,recorded_at,entry_kind,corrects_reading_id,temperature_c,humidity_rh,temperature_status,humidity_status,source,entry_mode';
/** PostgREST returns at most `max_rows` (1000) per request, so every chart query is paged until it has the counted total. */
const PAGE_SIZE = 1000;
/** Defensive ceiling far above a full custom year at four rounds a day. Reaching it is reported on the page, never silent. */
export const MAX_TREND_READINGS = 20_000;

type Page<T> = { data: T[] | null; error: PostgrestError | null; count: number | null };

/** Fetch every row of an ordered query, page by page, until the exact count is reached (or the ceiling, which is reported). */
export async function fetchAllPages<T>(pageAt: (from: number, to: number) => PromiseLike<Page<T>>, ceiling = MAX_TREND_READINGS) {
  const rows: T[] = [];
  let total: number | null = null;
  while (rows.length < ceiling) {
    const { data, error, count } = await pageAt(rows.length, Math.min(rows.length + PAGE_SIZE, ceiling) - 1);
    if (error) return { rows, error, truncated: false, total };
    total = count ?? total;
    const page = data ?? [];
    rows.push(...page);
    if (page.length === 0 || (total !== null && rows.length >= total)) break;
  }
  return { rows, error: null, truncated: total !== null && rows.length < total, total };
}

/** Every configuration version of one location, oldest first. Versions are append-only, so this is the full history. */
export async function loadConfigVersions(client: SupabaseClient, locationId: string) {
  return fetchAllPages<MonitorConfig>((from, to) => client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS, { count: 'exact' })
    .eq('location_id', locationId).order('effective_from', { ascending: true }).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<Page<MonitorConfig>>, Number.MAX_SAFE_INTEGER);
}

/** Every configuration version in one warehouse, used to decide which locations are monitored today. */
export async function loadWarehouseConfigs(client: SupabaseClient, warehouseId: number) {
  return fetchAllPages<MonitorConfig>((from, to) => client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS, { count: 'exact' })
    .eq('warehouse_id', warehouseId).order('effective_from', { ascending: true }).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<Page<MonitorConfig>>, Number.MAX_SAFE_INTEGER);
}

export type TrendData = {
  readings: TrendReading[]; configs: TrendConfig[]; error: PostgrestError | null; truncated: boolean; total: number | null;
};

/**
 * The chart's data for one monitored location over one Bangkok period: all EFFECTIVE readings (voids and superseded rows are
 * already excluded by ci_environment_effective_readings) and all configuration versions, so each point keeps its own range.
 * check_date is the Bangkok calendar date of observed_at, so filtering on it is the Bangkok period exactly.
 */
export async function loadTrendData(client: SupabaseClient, warehouseId: number, monitorId: string, range: TrendRange, knownConfigs?: readonly TrendConfig[]): Promise<TrendData> {
  const [readings, configs] = await Promise.all([
    fetchAllPages<TrendReading>((from, to) => client.from('ci_environment_effective_readings').select(TREND_READING_COLUMNS, { count: 'exact' })
      .eq('warehouse_id', warehouseId).eq('location_id', monitorId).gte('check_date', range.from).lte('check_date', range.to)
      .order('observed_at', { ascending: true }).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<Page<TrendReading>>),
    // A caller that already read every version of this location (fully paged) passes them in instead of reading again.
    knownConfigs ? { rows: [...knownConfigs], error: null } : loadConfigVersions(client, monitorId),
  ]);
  return {
    readings: readings.rows, configs: configs.rows, error: readings.error ?? configs.error,
    truncated: readings.truncated, total: readings.total,
  };
}

/**
 * Metrics the chart offers for a location: what its current version monitors, plus anything monitored at some point inside the
 * chosen period (so history recorded before a parameter was switched off is still reachable).
 */
export function trendMetrics(configs: readonly TrendConfig[], current: TrendConfig | null | undefined, range: TrendRange) {
  return availableMetrics([current, ...versionsInForce(configs, range.start, range.end)]);
}
