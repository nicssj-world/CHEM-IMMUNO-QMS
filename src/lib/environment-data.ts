import type { SupabaseClient } from '@supabase/supabase-js';
import { latestConfigByLocation } from './environment-monitor';
import { bangkokDate, ENV_CONFIG_COLUMNS, ENV_EXCURSION_COLUMNS, ENV_READING_COLUMNS, type DayRound, type EnvironmentExcursion, type EnvironmentReading, type MonitorConfig } from './environment';
import { LOCATION_COLUMNS, type LocationRow } from './locations';

/** Read-only RLS queries. Write authority remains entirely in the database RPCs. */
export async function loadEnvironmentOverview(client: SupabaseClient, warehouseId: number, day: string = bangkokDate()) {
  const [locationsResult, configsResult, roundsResult, readingsResult, excursionsResult] = await Promise.all([
    client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouseId).eq('active', true).order('code'),
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('warehouse_id', warehouseId).order('effective_from', { ascending: false }).limit(2000),
    client.rpc('ci_environment_day_status', { p_warehouse_id: warehouseId, p_date: day }),
    client.from('ci_environment_effective_readings').select(ENV_READING_COLUMNS).eq('warehouse_id', warehouseId).order('observed_at', { ascending: false }).limit(2000),
    client.from('ci_environment_excursions').select(ENV_EXCURSION_COLUMNS).eq('warehouse_id', warehouseId).neq('status', 'resolved').order('opened_at', { ascending: false }).limit(1000),
  ]);
  const error = [locationsResult, configsResult, roundsResult, readingsResult, excursionsResult].find(result => result.error)?.error;
  const locations = (locationsResult.data ?? []) as LocationRow[];
  const configs = latestConfigByLocation((configsResult.data ?? []) as MonitorConfig[]);
  const rounds = (roundsResult.data ?? []) as DayRound[];
  const readings = (readingsResult.data ?? []) as EnvironmentReading[];
  const excursions = (excursionsResult.data ?? []) as EnvironmentExcursion[];
  const latest = new Map<string, EnvironmentReading>();
  for (const reading of readings) if (!latest.has(reading.location_id)) latest.set(reading.location_id, reading);
  const byId = new Map(locations.map(location => [location.id, location]));
  const monitored = locations.filter(location => {
    const config = configs.get(location.id);
    return Boolean(config && (config.temperature_monitored || config.humidity_monitored));
  });
  return { error, locations, byId, configs, rounds, readings, excursions, latest, monitored };
}

export function roundSummary(rounds: DayRound[], locationId: string) {
  return rounds.filter(round => round.location_id === locationId);
}

export function environmentPriority(rounds: DayRound[], reading: EnvironmentReading | undefined, excursion: EnvironmentExcursion | undefined) {
  if (excursion || reading?.overall_status === 'out_of_range') return 0;
  if (rounds.some(round => round.state === 'missed')) return 1;
  if (rounds.some(round => round.state === 'due')) return 2;
  if (rounds.some(round => round.state === 'unscheduled')) return 3;
  if (rounds.some(round => round.state === 'upcoming')) return 4;
  if (rounds.some(round => round.state === 'satisfied')) return 5;
  return 6;
}
