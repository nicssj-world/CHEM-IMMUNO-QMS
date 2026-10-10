import type { AccessContext, Warehouse } from '@/lib/auth';

/** Only for deriving the physical ledger of an individual Product or historical event.
 * Read-only inventory screens must query all accessible warehouse ids.
 */
export function selectedWarehouse(access: AccessContext, code?: string): Warehouse {
  return access.warehouses.find((w) => w.code === code) ?? access.warehouses[0];
}
export function accessibleWarehouseIds(access: AccessContext): number[] {
  return access.warehouses.map(w => Number(w.id));
}
export function warehouseForProductCode(access: AccessContext, code: string): Warehouse | undefined {
  const group = code.startsWith('CHE-') ? 'CHE' : code.startsWith('IMM-') ? 'IMM' : null;
  return access.warehouses.find(w => w.code === group);
}
