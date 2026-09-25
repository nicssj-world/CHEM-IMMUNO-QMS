import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { addDays, bangkokToday, expiryBucket, reorderAttention } from '@/lib/inventory-insights';
import { formatDate, formatDateTime } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';
import { ISSUE_TYPE_LABELS } from '@/lib/vendor-issues';

type Reorder = { product_id: string; usable_stock: number; rop: number | null; missing_reason: string | null };
type Product = { id: string; product_code: string; display_name: string };
type Balance = { product_id: string; lot_number: string; expiry_date: string; location_id: string; balance: number };
type Location = { id: string; code: string };

const LIST_LIMIT = 200;
const buckets = ['EXPIRED', '≤30', '31–60', '61–90'] as const;
const bucketLabel: Record<string, string> = { EXPIRED: 'หมดอายุแล้ว', '≤30': 'หมดอายุใน 30 วัน', '31–60': 'หมดอายุใน 31–60 วัน', '61–90': 'หมดอายุใน 61–90 วัน' };

function Shown({ shown, total }: { shown: number; total: number }) {
  return total > shown ? <p className="muted text-sm">แสดง {shown} จาก {total} รายการ · ใช้หน้าคงคลังหรือรายงานเพื่อดูทั้งหมด</p> : null;
}
function Empty({ children }: { children: React.ReactNode }) { return <p className="muted text-sm">{children}</p>; }

