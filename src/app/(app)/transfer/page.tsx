import { randomUUID } from 'node:crypto';
import { requireAccess, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { getStockOptions } from '@/lib/stock-options';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { StockOperationForm } from '@/components/stock-operation-form';

export default async function TransferPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string; saved?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse);
  const { options, locations, error } = await getStockOptions(warehouse.id);
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Same warehouse transfer</p><h1 className="page-title">ย้ายตำแหน่งสินค้า</h1><p className="muted mt-2 text-sm">ย้ายระหว่างตำแหน่งภายในคลังเดียวกันด้วย movement ลบและบวกคู่กัน</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/transfer"/>{params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">ย้ายตำแหน่งสำเร็จ</p>}{error && <p className="error" role="alert">{error}</p>}{!error && (options.length && locations.length > 1 ? canMutate(warehouse.role) ? <StockOperationForm kind="transfer" options={options} locations={locations} submissionKey={randomUUID()}/> : <p className="error">คุณไม่มีสิทธิ์ย้ายสินค้าในคลังนี้</p> : <p className="notice">ต้องมีสินค้าคงเหลือและตำแหน่งอย่างน้อยสองแห่งในคลังนี้</p>)}</main>;
}
