import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { addDays, bangkokToday, fiscalYear, reorderAttention } from '@/lib/inventory-insights';
import { formatDate, formatDateTime } from '@/lib/format';
import { label, movementKindLabels } from '@/lib/labels';
import { logUserMessage } from '@/lib/messages';

type Reorder = { product_id: string; usable_stock: number; rop: number | null; suggested_order: number | null };
type Movement = { id: string; kind: string; created_at: string; purpose: string | null };
type VendorMetric = { receipt_count: number; discrepancy_count: number };
type Tone = 'alert' | 'warn' | 'neutral';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, (await searchParams).warehouse);
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">ภาพรวมคลัง</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const today = bangkokToday();
  const weekAgo = `${addDays(today, -6)}T00:00:00+07:00`; // today plus the six days before it, in Bangkok
  // Counts come from head-only queries so they stay exact however many LOTs or products the warehouse holds.
  const positive = () => client.from('ci_stock_balances').select('lot_id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).gt('balance', 0);
  const movementCount = (kind: string) => client.from('ci_stock_transactions').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).eq('kind', kind).gte('created_at', weekAgo);
  const [products, reorders, expired, expiring30, expiring90, stockedRows, lots, received7, issued7, movements, vendors, mapping, issues] = await Promise.all([
    client.from('ci_products').select('id', { count: 'exact' }).eq('warehouse_id', warehouse.id).eq('active', true).limit(2000),
    client.from('ci_reorder_status').select('product_id,usable_stock,rop,suggested_order').eq('warehouse_id', warehouse.id).limit(2000),
    positive().lt('expiry_date', today),
    positive().gte('expiry_date', today).lte('expiry_date', addDays(today, 30)),
    positive().gte('expiry_date', today).lte('expiry_date', addDays(today, 90)),
    positive(),
    client.from('ci_stock_lots').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id),
    movementCount('receive'),
    movementCount('issue'),
    client.from('ci_stock_transactions').select('id,kind,created_at,purpose').eq('warehouse_id', warehouse.id).order('created_at', { ascending: false }).limit(8),
    client.from('ci_vendor_metrics').select('receipt_count,discrepancy_count').eq('warehouse_id', warehouse.id).eq('fiscal_year', fiscalYear(today)).limit(500),
    client.from('ci_identifier_mapping_requests').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).eq('status', 'proposed'),
    client.from('ci_vendor_issues').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).eq('status', 'open'),
  ]);
  const error = [products, reorders, expired, expiring30, expiring90, stockedRows, lots, received7, issued7, movements, vendors, mapping, issues].find(r => r.error)?.error;
  if (error) return <main className="grid gap-4"><h1 className="page-title">ภาพรวมคลัง</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('dashboard', error)}</p></main>;
  const activeIds = new Set((products.data ?? []).map(p => p.id));
  const reorderRows = ((reorders.data ?? []) as Reorder[]).filter(r => activeIds.has(r.product_id));
  const status = reorderRows.map(r => reorderAttention(Number(r.usable_stock), r.rop == null ? null : Number(r.rop)));
  const stockout = status.filter(s => s === 'stockout').length;
  const below = status.filter(s => s === 'below').length;
  const noRop = status.filter(s => s === 'no-rop').length;
  const vendorRows = (vendors.data ?? []) as VendorMetric[];
  const recent = (movements.data ?? []) as Movement[];
  const suggested = reorderRows.filter(r => Number(r.suggested_order) > 0).length;
  const code = warehouse.code;
  const cards: { label: string; count: number | string; href: string; tone: Tone; hint?: string }[] = [
    { label: 'สินค้าที่ใช้งาน', count: products.count ?? '—', href: '/products', tone: 'neutral' },
    { label: 'หมดสต็อก', count: stockout, href: '/attention?type=stockout', tone: 'alert', hint: 'เฉพาะสินค้าที่ตั้ง ROP แล้ว' },
    { label: 'ต่ำกว่า ROP', count: below, href: '/attention?type=below', tone: 'warn' },
    { label: 'LOT หมดอายุแล้ว', count: expired.count ?? 0, href: '/attention?type=EXPIRED', tone: 'alert', hint: 'ยังมียอดคงเหลือ' },
    { label: 'หมดอายุใน 30 วัน', count: expiring30.count ?? 0, href: '/attention?type=%E2%89%A430', tone: 'warn' },
    { label: 'หมดอายุใน 90 วัน', count: expiring90.count ?? 0, href: '/attention', tone: 'neutral' },
    { label: 'ยังไม่ตั้ง ROP', count: noRop, href: '/reorder', tone: 'neutral' },
    { label: 'LOT ทั้งหมด', count: lots.count ?? '—', href: '/stock', tone: 'neutral' },
    { label: 'รับเข้า 7 วัน', count: received7.count ?? 0, href: '/movements', tone: 'neutral', hint: 'จำนวนครั้ง' },
    { label: 'เบิกใช้ 7 วัน', count: issued7.count ?? 0, href: '/movements', tone: 'neutral', hint: 'จำนวนครั้ง' },
  ];
  const empty = (stockedRows.count ?? 0) === 0;
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Warehouse dashboard</p><h1 className="page-title">ภาพรวมคลัง {warehouse.name}</h1><p className="muted mt-2 text-sm">ข้อมูลสดของคลังที่เลือก · {formatDate(today)}</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse}/>
    {empty && <section className="notice grid gap-3"><p><strong>คลังนี้ยังไม่มีสต็อกคงเหลือ</strong> · เริ่มจากรับสินค้าเข้าตาม Invoice แล้วตั้งค่า ROP ให้สินค้าที่ใช้ประจำ</p><div className="flex flex-wrap gap-2"><Link className="button" href={`/receive?warehouse=${code}`}>รับสินค้าเข้า</Link><Link className="button secondary" href={`/reorder?warehouse=${code}`}>ตั้งค่า ROP</Link></div></section>}
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">{cards.map(card => <Link key={card.label} href={`${card.href}${card.href.includes('?') ? '&' : '?'}warehouse=${code}`} className="kpi surface p-4 no-underline text-[var(--ink)]" data-tone={Number(card.count) > 0 ? card.tone : 'neutral'}><p className="muted text-sm">{card.label}</p><strong className="text-2xl mt-2 block tabular-nums">{card.count}</strong>{card.hint && <p className="muted text-xs mt-1">{card.hint}</p>}</Link>)}</div>
    <div className="grid lg:grid-cols-2 gap-4"><section className="surface p-5 grid gap-3"><h2 className="font-bold text-lg">งานที่ต้องติดตาม</h2><p>หมดสต็อก {stockout} · ต่ำกว่า ROP {below} · LOT หมดอายุแล้ว {expired.count ?? 0}</p><p>Barcode รออนุมัติ {mapping.count ?? 0} · ปัญหาผู้ขายที่เปิดอยู่ {issues.count ?? 0}</p><Link className="button secondary" href={`/attention?warehouse=${code}`}>เปิดรายการที่ต้องติดตาม</Link></section><section className="surface p-5 grid gap-3"><h2 className="font-bold text-lg">การใช้และสั่งซื้อ</h2><p>สินค้าแนะนำสั่ง {suggested} รายการ</p><p>ปีงบประมาณ {fiscalYear(today)}: รับเข้า {vendorRows.reduce((n, r) => n + Number(r.receipt_count), 0)} ครั้ง · พบความคลาดเคลื่อน {vendorRows.reduce((n, r) => n + Number(r.discrepancy_count), 0)} ครั้ง</p><div className="flex flex-wrap gap-2"><Link className="button secondary" href={`/reorder?warehouse=${code}`}>ROP / Suggested Order</Link><Link className="button secondary" href={`/reports/monthly?warehouse=${code}`}>รายงานรายเดือน</Link></div></section></div>
    <section className="surface p-5"><h2 className="font-bold text-lg mb-3">ความเคลื่อนไหวล่าสุด</h2><div className="grid gap-2">{recent.map(row => <p className="border border-[var(--line)] rounded-lg p-3 text-sm" key={row.id}><strong>{label(movementKindLabels, row.kind)}</strong>{row.purpose ? ` · ${row.purpose}` : ''} · {formatDateTime(row.created_at)}</p>)}{recent.length === 0 && <p className="muted">ยังไม่มีธุรกรรมสต็อก</p>}</div>{recent.length > 0 && <Link className="button secondary mt-3" href={`/movements?warehouse=${code}`}>ดูประวัติทั้งหมด</Link>}</section>
    <div className="flex flex-wrap gap-2"><Link className="button" href={`/scan?warehouse=${code}`}>สแกน</Link><Link className="button" href={`/receive?warehouse=${code}`}>รับเข้า</Link><Link className="button secondary" href={`/stock?warehouse=${code}`}>ดูสต็อก</Link></div>
  </main>;
}
