import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';

type Balance = { product_id: string; lot_id: string; lot_number: string; expiry_date: string; location_id: string; balance: number };
type Product = { id: string; product_code: string; display_name: string; product_type: string };
type Location = { id: string; code: string; name: string };

export default async function StockPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; q?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  const [balancesResult, productsResult, locationsResult] = client ? await Promise.all([
    client.from('ci_stock_balances').select('product_id,lot_id,lot_number,expiry_date,location_id,balance').eq('warehouse_id', warehouse.id).gt('balance', 0).order('expiry_date').limit(500),
    client.from('ci_products').select('id,product_code,display_name,product_type').eq('warehouse_id', warehouse.id).limit(500),
    client.from('ci_locations').select('id,code,name').eq('warehouse_id', warehouse.id),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  const productMap = new Map(((productsResult.data ?? []) as Product[]).map(p => [p.id,p]));
  const locationMap = new Map(((locationsResult.data ?? []) as Location[]).map(l => [l.id,l]));
  const search = (params.q ?? '').toLocaleLowerCase().trim();
  const rows = ((balancesResult.data ?? []) as Balance[]).filter(b => {
    const product = productMap.get(b.product_id);
    return !search || `${product?.product_code ?? ''} ${product?.display_name ?? ''} ${b.lot_number}`.toLocaleLowerCase().includes(search);
  });
  const error = balancesResult.error ?? productsResult.error ?? locationsResult.error;
  const total = rows.reduce((sum,b) => sum + Number(b.balance),0);
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Inventory lookup</p><h1 className="page-title">ยอดคงคลัง</h1><p className="muted mt-2 text-sm">ยอดจาก confirmed movement ledger แยกตาม LOT และตำแหน่ง</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/stock"/>
    <form method="get" className="surface p-4 flex gap-3 flex-wrap items-end"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field flex-1 min-w-[200px]">ค้นหาสินค้า / LOT<input className="input" name="q" defaultValue={params.q ?? ''} placeholder="รหัสสินค้า ชื่อ หรือ LOT"/></label><button className="button">ค้นหา</button></form>
    {error && <p className="error" role="alert">อ่านยอดคงคลังไม่สำเร็จ: {error.message}</p>}
    {!error && <><div className="surface p-5 flex justify-between gap-4"><div><p className="muted text-sm">จำนวนรายการ LOT × Location</p><p className="text-2xl font-extrabold">{rows.length}</p></div><div className="text-right"><p className="muted text-sm">ยอดรวมหน่วยฐาน</p><p className="text-2xl font-extrabold">{total.toLocaleString()}</p></div></div><section className="surface overflow-hidden"><div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>สินค้า</th><th>LOT</th><th>วันหมดอายุ</th><th>ตำแหน่ง</th><th className="text-right">คงเหลือ</th></tr></thead><tbody>{rows.map(row => { const product = productMap.get(row.product_id); const location = locationMap.get(row.location_id); return <tr key={`${row.lot_id}:${row.location_id}`}><td><Link href={`/products/${row.product_id}`} className="font-bold text-[#126390]">{product?.product_code ?? '—'}</Link><p className="text-sm">{product?.display_name ?? '—'}</p></td><td>{row.lot_number}</td><td>{row.expiry_date}</td><td>{location?.code ?? '—'}</td><td className="text-right font-bold">{Number(row.balance).toLocaleString()}</td></tr>; })}</tbody></table></div><div className="mobile-card-list p-4">{rows.map(row => { const product = productMap.get(row.product_id); const location = locationMap.get(row.location_id); return <article className="border border-[#dce7eb] rounded-xl p-4" key={`${row.lot_id}:${row.location_id}`}><div className="flex justify-between gap-3"><Link href={`/products/${row.product_id}`} className="font-bold text-[#126390]">{product?.product_code ?? '—'}</Link><strong>{Number(row.balance).toLocaleString()}</strong></div><p className="font-semibold text-sm mt-1">{product?.display_name ?? '—'}</p><dl className="grid grid-cols-2 gap-2 mt-3 text-xs"><div><dt className="muted">LOT</dt><dd className="font-semibold">{row.lot_number}</dd></div><div><dt className="muted">หมดอายุ</dt><dd className="font-semibold">{row.expiry_date}</dd></div><div><dt className="muted">ตำแหน่ง</dt><dd className="font-semibold">{location?.code ?? '—'}</dd></div></dl></article>; })}</div>{rows.length === 0 && <p className="muted p-5">ไม่มียอดคงคลังตามเงื่อนไข</p>}</section></>}
  </main>;
}
