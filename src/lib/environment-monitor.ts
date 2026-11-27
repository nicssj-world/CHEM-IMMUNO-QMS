// Mirrors ci_private.environment_monitor_location_id for rows the page has already read under RLS.
// Environment monitoring belongs to a monitored container (room, refrigerator, freezer, cabinet). A shelf inherits it from
// its parent unless the shelf has its own configuration. Locations or configs that RLS hid are simply absent from the inputs,
// so they resolve to null, exactly like the database function does for a caller who cannot read them.

export type MonitorLocation = { id: string; parent_location_id: string | null };
export type MonitorConfig = { location_id: string; temperature_monitored: boolean; humidity_monitored: boolean; effective_from: string };

function compareEffective(a: string, b: string) {
  const byTime = Date.parse(a) - Date.parse(b);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  // Versions can differ by microseconds, which Date cannot see; PostgREST timestamps share one format, so text order is time order.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The current version of each location's range configuration: the one with the latest effective_from. */
export function latestConfigByLocation<T extends MonitorConfig>(configs: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const config of configs) {
    const seen = latest.get(config.location_id);
    if (!seen || compareEffective(config.effective_from, seen.effective_from) > 0) latest.set(config.location_id, config);
  }
  return latest;
}

/** A location owns monitoring when its current version monitors at least one parameter. No version means no own monitoring. */
export function hasOwnMonitoring(config: Pick<MonitorConfig, 'temperature_monitored' | 'humidity_monitored'> | null | undefined) {
  return Boolean(config && (config.temperature_monitored || config.humidity_monitored));
}

/** Own monitoring wins; otherwise the parent's; otherwise null. Depth is at most two levels, so one step up is enough. */
export function resolveEnvironmentMonitor(locationId: string, locations: readonly MonitorLocation[], configs: readonly MonitorConfig[]): string | null {
  const byId = new Map(locations.map(location => [location.id, location]));
  const target = byId.get(locationId);
  if (!target) return null;
  const current = latestConfigByLocation(configs);
  if (hasOwnMonitoring(current.get(target.id))) return target.id;
  const parent = target.parent_location_id ? byId.get(target.parent_location_id) : undefined;
  if (parent && hasOwnMonitoring(current.get(parent.id))) return parent.id;
  return null;
}
