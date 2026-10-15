import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { addDays, bangkokToday, fiscalYear, reorderAttention, type StockRequirement } from '@/lib/inventory-insights';
import { formatDate, formatDateTime } from '@/lib/format';
import { label, movementKindLabels } from '@/lib/labels';
import { logUserMessage } from '@/lib/messages';
import { loadMovementDetails, type MovementTransaction } from '@/lib/stock-history';
import { StockMovementCards } from '@/components/stock-movement-cards';

type Reorder = { product_id: string; usable_stock: number; rop: number | null; suggested_order: number | null };
type Product = { id: string; product_code: string; display_name: string; base_stock_unit: string; stock_requirement: StockRequirement };
type ExpiringRow = { product_id: string; lot_number: string; expiry_date: string; balance: number };
type Action = { title: string; detail: string; href: string };
type ActionGroup = { title: string; count: number; href: string; tone: Tone; items: Action[] };

type VendorMetric = { receipt_count: number; discrepancy_count: number };
type Tone = 'alert' | 'warn' | 'neutral';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const access = await requireAccess();
  void searchParams;
  const scopeIds = access.warehouses.map(item => Number(item.id));
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">ภาพรวมคลัง</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const today = bangkokToday();
  const weekAgo = `${addDays(today, -6)}T00:00:00+07:00`; // today plus the six days before it, in Bangkok
  // Counts come from head-only queries so they stay exact however many LOTs or products the warehouse holds.
  const positive = () => client.from('ci_stock_balances').select('lot_id', { count: 'exact', head: true }).in('warehouse_id', scopeIds).gt('balance', 0);
  const movementCount = (kind: string) => client.from('ci_stock_transactions').select('id', { count: 'exact', head: true }).in('warehouse_id', scopeIds).eq('kind', kind).gte('created_at', weekAgo);
  const [products, reorders, expired, expiring30, expiring90, stockedRows, lots, received7, issued7, movements, vendors, mapping, issues, expiringActions] = await Promise.all([
    client.from('ci_products').select('id,product_code,display_name,base_stock_unit,stock_requirement', { count: 'exact' }).in('warehouse_id', scopeIds).eq('active', true).limit(2000),
    client.from('ci_reorder_status').select('product_id,usable_stock,rop,suggested_order', { count: 'exact' }).in('warehouse_id', scopeIds).limit(2000),
    positive().lt('expiry_date', today),
    positive().gte('expiry_date', today).lte('expiry_date', addDays(today, 30)),
    positive().gte('expiry_date', today).lte('expiry_date', addDays(today, 90)),
    positive(),
    client.from('ci_stock_lots').select('id', { count: 'exact', head: true }).in('warehouse_id', scopeIds),
    movementCount('receive'),
    movementCount('issue'),
    client.from('ci_stock_transactions').select('id,warehouse_id,kind,created_at,purpose,reason,actor_id,source_transaction_id').in('warehouse_id', scopeIds).order('created_at', { ascending: false }).limit(8),
    client.from('ci_vendor_metrics').select('receipt_count,discrepancy_count', { count: 'exact' }).in('warehouse_id', scopeIds).eq('fiscal_year', fiscalYear(today)).limit(500),
    client.from('ci_identifier_mapping_requests').select('id', { count: 'exact', head: true }).in('warehouse_id', scopeIds).eq('status', 'proposed'),
    client.from('ci_vendor_issues').select('id', { count: 'exact', head: true }).in('warehouse_id', scopeIds).eq('status', 'open'),
    client.from('ci_stock_balances').select('product_id,lot_number,expiry_date,balance')
      .in('warehouse_id',scopeIds).gt('balance',0).lte('expiry_date',addDays(today,30))
      .order('expiry_date',{ascending:true}).limit(8),
  ]);
  const error = [products, reorders, expired, expiring30, expiring90, stockedRows, lots, received7, issued7, movements, vendors, mapping, issues, expiringActions].find(r => r.error)?.error;
  if (error) return <main className="grid gap-4"><h1 className="page-title">ภาพรวมคลัง</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('dashboard', error)}</p></main>;
  if ((products.count ?? 0) > (products.data?.length ?? 0) || (reorders.count ?? 0) > (reorders.data?.length ?? 0) || (vendors.count ?? 0) > (vendors.data?.length ?? 0)) return <main className="grid gap-4"><h1 className="page-title">ภาพรวมคลัง</h1><p className="error" role="alert">จำนวนข้อมูลเกินขอบเขตการแสดงผล Dashboard · ไม่แสดง KPI ที่อาจไม่ครบ กรุณาติดต่อผู้ดูแลระบบ</p></main>;
  const productRows = (products.data ?? []) as Product[];
  const productMap = new Map(productRows.map(product=>[product.id,product]));
  const activeIds = new Set(productRows.map(p => p.id));
  const reorderRows = ((reorders.data ?? []) as Reorder[]).filter(r => activeIds.has(r.product_id));
  const assessed = reorderRows.map(r => ({
    ...r, requirement: productMap.get(r.product_id)?.stock_requirement ?? 'unclassified',
    status: reorderAttention(Number(r.usable_stock),r.rop==null?null:Number(r.rop),productMap.get(r.product_id)?.stock_requirement??'unclassified')
  }));
  const stockoutRows=assessed.filter(r=>r.status==='stockout');
  const belowRows=assessed.filter(r=>r.status==='below');
  const noRopRows=assessed.filter(r=>r.requirement==='required' && r.rop===null);
  const unclassifiedRows=assessed.filter(r=>r.status==='unclassified');
  const stockout=stockoutRows.length;
  const below=belowRows.length;
  const noRop=noRopRows.length;
  const unclassified=unclassifiedRows.length;
  const vendorRows = (vendors.data ?? []) as VendorMetric[];
  const recent = (movements.data ?? []) as MovementTransaction[];
  const detailedRecent = await loadMovementDetails(client, recent, access).catch(() => null);
  const suggested = assessed.filter(r => r.requirement==='required' && Number(r.suggested_order)>0).length;
  const productLabel = (id:string) => {
    const p=productMap.get(id);return p ? p.product_code+' · '+p.display_name : 'ไม่พบชื่อน้ำยา';
  };
  const productHref = (id:string) => '/products/'+encodeURIComponent(id)+'?tab=lots';
  const stockActions:Action[] = [...stockoutRows.map(r=>({
    title: productLabel(r.product_id),
    detail: 'หมดสต็อก · คงเหลือพร้อมใช้ 0',
    href: productHref(r.product_id)
  })),...belowRows.map(r=>({
    title: productLabel(r.product_id),
    detail: 'ถึง/ต่ำกว่า ROP · ใช้ได้ '+Number(r.usable_stock)+' / เกณฑ์ '+Number(r.rop),
    href: productHref(r.product_id)
  }))];
  const expiryActions:Action[] = ((expiringActions.data??[]) as ExpiringRow[])
    .filter(row=>productMap.has(row.product_id))
    .map(row=>({
      title: productLabel(row.product_id),
      detail: 'LOT '+row.lot_number+' · EXP '+row.expiry_date+' · คงเหลือ '+Number(row.balance),
      href: productHref(row.product_id)
    }));
  const setupActions:Action[] = [
    ...noRopRows.map(r=>({
      title: productLabel(r.product_id),
      detail: 'ต้องสำรองประจำ แต่ยังไม่ตั้ง ROP',
      href: '/reorder?requirement=required&q='+encodeURIComponent(productMap.get(r.product_id)?.product_code??'')
    })),
    ...unclassifiedRows.map(r=>({
      title: productLabel(r.product_id),
      detail: 'ยังไม่กำหนดว่าต้องสำรองประจำหรือใช้ตามความต้องการ',
      href: '/reorder?requirement=unclassified&q='+encodeURIComponent(productMap.get(r.product_id)?.product_code??'')
    })),
  ];
  const actionGroups:ActionGroup[]=[
    {title:'น้ำยาที่ต้องเติมสต็อก',count:stockout+below,href:'/attention',tone:'alert',items:stockActions.slice(0,4)},
    {title:'LOT ที่ต้องตรวจสอบวันหมดอายุ',count:(expired.count??0)+(expiring30.count??0),href:'/attention',tone:'warn',items:expiryActions.slice(0,4)},
    {title:'งานตั้งค่าคลัง',count:noRop+unclassified,href:'/reorder',tone:'neutral',items:setupActions.slice(0,4)},
  ];
  const cards: { label: string; count: number | string; href: string; tone: Tone; hint?: string }[] = [
    { label: 'น้ำยาที่ใช้งาน', count: products.count ?? '—', href: '/products', tone: 'neutral' },
    { label: 'หมดสต็อก', count: stockout, href: '/attention?type=stockout', tone: 'alert', hint: 'เฉพาะน้ำยาที่กำหนดว่าต้องสำรองประจำ' },
    { label: 'ต่ำกว่า ROP', count: below, href: '/attention?type=below', tone: 'warn', hint: 'รวมยอดเท่าจุดสั่งซื้อ' },
    { label: 'LOT หมดอายุแล้ว', count: expired.count ?? 0, href: '/attention?type=EXPIRED', tone: 'alert', hint: 'ยังมียอดคงเหลือ' },
    { label: 'หมดอายุใน 30 วัน', count: expiring30.count ?? 0, href: '/attention?type=%E2%89%A430', tone: 'warn' },
    { label: 'หมดอายุใน 90 วัน', count: expiring90.count ?? 0, href: '/attention', tone: 'neutral' },
    { label: 'ยังไม่ตั้ง ROP', count: noRop, href: '/attention?type=no-rop', tone: 'neutral', hint: 'เฉพาะรายการต้องสำรองประจำ' },
    { label: 'ยังไม่จัดประเภท', count: unclassified, href: '/reorder?requirement=unclassified', tone: 'neutral' },
    { label: 'LOT ทั้งหมด', count: lots.count ?? '—', href: '/stock', tone: 'neutral' },
    { label: 'รับเข้า 7 วัน', count: received7.count ?? 0, href: '/movements', tone: 'neutral', hint: 'จำนวนครั้ง' },
    { label: 'เบิกใช้ 7 วัน', count: issued7.count ?? 0, href: '/movements', tone: 'neutral', hint: 'จำนวนครั้ง' },
  ];
  const empty = (stockedRows.count ?? 0) === 0;
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Warehouse dashboard</p><h1 className="page-title">ภาพรวมคลังน้ำยา CHEM-IMMUNO</h1><p className="muted mt-2 text-sm">ข้อมูล Stock รวมของคลังน้ำยา · {formatDate(today)}</p></div>
    {empty && <section className="notice grid gap-3"><p><strong>คลังนี้ยังไม่มีสต็อกคงเหลือ</strong> · เริ่มจากรับน้ำยาเข้าตาม Invoice แล้วตั้งค่า ROP ให้น้ำยาที่ใช้ประจำ</p><div className="flex flex-wrap gap-2"><Link className="button" href="/receive">รับน้ำยาเข้า</Link><Link className="button secondary" href="/reorder">ตั้งค่า ROP</Link></div></section>}
    <section className="surface p-4 sm:p-6 grid gap-4" aria-labelledby="action-tasks-heading">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h2 id="action-tasks-heading" className="text-xl font-extrabold">งานที่ต้องดำเนินการ</h2>
          <p className="muted text-sm mt-1">เรียงงานที่กระทบสต็อกจริงก่อน งานตั้งค่าแสดงแยกต่างหาก ไม่ถือว่าทุกน้ำยาที่ไม่มียอดเป็นของขาด</p>
        </div>
        <Link className="button secondary" href="/attention">รายการที่ต้องติดตามทั้งหมด</Link>
      </div>
      <div className="grid lg:grid-cols-3 gap-3">{actionGroups.map(group=>
        <section key={group.title} className="rounded-xl border border-line p-3 sm:p-4 grid content-start gap-3" data-tone={group.tone}>
          <h3 className="font-bold">{group.title} <span className="muted">({group.count})</span></h3>
          {group.items.length>0 ? <div className="grid gap-2">
            {group.items.map((item,i)=><Link key={item.href+':'+i} href={item.href}
              className="rounded-lg bg-surface-2 px-3 py-3 min-h-12 no-underline text-[var(--ink)]">
              <strong className="block text-sm break-words">{item.title}</strong>
              <span className="block muted text-xs mt-1">{item.detail}</span>
            </Link>)}
          </div> : <p className="muted text-sm">ไม่มีรายการที่ต้องดำเนินการในหมวดนี้</p>}
          {group.count>group.items.length && <Link href={group.href} className="text-sm font-semibold text-brand">ดูรายการเพิ่มเติม →</Link>}
        </section>)}</div>
    </section>
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">{cards.map(card => <Link key={card.label} href={card.href} className="kpi surface p-4 no-underline text-[var(--ink)]" data-tone={Number(card.count) > 0 ? card.tone : 'neutral'}><p className="muted text-sm">{card.label}</p><strong className="text-2xl mt-2 block tabular-nums">{card.count}</strong>{card.hint && <p className="muted text-xs mt-1">{card.hint}</p>}</Link>)}</div>
    <div className="grid lg:grid-cols-2 gap-4"><section className="surface p-5 grid gap-3"><h2 className="font-bold text-lg">งานที่ต้องติดตาม</h2><p>รายการที่ต้องจัดประเภท {unclassified} · ต้องตั้ง ROP {noRop}</p><p>Barcode รออนุมัติ {mapping.count ?? 0} · ปัญหาผู้ขายที่เปิดอยู่ {issues.count ?? 0}</p><Link className="button secondary" href="/attention">เปิดรายการที่ต้องติดตาม</Link></section><section className="surface p-5 grid gap-3"><h2 className="font-bold text-lg">การใช้และสั่งซื้อ</h2><p>น้ำยาแนะนำสั่ง {suggested} รายการ</p><p>ปีงบประมาณ {fiscalYear(today)}: รับเข้า {vendorRows.reduce((n, r) => n + Number(r.receipt_count), 0)} ครั้ง · พบความคลาดเคลื่อน {vendorRows.reduce((n, r) => n + Number(r.discrepancy_count), 0)} ครั้ง</p><div className="flex flex-wrap gap-2"><Link className="button secondary" href="/reorder">ROP / Suggested Order</Link><Link className="button secondary" href="/reports/monthly">รายงานรายเดือน</Link></div></section></div>
    <section className="surface p-5"><h2 className="font-bold text-lg mb-3">ความเคลื่อนไหวล่าสุด</h2>
      {detailedRecent ? <StockMovementCards rows={detailedRecent} compact/> : <p role="alert" className="error">อ่านรายละเอียดรายการเคลื่อนไหวไม่ครบ กรุณาเปิดประวัติทั้งหมดเพื่อตรวจสอบ</p>}
      {recent.length > 0 && <Link className="button secondary mt-3" href="/movements">ดูประวัติทั้งหมด</Link>}
    </section>
    <div className="flex flex-wrap gap-2"><Link className="button" href="/scan">สแกน</Link><Link className="button" href="/receive">รับเข้า</Link><Link className="button secondary" href="/stock">ดูสต็อก</Link></div>
  </main>;
}
