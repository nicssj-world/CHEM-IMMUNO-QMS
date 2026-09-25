import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { PrintButton } from '@/components/print-button';
import { bangkokToday, expiryBucket, fiscalYear, stockStatus } from '@/lib/inventory-insights';
import { reconcileMonthlyRows, reportMonth, type MonthlyRow } from '@/lib/monthly-report';
import { logUserMessage } from '@/lib/messages';
import { formatDateTime, formatMonth } from '@/lib/format';
const reportColumnLabels = { opening: 'ยอดยกมา', received: 'รับเข้า', issued: 'เบิกใช้', adjustments: 'ปรับยอด', expired_disposal: 'กำจัดหมดอายุ', reversals: 'ย้อนรายการ', closing: 'ยอดคงเหลือ' } as const;

export default async function MonthlyReportPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; month?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access,params.warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  let month: string;
  try { month = reportMonth(params.month,bangkokToday()); } catch { return <p className="error" role="alert">เดือนรายงานไม่ถูกต้อง</p>; }
  const [report, reorder, expiry, vendors, locations, productCount] = await Promise.all([
    client.rpc('ci_monthly_inventory_report',{p_warehouse_id:warehouse.id,p_month:`${month}-01`}),
    client.from('ci_reorder_status').select('product_id,usable_stock,rop,suggested_order').eq('warehouse_id',warehouse.id).limit(500),
    client.from('ci_stock_balances').select('product_id,lot_number,expiry_date,location_id,balance',{count:'exact'}).eq('warehouse_id',warehouse.id).gt('balance',0).order('expiry_date').limit(1000),
    client.from('ci_vendor_metrics').select('receipt_count,assessed_count,discrepancy_count,issue_count').eq('warehouse_id',warehouse.id).eq('fiscal_year',fiscalYear(`${month}-01`)).limit(100),
    client.from('ci_locations').select('id,code').eq('warehouse_id',warehouse.id).limit(200),
    client.from('ci_products').select('id',{count:'exact',head:true}).eq('warehouse_id',warehouse.id),
  ]);
  const error = report.error??reorder.error??expiry.error??vendors.error??locations.error??productCount.error;
  if (error) return <p className="error" role="alert">อ่านรายงานไม่สำเร็จ: {logUserMessage('monthly-report', error)}</p>;
  const rows = (report.data??[]) as MonthlyRow[];
  if (rows.length!==(productCount.count??0) || (productCount.count??0)>500 || (expiry.count??0)>1000) return <p className="error" role="alert">ข้อมูลรายงานเกินขอบเขตการแสดงผล · ไม่แสดงยอดรวมที่อาจไม่ครบ</p>;
  const {totals,invalidProductCodes} = reconcileMonthlyRows(rows);
  const reorders = (reorder.data??[]).filter(r=>['stockout','below ROP'].includes(stockStatus(Number(r.usable_stock),r.rop==null?null:Number(r.rop))));
  const expiring = (expiry.data??[]).filter(r=>expiryBucket(r.expiry_date)!=='>90');
  const vendor = vendors.data??[];
  const productMap = new Map(rows.map(row=>[row.product_id,row]));
  const locationMap = new Map((locations.data??[]).map(row=>[row.id,row.code]));
  const fmt=(n:number|string)=>Number(n).toLocaleString('th-TH',{maximumFractionDigits:3});
  return <main className="grid gap-6 report-page"><div className="print-hide"><Link href="/">← ภาพรวมคลัง</Link></div><header className="flex flex-wrap justify-between items-end gap-4"><div><p className="eyebrow">Monthly inventory</p><h1 className="page-title">รายงานคงคลังรายเดือน</h1><p className="muted">{warehouse.name} · {formatMonth(month)} · เวลา Asia/Bangkok</p><p className="print-only text-xs">พิมพ์โดย {access.displayName} ({access.ephisId}) · {formatDateTime(new Date())}</p></div><PrintButton/></header>
    <div className="print-hide"><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/reports/monthly"/><form method="get" className="surface p-4 flex flex-wrap gap-3 items-end mt-3"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field">เดือนรายงาน<input className="input" type="month" name="month" defaultValue={month} required/></label><button className="button">แสดงรายงาน</button></form></div>
    {invalidProductCodes.length>0 && <p className="error" role="alert">ยอดรายงานไม่สมดุลสำหรับ {invalidProductCodes.join(', ')} · หยุดใช้รายงานนี้เพื่อตรวจสอบ ledger</p>}
    <section className="surface p-5"><h2 className="font-bold text-lg mb-3">สมการคงคลัง</h2><p className="text-sm">Opening + Received − Issued ± Adjustments − Expired Disposal ± Reversals = Closing</p><div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">{(['opening','received','issued','adjustments','expired_disposal','reversals','closing'] as const).map(key=><div key={key} className="border rounded-lg p-3"><p className="muted text-xs">{reportColumnLabels[key]}</p><strong>{fmt(totals[key])}</strong></div>)}</div></section>
    <section className="surface p-5"><h2 className="font-bold text-lg mb-3">รายการสินค้า ({rows.length})</h2><div className="table-wrap desktop-table"><table className="data-table report-table"><thead><tr>{['Product','Opening','Received','Issued','Adjustments','Expired','Reversals','Closing'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.product_id}><td>{row.product_code} · {row.display_name}</td>{(['opening','received','issued','adjustments','expired_disposal','reversals','closing'] as const).map(key=><td key={key}>{fmt(row[key])}</td>)}</tr>)}</tbody></table></div><div className="mobile-card-list">{rows.map(row=><article key={row.product_id} className="border rounded-lg p-3"><strong>{row.product_code} · {row.display_name}</strong><p className="text-sm muted mt-1">เปิด {fmt(row.opening)} + รับ {fmt(row.received)} − เบิก {fmt(row.issued)} ± ปรับ {fmt(row.adjustments)} − หมดอายุ {fmt(row.expired_disposal)} ± คืน {fmt(row.reversals)} = <strong>{fmt(row.closing)}</strong></p></article>)}</div></section>
    <div className="grid md:grid-cols-2 gap-4"><section className="surface p-5"><h2 className="font-bold mb-2">Reorder / Low Stock</h2><p>{reorders.length} รายการต่ำกว่าเกณฑ์หรือ stockout</p><div className="grid gap-1 mt-3 text-sm">{reorders.map(r=><p key={r.product_id} className="border-b py-1">{productMap.get(r.product_id)?.product_code??'—'} · ใช้ได้ {fmt(r.usable_stock)} · ROP {r.rop==null?'ต้องตั้งค่า':fmt(r.rop)} · สั่ง {r.suggested_order==null?'ต้องตั้งค่า':fmt(r.suggested_order)}</p>)}</div>{reorders.length>20 && <p className="muted text-xs">แสดง 20 รายการแรกจาก {reorders.length}</p>}<p className="muted text-sm mt-2">Suggested Order เป็นข้อมูลปัจจุบัน ณ เวลาดูรายงาน</p></section><section className="surface p-5"><h2 className="font-bold mb-2">LOT Expiry</h2><p>{expiring.length} LOT/location หมดอายุหรือจะหมดอายุใน 90 วัน</p><div className="grid gap-1 mt-3 text-sm">{expiring.map((r,i)=><p key={`${r.product_id}:${r.lot_number}:${r.location_id}:${i}`} className="border-b py-1">{productMap.get(r.product_id)?.product_code??'—'} · LOT {r.lot_number} · {r.expiry_date} · {locationMap.get(r.location_id)??'—'} · {fmt(r.balance)}</p>)}</div>{expiring.length>20 && <p className="muted text-xs">แสดง 20 รายการแรกจาก {expiring.length}</p>}<p className="muted text-sm mt-2">สถานะตามวันที่กรุงเทพฯ ณ เวลาดูรายงาน</p></section></div>
    <section className="surface p-5"><h2 className="font-bold mb-2">Vendor / Receiving evidence</h2><p>รับเข้า {vendor.reduce((n,r)=>n+Number(r.receipt_count),0)} · ตรวจรับ {vendor.reduce((n,r)=>n+Number(r.assessed_count),0)} · คลาดเคลื่อน {vendor.reduce((n,r)=>n+Number(r.discrepancy_count),0)} · issue {vendor.reduce((n,r)=>n+Number(r.issue_count),0)}</p><p className="muted text-sm">ตัวเลขส่วนนี้เป็นข้อมูลสะสมปีงบประมาณ {fiscalYear(`${month}-01`)} ไม่ใช่คะแนนผู้ขาย</p></section>
    <p className="muted text-xs">แหล่งยอด: signed stock ledger · รายงานเปิดและปิดตามเดือน Asia/Bangkok · พิมพ์จากเบราว์เซอร์เป็น A4 PDF ได้</p>
  </main>;
}
