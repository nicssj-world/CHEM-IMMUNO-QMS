import type { AccessContext, Warehouse } from '@/lib/auth';

export function selectedWarehouse(access: AccessContext, code?: string): Warehouse {
  return access.warehouses.find((w) => w.code === code) ?? access.warehouses[0];
}
