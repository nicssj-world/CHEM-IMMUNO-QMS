'use client';

import { useState } from 'react';
import { locationOptionLabel } from '@/lib/locations';

type Warehouse = { id: number; name: string };
type Location = { id: string; warehouse_id: number; code: string; name: string; parent_location_id: string | null };

/**
 * The New Product form's คลัง + ตำแหน่งจัดเก็บหลัก selects, kept in sync client-side: only Locations of the
 * currently-chosen warehouse are ever offered, and switching warehouse clears an incompatible previous choice
 * (never silently submits a Location from the other warehouse).
 */
export function ProductDefaultLocationField({ warehouses, locations, defaultWarehouseId }: { warehouses: readonly Warehouse[]; locations: readonly Location[]; defaultWarehouseId: number }) {
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId);
  const [locationId, setLocationId] = useState('');
  const byId = new Map(locations.map(location => [location.id, location]));
  const options = locations.filter(location => location.warehouse_id === warehouseId);
  return <>
    <label className="field">คลัง<select name="warehouse_id" className="input" required value={warehouseId}
      onChange={event => { setWarehouseId(Number(event.target.value)); setLocationId(''); }}>
      {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select></label>
    <label className="field">ตำแหน่งจัดเก็บหลัก (ค่าเริ่มต้นตอนรับเข้า)<select name="default_location_id" className="input" value={locationId} onChange={event => setLocationId(event.target.value)}>
      <option value="">ไม่กำหนด</option>
      {options.map(location => <option key={location.id} value={location.id}>{locationOptionLabel(location, byId)}</option>)}
    </select></label>
  </>;
}
