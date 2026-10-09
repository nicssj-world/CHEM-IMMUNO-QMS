import type { Warehouse } from '@/lib/auth';

/** Legacy compatibility only: operational scope is the unified CHEM-IMMUNO inventory. */
export function WarehouseSwitch({ warehouses, selected, path }: { warehouses: Warehouse[]; selected: Warehouse; path?: string }) {
  void warehouses; void selected; void path;
  return null;
}
