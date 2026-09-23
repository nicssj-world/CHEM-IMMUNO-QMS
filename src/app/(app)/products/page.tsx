import Link from 'next/link';
import { Search, Plus } from 'lucide-react';
import { requireAccess, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';

type ProductRow = { id: string; product_code: string; display_name: string; product_type: string; packing_size_raw: string | null; active: boolean; usable_stock: number; rop: number | null; stock_status: string };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; q?: string; type?: string; platform?: string; stock?: string; expiry?: string; page?: string; error?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const q = (params.q ?? '').trim().slice(0,100);
  const type = ['reagent','calibrator','control','consumable'].includes(params.type??'') ? params.type! : null;
  const stock = ['stockout','below'].includes(params.stock??'') ? params.stock! : null;
  const expiry = ['EXPIRED','≤30','31–60','61–90','>90'].includes(params.expiry??'') ? params.expiry! : null;
  const page = Math.min(100,Math.max(1,Number.parseInt(params.page??'1',10)||1));
  const platformResult = await client.from('ci_platforms').select('id,display_name').eq('warehouse_id',warehouse.id).order('display_name');
  const platform = (platformResult.data??[]).some(p=>p.id===params.platform) ? params.platform! : null;
  const {data,error} = await client.rpc('ci_search_inventory',{p_warehouse_id:warehouse.id,p_query:q,p_type:type,p_platform_id:platform,p_stock_status:stock,p_expiry:expiry,p_limit:50,p_offset:(page-1)*50});
  const rows = (data??[]) as ProductRow[];
  const query = new URLSearchParams({warehouse:warehouse.code,q,type:type??'',platform:platform??'',stock:stock??'',expiry:expiry??''});
  return <main className="grid gap-6"><div className="flex flex-wrap justify-between items-end gap-4"><div><p className="eyebrow mb-2">Product master</p><h1 className="page-title">สินค้า</h1><p className="muted mt-2 text-sm">ค้นด้วย Product Code, REF, Barcode หรือชื่อสินค้า · {warehouse.name}</p></div>{canMutate(warehouse.role) && <Link href={`/products/new?warehouse=${warehouse.code}`} className="button"><Plus size={18}/>เพิ่มสินค้า</Link>}</div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/products"/>
    <form className="surface p-4 grid sm:grid-cols-2 xl:grid-cols-4 gap-3 items-end" method="get"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field sm:col-span-2">ค้นหา<input className="input" name="q" defaultValue={q} placeholder="Product Code / REF / Barcode / ชื่อ"/></label><label className="field">ประเภท<select className="input" name="type" defaultValue={type??''}><option value="">ทั้งหมด</option><option value="reagent">Reagent</option><option value="calibrator">Calibrator</option><option value="control">Control</option><option value="consumable">Consumable</option></select></label><label className="field">Platform<select className="input" name="platform" defaultValue={platform??''}><option value="">ทั้งหมด</option>{(platformResult.data??[]).map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label><label className="field">Stock<select className="input" name="stock" defaultValue={stock??''}><option value="">ทั้งหมด</option><option value="stockout">Stockout</option><option value="below">ต่ำกว่า ROP</option></select></label><label className="field">Expiry<select className="input" name="expiry" defaultValue={expiry??''}><option value="">ทั้งหมด</option>{['EXPIRED','≤30','31–60','61–90','>90'].map(x=><option key={x} value={x}>{x}</option>)}</select></label><button className="button" type="submit"><Search size={17}/>ค้นหา</button></form>
    {params.error && <p className="error" role="alert">{params.error}</p>}{(error||platformResult.error) && <p className="error" role="alert">โหลดสินค้าไม่สำเร็จ: {(error||platformResult.error)?.message}</p>}
    {!error && <section className="surface overflow-hidden"><div className="px-5 py-4 flex justify-between"><h2 className="font-bold">รายการสินค้า</h2><span className="muted text-sm">หน้า {page} · {rows.length} รายการ</span></div><div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>Product Code</th><th>ชื่อสินค้า</th><th>ประเภท</th><th>ขนาดบรรจุ</th><th>Usable</th><th>Stock</th></tr></thead><tbody>{rows.map(p=><tr key={p.id}><td><Link href={`/products/${p.id}`} className="font-bold text-[#126390]">{p.product_code}</Link></td><td>{p.display_name}</td><td>{p.product_type}</td><td>{p.packing_size_raw||'—'}</td><td>{Number(p.usable_stock).toLocaleString()}</td><td>{p.stock_status}</td></tr>)}</tbody></table></div><div className="mobile-card-list px-4 pb-4">{rows.map(p=><Link key={p.id} href={`/products/${p.id}`} className="border border-[#dce7eb] rounded-xl p-4 no-underline text-[var(--ink)]"><div className="flex justify-between gap-2"><strong className="text-[#126390]">{p.product_code}</strong><span className="badge">{p.product_type}</span></div><p className="font-bold mt-2">{p.display_name}</p><p className="muted text-sm">{p.packing_size_raw||'—'} · usable {Number(p.usable_stock).toLocaleString()} · {p.stock_status}</p></Link>)}</div>{rows.length===0 && <p className="muted px-5 pb-5">ไม่พบสินค้า</p>}</section>}
    <nav aria-label="หน้าผลการค้นหา" className="flex gap-3">{page>1 && <Link className="button secondary" href={`/products?${query}&page=${page-1}`}>ก่อนหน้า</Link>}{rows.length===50 && <Link className="button secondary" href={`/products?${query}&page=${page+1}`}>ถัดไป</Link>}</nav>
  </main>;
}