export default async function AttentionPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; type?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">รายการที่ต้องติดตาม</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const filter = params.type;
  const today = bangkokToday();
  const range: Record<string, [string | null, string]> = { EXPIRED: [null, addDays(today, -1)], '≤30': [today, addDays(today, 30)], '31–60': [addDays(today, 31), addDays(today, 60)], '61–90': [addDays(today, 61), addDays(today, 90)] };
  const positive = () => client.from('ci_stock_balances').select('lot_id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).gt('balance', 0);
  const bucketCount = (bucket: string) => { const [from, to] = range[bucket]; const q = positive().lte('expiry_date', to); return from ? q.gte('expiry_date', from) : q; };
  // The list follows the selected bucket (or everything up to 90 days) and is capped; the cards above always show exact totals.
  const [listFrom, listTo] = filter && range[filter] ? range[filter] : [null, addDays(today, 90)];
  let balanceList = client.from('ci_stock_balances').select('product_id,lot_number,expiry_date,location_id,balance', { count: 'exact' }).eq('warehouse_id', warehouse.id).gt('balance', 0).lte('expiry_date', listTo);
  if (listFrom) balanceList = balanceList.gte('expiry_date', listFrom);
  const [productResult, reorderResult, balanceResult, locationResult, mappingResult, assessmentResult, vendorIssueResult, ...bucketResults] = await Promise.all([
    client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id', warehouse.id).eq('active', true).limit(2000),
    client.from('ci_reorder_status').select('product_id,usable_stock,rop,missing_reason').eq('warehouse_id', warehouse.id).limit(2000),
    balanceList.order('expiry_date').limit(LIST_LIMIT),
    client.from('ci_locations').select('id,code').eq('warehouse_id', warehouse.id),
    client.from('ci_identifier_mapping_requests').select('id,product_id,identifier_kind,identifier_value,proposed_at', { count: 'exact' }).eq('warehouse_id', warehouse.id).eq('status', 'proposed').order('proposed_at', { ascending: false }).limit(LIST_LIMIT),
    client.from('ci_receipt_assessments').select('id,assessed_at,notes', { count: 'exact' }).eq('warehouse_id', warehouse.id).eq('delivery_discrepancy', true).order('assessed_at', { ascending: false }).limit(LIST_LIMIT),
    client.from('ci_vendor_issues').select('id,description,created_at,vendor_id,issue_type', { count: 'exact' }).eq('warehouse_id', warehouse.id).eq('status', 'open').order('created_at', { ascending: false }).limit(LIST_LIMIT),
    ...buckets.map(bucketCount),
  ]);
  const failed = [productResult, reorderResult, balanceResult, locationResult, mappingResult, assessmentResult, vendorIssueResult, ...bucketResults].find(r => r.error)?.error;
  if (failed) return <main className="grid gap-4"><h1 className="page-title">รายการที่ต้องติดตาม</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('attention', failed)}</p></main>;
  const products = new Map(((productResult.data ?? []) as Product[]).map(p => [p.id, p]));
  const locations = new Map(((locationResult.data ?? []) as Location[]).map(l => [l.id, l]));
  // Same rule as the dashboard: only active products, and "no ROP" is a setup task rather than a stockout.
  const reorders = ((reorderResult.data ?? []) as Reorder[]).filter(r => products.has(r.product_id)).map(row => ({ ...row, status: reorderAttention(Number(row.usable_stock), row.rop === null ? null : Number(row.rop)) }));
  const balances = ((balanceResult.data ?? []) as Balance[]).map(row => ({ ...row, bucket: expiryBucket(row.expiry_date, today) }));
  const mapping = mappingResult.data ?? [];
  const assessments = assessmentResult.data ?? [];
  const vendorIssues = vendorIssueResult.data ?? [];
  const bucketTotals = Object.fromEntries(buckets.map((b, i) => [b, bucketResults[i].count ?? 0]));
  const counts = [
    { type: 'stockout', label: 'หมดสต็อก', count: reorders.filter(r => r.status === 'stockout').length, tone: 'alert' },
    { type: 'below', label: 'ต่ำกว่า ROP', count: reorders.filter(r => r.status === 'below').length, tone: 'warn' },
    ...buckets.map(type => ({ type, label: bucketLabel[type], count: bucketTotals[type], tone: type === 'EXPIRED' ? 'alert' : type === '≤30' ? 'warn' : 'neutral' })),
    { type: 'mapping', label: 'Barcode รออนุมัติ', count: mappingResult.count ?? 0, tone: 'warn' },
    { type: 'discrepancy', label: 'ผลตรวจรับคลาดเคลื่อน', count: assessmentResult.count ?? 0, tone: 'neutral' },
    { type: 'vendor', label: 'ปัญหาผู้ขายที่เปิดอยู่', count: vendorIssueResult.count ?? 0, tone: 'warn' },
  ];
  const stockRows = reorders.filter(r => r.status === 'stockout' || r.status === 'below').filter(r => !filter || (filter === 'stockout' && r.status === 'stockout') || (filter === 'below' && r.status === 'below'));
  const noRop = reorders.filter(r => r.status === 'no-rop').length;
  const code = warehouse.code;
  const productName = (id: string) => { const p = products.get(id); return p ? `${p.product_code} · ${p.display_name}` : 'สินค้าที่ปิดใช้งาน'; };
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Attention Center</p><h1 className="page-title">รายการที่ต้องติดตาม</h1><p className="muted mt-2 text-sm">อิงยอด LOT/ตำแหน่ง และสิทธิ์ของคลังที่เลือก</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/attention"/>
    <nav aria-label="ประเภทรายการ" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">{counts.map(item => <Link className="kpi surface p-4 no-underline text-[var(--ink)]" data-tone={item.count > 0 ? item.tone : 'neutral'} aria-current={filter === item.type ? 'true' : undefined} href={`/attention?warehouse=${code}&type=${encodeURIComponent(item.type)}`} key={item.type}><p className="muted text-xs">{item.label}</p><strong className="text-2xl tabular-nums">{item.count}</strong></Link>)}</nav>
    {filter && <div><Link className="button secondary" href={`/attention?warehouse=${code}`}>แสดงทุกประเภท</Link></div>}
    {(!filter || filter === 'stockout' || filter === 'below') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">สต็อก / ROP</h2>{stockRows.map(row => <Link key={row.product_id} href={`/products/${row.product_id}?warehouse=${code}`} className="border border-[var(--line)] rounded-lg p-3 no-underline text-[var(--ink)]"><strong>{productName(row.product_id)}</strong><p className="muted text-sm">{row.status === 'stockout' ? 'หมดสต็อก' : 'ต่ำกว่า ROP'} · ใช้ได้ {Number(row.usable_stock)} · ROP {row.rop}</p></Link>)}{stockRows.length === 0 && <Empty>ไม่มีสินค้าหมดสต็อกหรือต่ำกว่า ROP</Empty>}{noRop > 0 && <p className="muted text-sm">ยังไม่ตั้ง ROP อีก {noRop} รายการ · ระบบจึงยังเตือนสินค้าเหล่านี้ไม่ได้</p>}<Link href={`/reorder?warehouse=${code}`} className="button secondary">ตั้งค่า ROP</Link></section>}
    {(!filter || (buckets as readonly string[]).includes(filter)) && <section className="surface p-5 grid gap-2"><h2 className="font-bold">{filter ? bucketLabel[filter] : 'LOT หมดอายุหรือใกล้หมดอายุ (ภายใน 90 วัน)'}</h2>{balances.map((row, i) => <Link href={`/products/${row.product_id}?warehouse=${code}`} className="border border-[var(--line)] rounded-lg p-3 no-underline text-[var(--ink)]" key={`${row.product_id}:${row.lot_number}:${row.location_id}:${i}`}><strong>{productName(row.product_id)}</strong><p className="muted text-sm">LOT {row.lot_number} · หมดอายุ {row.expiry_date} ({bucketLabel[row.bucket] ?? row.bucket}) · ตำแหน่ง {locations.get(row.location_id)?.code ?? '—'} · คงเหลือ {Number(row.balance)}</p></Link>)}{balances.length === 0 && <Empty>ไม่มี LOT ในช่วงนี้</Empty>}<Shown shown={balances.length} total={balanceResult.count ?? 0}/>{bucketTotals.EXPIRED > 0 && <Link className="button secondary" href={`/dispose?warehouse=${code}`}>กำจัดสินค้าหมดอายุ</Link>}</section>}
    {(!filter || filter === 'mapping') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">Barcode รออนุมัติ</h2>{mapping.map(row => <p className="border border-[var(--line)] rounded-lg p-3 text-sm" key={row.id}><strong>{products.get(row.product_id)?.product_code ?? '—'}</strong> · {row.identifier_kind} <span className="font-mono break-all">{row.identifier_value}</span> · เสนอเมื่อ {formatDateTime(row.proposed_at)}</p>)}{mapping.length === 0 && <Empty>ไม่มีคำขอรออนุมัติ</Empty>}<Shown shown={mapping.length} total={mappingResult.count ?? 0}/><Link className="button secondary" href={`/scan/review?warehouse=${code}`}>เปิดคิวพิจารณา</Link></section>}
    {(!filter || filter === 'discrepancy') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">ผลตรวจรับคลาดเคลื่อน</h2>{assessments.map(row => <p className="border border-[var(--line)] rounded-lg p-3 text-sm" key={row.id}>ตรวจรับเมื่อ {formatDateTime(row.assessed_at)}{row.notes ? ` · ${row.notes}` : ''}</p>)}{assessments.length === 0 && <Empty>ไม่มีผลตรวจรับที่คลาดเคลื่อน</Empty>}<Shown shown={assessments.length} total={assessmentResult.count ?? 0}/></section>}
    {(!filter || filter === 'vendor') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">ปัญหาผู้ขายที่เปิดอยู่</h2>{vendorIssues.map(row => <Link className="border border-[var(--line)] rounded-lg p-3 text-sm no-underline" key={row.id} href={`/vendors/${row.vendor_id}?warehouse=${code}#vendor-issues`}><strong>{ISSUE_TYPE_LABELS[row.issue_type as string] ?? row.issue_type}</strong> · {row.description} · {formatDate(row.created_at)}</Link>)}{vendorIssues.length === 0 && <Empty>ไม่มีปัญหาผู้ขายที่เปิดอยู่</Empty>}<Shown shown={vendorIssues.length} total={vendorIssueResult.count ?? 0}/><Link className="button secondary" href={`/vendors?warehouse=${code}`}>ผู้ขาย</Link></section>}
  </main>;
}
