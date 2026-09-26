import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { expiryBucket } from '@/lib/inventory-insights';
import { logUserMessage } from '@/lib/messages';

type Row = { product_id: string; product_code: string; display_name: string; lot_id: string; lot_number: string; expiry_date: string; location_id: string; location_code: string; balance: number };

export default async function StockPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; q?: string; page?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access,params.warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const q=(params.q??'').trim().slice(0,100);
  const page=Math.min(10000,Math.max(1,Number.parseInt(params.page??'1',10)||1));
  const {data,error}=await client.rpc('ci_search_stock',{p_warehouse_id:warehouse.id,p_query:q,p_limit:50,p_offset:(page-1)*50});
  const rows=(data??[]) as Row[];
  const subtotal=rows.reduce((sum,row)=>sum+Number(row.balance),0);
  const url=new URLSearchParams({warehouse:warehouse.code,q});
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Inventory lookup</p><h1 className="page-title">ยอดคงคลัง</h1><p className="muted mt-2 text-sm">ยอดจาก signed ledger แยกตาม Product, LOT และตำแหน่ง · {warehouse.name}</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/stock"/>
    <form method="get" className="surface p-4 flex gap-3 flex-wrap items-end"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field flex-1 min-w-[200px]">ค้นหาสินค้า / REF / Barcode / LOT<input className="input" name="q" defaultValue={q} placeholder="รหัสสินค้า ชื่อ REF Barcode หรือ LOT"/></label><button className="button">ค้นหา</button></form>
    {error && <p className="error" role="alert">อ่านยอดคงคลังไม่สำเร็จ: {logUserMessage('stock', error)}</p>}
    {!error && <><div className="surface p-5 flex justify-between gap-4"><div><p className="muted text-sm">หน้า {page} · รายการ LOT × Location</p><p className="text-2xl font-extrabold">{rows.length}</p></div><div className="text-right"><p className="muted text-sm">ยอดรวมเฉพาะหน้านี้</p><p className="text-2xl font-extrabold">{subtotal.toLocaleString()}</p></div></div><section className="surface overflow-hidden"><div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>สินค้า</th><th>LOT</th><th>วันหมดอายุ</th><th>ตำแหน่ง</th><th className="text-right">คงเหลือ</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.lot_id}:${row.location_id}`}><td><Link href={`/products/${row.product_id}`} className="font-bold text-brand">{row.product_code}</Link><p className="text-sm">{row.display_name}</p></td><td>{row.lot_number}</td><td>{row.expiry_date} · {expiryBucket(row.expiry_date)}</td><td>{row.location_code}</td><td className="text-right font-bold">{Number(row.balance).toLocaleString()}</td></tr>)}</tbody></table></div><div className="mobile-card-list p-4">{rows.map(row=><article className="border border-line rounded-xl p-4" key={`${row.lot_id}:${row.location_id}`}><div className="flex justify-between gap-3"><Link href={`/products/${row.product_id}`} className="font-bold text-brand">{row.product_code}</Link><strong>{Number(row.balance).toLocaleString()}</strong></div><p className="font-semibold text-sm mt-1">{row.display_name}</p><dl className="grid grid-cols-2 gap-2 mt-3 text-xs"><div><dt className="muted">LOT</dt><dd className="font-semibold">{row.lot_number}</dd></div><div><dt className="muted">หมดอายุ</dt><dd className="font-semibold">{row.expiry_date} · {expiryBucket(row.expiry_date)}</dd></div><div><dt className="muted">ตำแหน่ง</dt><dd className="font-semibold">{row.location_code}</dd></div></dl></article>)}</div>{rows.length===0 && <p className="muted p-5">ไม่มียอดคงคลังตามเงื่อนไข</p>}</section><nav aria-label="หน้าผลการค้นหา" className="flex gap-3">{page>1 && <Link className="button secondary" href={`/stock?${url}&page=${page-1}`}>ก่อนหน้า</Link>}{rows.length===50 && <Link className="button secondary" href={`/stock?${url}&page=${page+1}`}>ถัดไป</Link>}</nav></>}
  </main>;
}
