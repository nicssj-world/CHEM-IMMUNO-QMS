import { randomUUID } from 'node:crypto';
import { requireAccess, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { IssueForm } from '@/components/issue-form';

type Product = { id: string; product_code: string; display_name: string };
type Candidate = { lot_id: string; lot_number: string; expiry_date: string; location_id: string; balance: number };
type Location = { id: string; code: string };

export default async function IssuePage({ searchParams }: { searchParams: Promise<{ warehouse?: string; product?: string; error?: string; saved?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access,params.warehouse);
  const client = await createClient();
  const [productsResult,locationsResult] = client ? await Promise.all([
    client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id',warehouse.id).eq('active',true).order('product_code').limit(250),
    client.from('ci_locations').select('id,code').eq('warehouse_id',warehouse.id),
  ]) : [{ data: [] },{ data: [] }];
  const products = (productsResult.data ?? []) as Product[];
  const locations = new Map(((locationsResult.data ?? []) as Location[]).map(l => [l.id,l.code]));
  const product = products.find(p => p.id === params.product);
  const { data: candidateData, error } = product && client ? await client.from('ci_fefo_candidates').select('lot_id,lot_number,expiry_date,location_id,balance').eq('warehouse_id',warehouse.id).eq('product_id',product.id).order('expiry_date').order('lot_number') : { data: [], error: null };
  const candidates = ((candidateData ?? []) as Candidate[]).map(c => ({...c,location_code: locations.get(c.location_id) ?? '—'}));
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Issue / Consumption</p><h1 className="page-title">เบิกใช้สินค้า</h1><p className="muted mt-2 text-sm">เลือกสินค้าก่อน ระบบจะแนะนำ LOT ที่หมดอายุก่อน</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/issue"/>{params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">เบิกสำเร็จ ยอดคงเหลือปรับแล้ว</p>}{error && <p className="error" role="alert">อ่าน LOT ไม่สำเร็จ: {error.message}</p>}
    <form method="get" className="surface p-5 sm:p-7 grid gap-4"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field">สินค้า<select className="input" name="product" defaultValue={product?.id ?? ''} required><option value="">เลือกสินค้า</option>{products.map(p => <option key={p.id} value={p.id}>{p.product_code} · {p.display_name}</option>)}</select></label><div><button className="button" type="submit">ดู LOT ที่เบิกได้</button></div></form>
    {product && !error && (candidates.length ? canMutate(warehouse.role) ? <IssueForm productId={product.id} candidates={candidates} submissionKey={randomUUID()}/> : <p className="error">คุณมีสิทธิ์ดูอย่างเดียวในคลังนี้</p> : <p className="notice">ไม่มี LOT ที่ยังไม่หมดอายุและมียอดคงเหลือสำหรับสินค้านี้</p>)}
  </main>;
}
