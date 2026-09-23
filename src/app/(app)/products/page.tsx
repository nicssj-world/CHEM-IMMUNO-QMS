import Link from 'next/link';
import { Search, Plus } from 'lucide-react';
import { requireAccess, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';

type ProductRow = { id: string; product_code: string; display_name: string; source_name: string; product_type: string; packing_size_raw: string | null; active: boolean };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; q?: string; type?: string; error?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const q = (params.q ?? '').trim().slice(0, 100);
  const type = ['reagent','calibrator','control','consumable'].includes(params.type ?? '') ? params.type : undefined;
  const client = await createClient();
  let request = client?.from('ci_products').select('id,product_code,display_name,source_name,product_type,packing_size_raw,active').eq('warehouse_id', warehouse.id).order('product_code').limit(200);
  if (type) request = request?.eq('product_type', type);
  const { data, error } = request ? await request : { data: null, error: null };
  let rows = (data ?? []) as ProductRow[];
  let identifierError: string | null = null;
  if (q && client) {
    const match = await client.from('ci_product_identifiers').select('product_id').eq('warehouse_id',warehouse.id).ilike('value',`%${q}%`).limit(200);
    identifierError = match.error?.message ?? null;
    const matchingIds = new Set((match.data ?? []).map(x => x.product_id));
    const lower = q.toLocaleLowerCase();
    rows = rows.filter(p => matchingIds.has(p.id) || `${p.product_code} ${p.display_name} ${p.source_name}`.toLocaleLowerCase().includes(lower));
  }
  return <main className="grid gap-6">
    <div className="flex flex-wrap justify-between items-end gap-4"><div><p className="eyebrow mb-2">Product master</p><h1 className="page-title">สินค้า</h1><p className="muted mt-2 text-sm">ค้นด้วย Product Code หรือชื่อสินค้า · {warehouse.name}</p></div>{canMutate(warehouse.role) && <Link href={`/products/new?warehouse=${warehouse.code}`} className="button"><Plus size={18}/>เพิ่มสินค้า</Link>}</div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/products"/>
    <form className="surface p-4 flex flex-wrap gap-3 items-end" method="get"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field flex-1 min-w-[200px]">ค้นหา<input className="input" name="q" defaultValue={q} placeholder="รหัสสินค้า / ชื่อ / REF"/></label><label className="field min-w-[150px]">ประเภท<select className="input" name="type" defaultValue={type ?? ''}><option value="">ทั้งหมด</option><option value="reagent">Reagent</option><option value="calibrator">Calibrator</option><option value="control">Control</option><option value="consumable">Consumable</option></select></label><button className="button" type="submit"><Search size={17}/>ค้นหา</button></form>
    {params.error && <p className="error" role="alert">{params.error}</p>}
    {(error || identifierError) && <p className="error" role="alert">โหลดสินค้าไม่สำเร็จ: {error?.message ?? identifierError}</p>}
    {!error && <div className="surface overflow-hidden"><div className="px-5 py-4 flex justify-between"><h2 className="font-bold">รายการสินค้า</h2><span className="muted text-sm">{rows.length}{rows.length === 200 ? '+' : ''} รายการ</span></div><div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>Product Code</th><th>ชื่อสินค้า</th><th>ประเภท</th><th>ขนาดบรรจุ</th><th>สถานะ</th></tr></thead><tbody>{rows.map(p => <tr key={p.id}><td><Link className="font-bold text-[#126390]" href={`/products/${p.id}`}>{p.product_code}</Link></td><td>{p.display_name}</td><td>{p.product_type}</td><td>{p.packing_size_raw || '—'}</td><td><span className="badge">{p.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></td></tr>)}</tbody></table></div><div className="mobile-card-list px-4 pb-4">{rows.map(p => <Link key={p.id} href={`/products/${p.id}`} className="border border-[#dce7eb] rounded-xl p-4 no-underline text-[var(--ink)]"><div className="flex justify-between gap-2"><span className="text-[#126390] font-bold">{p.product_code}</span><span className="badge">{p.product_type}</span></div><p className="font-bold mt-2">{p.display_name}</p><p className="muted text-xs mt-1">{p.packing_size_raw || 'ไม่ระบุขนาดบรรจุ'}</p></Link>)}</div>{rows.length === 0 && <p className="muted px-5 pb-5 text-sm">ไม่พบสินค้าในเงื่อนไขนี้</p>}</div>}
  </main>;
}
