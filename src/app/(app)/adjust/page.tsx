import { randomUUID } from 'node:crypto';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { getStockOptions } from '@/lib/stock-options';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { StockOperationForm } from '@/components/stock-operation-form';

export default async function AdjustPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string; saved?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse);
  const { options, locations, error } = await getStockOptions(warehouse.id,true);
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Controlled adjustment</p><h1 className="page-title">ปรับยอดคงคลัง</h1><p className="muted mt-2 text-sm">เฉพาะ Supervisor / Admin · ระบุเหตุผลทุกครั้ง</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/adjust"/>{params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">ปรับยอดสำเร็จ</p>}{error && <p className="error" role="alert">{error}</p>}{!error && (canSupervise(warehouse.role) ? options.length ? <StockOperationForm kind="adjust" options={options} locations={locations} submissionKey={randomUUID()}/> : <p className="notice">ไม่มี LOT คงเหลือสำหรับปรับยอด</p> : <p className="error">ไม่มีสิทธิ์ปรับยอดคลังนี้</p>)}</main>;
}
