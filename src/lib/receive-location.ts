// Deterministic Location preselection for receiving. Priority: (1) the Product's own valid, active default Location
// in the shared registry; (2) the last successfully received Location of this Product if active;
// (3) if neither, the only active Location; (4) otherwise blank - the user must choose. `locations` is expected already filtered to active ones
// (as every current caller already queries), so "valid" here means "exists in the shared catalog".
//
// This never overrides a manual choice the caller already made; it is only ever used to compute the INITIAL value
// of a fresh draft package, never to overwrite `locationId` on an existing one.
export function preselectLocation(defaultLocationId: string | null | undefined, warehouseId: number, locations: readonly { id: string; warehouse_id: number }[], recentLocationId?: string | null): string {
  void warehouseId; // Product warehouse still governs stock, not physical storage eligibility.
  const options = locations;
  if (defaultLocationId && options.some(location => location.id === defaultLocationId)) return defaultLocationId;
  if (recentLocationId && options.some(location => location.id === recentLocationId)) return recentLocationId;
  return options.length === 1 ? options[0].id : '';
}
