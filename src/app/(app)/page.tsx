import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { expiryBucket, fiscalYear, bangkokToday, stockStatus } from '@/lib/inventory-insights';

type Reorder = { product_id: string; usable_stock: number; rop: number | null; suggested_order: number | null };
type Balance = { expiry_date: string };
type Movement = { id: string; kind: string; created_at: string; purpose: string | null };
type VendorMetric = { receipt_count: number; discrepancy_count: number };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, (await searchParams).warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const [products, reorders, balances, lots, movements, vendors, mapping, issues] = await Promise.all([
    client.from('ci_products').select('id',{count:'exact'}).eq('warehouse_id',warehouse.id).eq('active',true).limit(500),
    client.from('ci_reorder_status').select('product_id,usable_stock,rop,suggested_order').eq('warehouse_id',warehouse.id).limit(500),
    client.from('ci_stock_balances').select('expiry_date',{count:'exact'}).eq('warehouse_id',warehouse.id).gt('balance',0).limit(1000),
    client.from('ci_stock_lots').select('id',{count:'exact',head:true}).eq('warehouse_id',warehouse.id),
    client.from('ci_stock_transactions').select('id,kind,created_at,purpose').eq('warehouse_id',warehouse.id).order('created_at',{ascending:false}).limit(8),
    client.from('ci_vendor_metrics').select('receipt_count,discrepancy_count').eq('warehouse_id',warehouse.id).eq('fiscal_year',fiscalYear(bangkokToday())).limit(100),
    client.from('ci_identifier_mapping_requests').select('id',{count:'exact',head:true}).eq('warehouse_id',warehouse.id).eq('status','proposed'),
    client.from('ci_vendor_issues').select('id',{count:'exact',head:true}).eq('warehouse_id',warehouse.id).eq('status','open'),
  ]);
  const error = [products,reorders,balances,lots,movements,vendors,mapping,issues].find(r=>r.error)?.error;
  if (error) return <main className="grid gap-4"><h1 className="page-title">ภาพรวมคลัง</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {error.message}</p></main>;
  if ((products.count??0)>500 || (balances.count??0)>1000) return <p className="error" role="alert">ข้อมูลคลังเกินขอบเขตสรุป Dashboard · กรุณาใช้รายงานหรือค้นหาแบบแบ่งหน้า</p>;
  const activeIds = new Set((products.data??[]).map(p=>p.id));
  const reorderRows = ((reorders.data ?? []) as Reorder[]).filter(r=>activeIds.has(r.product_id));
  const balanceRows = (balances.data ?? []) as Balance[];
  const vendorRows = (vendors.data ?? []) as VendorMetric[];
  const stockout = reorderRows.filter(r=>stockStatus(Number(r.usable_stock),r.rop==null?null:Number(r.rop))==='stockout').length;
  const below = reorderRows.filter(r=>stockStatus(Number(r.usable_stock),r.rop==null?null:Number(r.rop))==='below ROP').length;
  const expiring30 = balanceRows.filter(r=>expiryBucket(r.expiry_date)==='≤30').length;
  const expiring90 = balanceRows.filter(r=>['≤30','31–60','61–90'].includes(expiryBucket(r.expiry_date))).length;
  const expired = balanceRows.filter(r=>expiryBucket(r.expiry_date)==='EXPIRED').length;
  const recent = (movements.data ?? []) as Movement[];
  const openAttention = stockout+below+expired+expiring90+(mapping.count??0)+(issues.count??0)+vendorRows.reduce((n,r)=>n+Number(r.discrepancy_count),0);
  const cards = [
    ['Products',products.count??'—','/products'],['Stockout',stockout,'/attention?type=stockout'],['ต่ำกว่า ROP',below,'/attention?type=below'],
    ['หมดอายุ ≤30 วัน',expiring30,'/attention?type=%E2%89%A430'],['หมดอายุ ≤90 วัน',expiring90,'/attention'],['LOT ทั้งหมด',lots.count??'—','/stock'],
    ['รับเข้าล่าสุด',recent.filter(r=>r.kind==='receive').length,'/movements'],['เบิกล่าสุด',recent.filter(r=>r.kind==='issue').length,'/movements'],['Need Attention',openAttention,'/attention'],
  ] as const;
  return <main className="grid gap-6"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow mb-2">Warehouse dashboard</p><h1 className="page-title">ภาพรวมคลัง {warehouse.name}</h1><p className="muted mt-2 text-sm">ข้อมูลสดของคลังที่เลือก · {bangkokToday()}</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse}/></div>
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">{cards.map(([label,count,href])=><Link key={label} href={`${href}${href.includes('?')?'&':'?'}warehouse=${warehouse.code}`} className="surface p-4 no-underline text-[var(--ink)]"><p className="muted text-sm">{label}</p><strong className="text-2xl mt-2 block">{count}</strong></Link>)}</div>
    <div className="grid lg:grid-cols-2 gap-4"><section className="surface p-5 grid gap-3"><h2 className="font-bold text-lg">งานที่ต้องติดตาม</h2><p>Stockout {stockout} · ต่ำกว่า ROP {below} · Expired LOT {expired}</p><p>Barcode รออนุมัติ {mapping.count??0} · Vendor issue เปิด {issues.count??0}</p><Link className="button secondary" href={`/attention?warehouse=${warehouse.code}`}>เปิด Attention Center</Link></section><section className="surface p-5 grid gap-3"><h2 className="font-bold text-lg">การใช้และสั่งซื้อ</h2><p>สินค้าแนะนำสั่ง {reorderRows.filter(r=>Number(r.suggested_order)>0).length} รายการ</p><p>ปีงบประมาณ {fiscalYear(bangkokToday())}: รับเข้า {vendorRows.reduce((n,r)=>n+Number(r.receipt_count),0)} ครั้ง · พบความคลาดเคลื่อน {vendorRows.reduce((n,r)=>n+Number(r.discrepancy_count),0)} ครั้ง</p><div className="flex flex-wrap gap-2"><Link className="button secondary" href={`/reorder?warehouse=${warehouse.code}`}>ROP / Suggested Order</Link><Link className="button secondary" href={`/reports/monthly?warehouse=${warehouse.code}`}>รายงานรายเดือน</Link></div></section></div>
    <section className="surface p-5"><h2 className="font-bold text-lg mb-3">ความเคลื่อนไหวล่าสุด</h2><div className="grid gap-2">{recent.map(row=><p className="border rounded-lg p-3 text-sm" key={row.id}><strong>{row.kind}</strong>{row.purpose ? ` · ${row.purpose}` : ''} · {new Intl.DateTimeFormat('th-TH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Bangkok'}).format(new Date(row.created_at))}</p>)}{recent.length===0 && <p className="muted">ยังไม่มีธุรกรรม stock</p>}</div></section>
    <div className="flex flex-wrap gap-2"><Link className="button" href={`/scan?warehouse=${warehouse.code}`}>สแกน</Link><Link className="button" href={`/receive?warehouse=${warehouse.code}`}>รับเข้า</Link><Link className="button secondary" href={`/stock?warehouse=${warehouse.code}`}>ดู Stock</Link></div>
  </main>;
}
