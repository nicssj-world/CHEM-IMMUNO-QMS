/** Regions to check after full-image decoding fails. Coordinate math is independent
 * of browser APIs so we can test off-center and edge cases without a camera.
 */
export type PhotoScanRegion = { x: number; y: number; side: number };

export function photoScanRegions(width: number, height: number): PhotoScanRegion[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const shortest = Math.min(width, height);
  const regions: PhotoScanRegion[] = [];
  const seen = new Set<string>();
  const add = (cx: number, cy: number, fraction: number) => {
    const side = Math.max(1, Math.round(shortest * fraction));
    const x = Math.round(Math.max(0, Math.min(width - side, cx * width - side / 2)));
    const y = Math.round(Math.max(0, Math.min(height - side, cy * height - side / 2)));
    const key = `${x}:${y}:${side}`;
    if (!seen.has(key)) { seen.add(key); regions.push({ x, y, side }); }
  };
  // Broad center crop keeps the fast path for already centered photographs.
  add(.5, .5, .72);
  // First prefer horizontal off-center codes on product labels, then remaining tiles.
  // All tiles overlap; the symbol need not be exactly at any tile's center.
  for (const [x, y] of [
    [.82, .5], [.18, .5],
    [.82, .18], [.82, .82], [.18, .18], [.18, .82],
    [.5, .18], [.5, .82], [.5, .5],
  ]) add(x, y, .5);
  return regions;
}
