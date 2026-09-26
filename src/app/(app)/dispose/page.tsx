import { randomUUID } from 'node:crypto';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { getStockOptions } from '@/lib/stock-options';
import { bangkokToday } from '@/lib/inventory-insights';
import { savedNotice, userMessage } from '@/lib/messages';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { StockOperationForm } from '@/components/stock-operation-form';

export default async function DisposePage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string; saved?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse);
  // Only expired rows are loaded, so the list stays short and complete however large the ledger grows.
  const { options: expired, locations, error } = await getStockOptions(warehouse.id,{ expiredBefore: bangkokToday() });
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Expired disposal</p><h1 className="page-title">กำจัดสินค้าหมดอายุ</h1><p className="muted mt-2 text-sm">บันทึกเป็น transaction ชนิดเฉพาะ พร้อมเหตุผลและ audit</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/dispose"/>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved,'บันทึกการกำจัดสำเร็จ')}</p>}{error && <p className="error" role="alert">{userMessage(error)}</p>}
    {!error && (canSupervise(warehouse.role) ? expired.length ? <StockOperationForm kind="dispose" options={expired} locations={locations} submissionKey={randomUUID()} warehouseCode={warehouse.code}/> : <p className="notice">ไม่มี LOT หมดอายุที่มียอดคงเหลือในคลังนี้</p> : <p className="error">ไม่มีสิทธิ์กำจัดสต็อกคลังนี้</p>)}
  </main>;
}
