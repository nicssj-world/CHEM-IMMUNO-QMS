// Counting units a product can be stocked in. Chosen from a list so the same unit is always spelled the same way;
// the list lives in code (not a database constraint) so adding a unit later needs no migration.
// 'pack' is the value every product started with, so it stays valid and is shown as "แพ็ก".
export const STOCK_UNITS = [
  { value: 'pack', label: 'แพ็ก' },
  { value: 'กล่อง', label: 'กล่อง' },
  { value: 'ขวด', label: 'ขวด' },
  { value: 'ชุด', label: 'ชุด' },
  { value: 'ชิ้น', label: 'ชิ้น' },
  { value: 'เทสต์', label: 'เทสต์' },
] as const;

export const isStockUnit = (value: string) => STOCK_UNITS.some(unit => unit.value === value);

/** Text shown next to quantities; a value outside the list (should not exist) is shown as stored rather than hidden. */
export function unitLabel(value: string | null | undefined) {
  return STOCK_UNITS.find(unit => unit.value === value)?.label ?? value ?? '';
}
