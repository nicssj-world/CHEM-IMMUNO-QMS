// Deterministic Location preselection for receiving. Priority: (1) the Product's own valid, active default Location
// in this warehouse; (2) if none, and exactly one Location exists in this warehouse, that one (existing behavior,
// unchanged); (3) otherwise blank - the user must choose. `locations` is expected already filtered to active ones
// (as every current caller already queries), so "valid" here only has to mean "exists in this warehouse".
//
// This never overrides a manual choice the caller already made; it is only ever used to compute the INITIAL value
// of a fresh draft package, never to overwrite `locationId` on an existing one.
export function preselectLocation(defaultLocationId: string | null | undefined, warehouseId: number, locations: readonly { id: string; warehouse_id: number }[]): string {
  const options = locations.filter(location => location.warehouse_id === warehouseId);
  if (defaultLocationId && options.some(location => location.id === defaultLocationId)) return defaultLocationId;
  return options.length === 1 ? options[0].id : '';
}
