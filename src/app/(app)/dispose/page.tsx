import { randomUUID } from 'node:crypto';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { getStockOptions } from '@/lib/stock-options';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { StockOperationForm } from '@/components/stock-operation-form';

function bangkokToday() {
  const parts = new Intl.DateTimeFormat('en-US',{ timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(p => [p.type,p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default async function DisposePage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string; saved?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse);
  const { options, locations, error } = await getStockOptions(warehouse.id);
  const expired = options.filter(o => o.expiry_date < bangkokToday());
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Expired disposal</p><h1 className="page-title">กำจัดสินค้าหมดอายุ</h1><p className="muted mt-2 text-sm">บันทึกเป็น transaction ชนิดเฉพาะ พร้อมเหตุผลและ audit</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/dispose"/>{params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">บันทึกการกำจัดสำเร็จ</p>}{error && <p className="error" role="alert">{error}</p>}{!error && (canSupervise(warehouse.role) ? expired.length ? <StockOperationForm kind="dispose" options={expired} locations={locations} submissionKey={randomUUID()}/> : <p className="notice">ไม่มี LOT หมดอายุที่มียอดคงเหลือ</p> : <p className="error">ไม่มีสิทธิ์กำจัด stock คลังนี้</p>)}</main>;
}
