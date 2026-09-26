import { randomUUID } from 'node:crypto';
import { requireAccess, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { getStockOptions } from '@/lib/stock-options';
import { savedNotice, userMessage } from '@/lib/messages';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { StockOperationForm } from '@/components/stock-operation-form';
import { ProductPicker } from '@/components/product-picker';

export default async function TransferPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; product?: string; error?: string; saved?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse);
  const { options, locations, products, error } = await getStockOptions(warehouse.id,{ productId: params.product });
  const product = products.find(p => p.id === params.product);
  const allowed = canMutate(warehouse.role);
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Same warehouse transfer</p><h1 className="page-title">ย้ายตำแหน่งสินค้า</h1><p className="muted mt-2 text-sm">ย้ายระหว่างตำแหน่งภายในคลังเดียวกันด้วย movement ลบและบวกคู่กัน</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/transfer"/>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved,'ย้ายตำแหน่งสำเร็จ')}</p>}{error && <p className="error" role="alert">{userMessage(error)}</p>}
    {!allowed ? <p className="error">คุณไม่มีสิทธิ์ย้ายสินค้าในคลังนี้</p> : locations.length < 2 ? <p className="notice">ต้องมีตำแหน่งจัดเก็บอย่างน้อยสองแห่งในคลังนี้</p> : <>
      <ProductPicker path="/transfer" warehouseCode={warehouse.code} products={products} selectedId={product?.id}/>
      {product && !error && (options.length ? <StockOperationForm key={product.id} kind="transfer" options={options} locations={locations} submissionKey={randomUUID()} warehouseCode={warehouse.code} productId={product.id}/> : <p className="notice">{product.product_code} ไม่มี LOT คงเหลือให้ย้าย</p>)}
    </>}
  </main>;
}
