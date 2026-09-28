import { randomUUID } from 'node:crypto';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { getStockOptions } from '@/lib/stock-options';
import { savedNotice, userMessage } from '@/lib/messages';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { StockAdjustmentWorkbench } from '@/components/stock-adjustment-workbench';

export default async function AdjustPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; product?: string; error?: string; saved?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse);
  const { options, locations, products, error } = await getStockOptions(warehouse.id,{ includeZero: true, productId: params.product });
  const product = products.find(p => p.id === params.product);
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Controlled adjustment</p><h1 className="page-title">ปรับยอดคงคลัง</h1><p className="muted mt-2 text-sm">เฉพาะหัวหน้างาน / ผู้ดูแลระบบ · ระบุเหตุผลทุกครั้ง</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/adjust"/>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved,'ปรับยอดสำเร็จ')}</p>}{error && <p className="error" role="alert">{userMessage(error)}</p>}
    {!canSupervise(warehouse.role) ? <p className="error">ไม่มีสิทธิ์ปรับยอดคลังนี้</p> : <>
      {!error && <StockAdjustmentWorkbench key={`${warehouse.id}:${product?.id ?? ''}`} warehouseId={Number(warehouse.id)} warehouseCode={warehouse.code} products={products} locations={locations} initialOptions={options} initialProductId={product?.id ?? ''} submissionKey={randomUUID()}/>}
    </>}
  </main>;
}
