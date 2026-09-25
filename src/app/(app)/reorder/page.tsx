import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { saveReorderSettings } from '@/app/actions/control';
import { stockStatus } from '@/lib/inventory-insights';
import { logUserMessage } from '@/lib/messages';
import { label, stockStatusLabels } from '@/lib/labels';
import { SubmitButton } from '@/components/submit-button';
import { unitLabel } from '@/lib/units';

const PAGE_SIZE = 50;
type Product = { id: string; product_code: string; display_name: string; base_stock_unit: string };
type Status = { product_id: string; mode: string | null; manual_rop_packs: number | null; lead_time_days: number | null; safety_stock: number | null; target_coverage_days: number | null; order_pack_quantity: number | null; usable_stock: number; average_daily_issue: number | null; rop: number | null; suggested_order: number | null; missing_reason: string | null };

export default async function ReorderPage({ searchParams }: { searchParams: Promise<{warehouse?:string;q?:string;page?:string;error?:string;saved?:string}> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access,params.warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const page = Math.min(100,Math.max(1,Number.parseInt(params.page??'1',10)||1));
  const from = (page-1)*PAGE_SIZE;
  const q = (params.q ?? '').trim().slice(0,80).replace(/[(),.%]/g,'');
  let query = client.from('ci_products').select('id,product_code,display_name,base_stock_unit').eq('warehouse_id',warehouse.id).eq('active',true).order('product_code').range(from,from+PAGE_SIZE);
  if (q) query = query.or(`product_code.ilike.%${q}%,display_name.ilike.%${q}%`);
  const {data: productData,error:productError} = await query;
  const rows = (productData ?? []) as Product[];
  const hasNext = rows.length>PAGE_SIZE;
  const products = rows.slice(0,PAGE_SIZE);
  const {data: statusData,error:statusError} = products.length ? await client.from('ci_reorder_status').select('*').in('product_id',products.map(p=>p.id)) : {data:[],error:null};
  const status = new Map(((statusData ?? []) as Status[]).map(s=>[s.product_id,s]));
  const pageHref = (n:number)=>`/reorder?${new URLSearchParams({warehouse:warehouse.code,q,page:String(n)})}`;
  const canEdit = access.warehouses.some(w=>w.id===warehouse.id && canSupervise(w.role));
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Inventory control</p><h1 className="page-title">ROP และ Suggested Order</h1><p className="muted text-sm">การคำนวณอัตโนมัติใช้ยอดเบิกสุทธิ 90 วัน · ไม่หักยอด PO ที่ยังไม่รับ</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/reorder"/>
    <form method="get" className="surface p-4 flex gap-3 items-end"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field flex-1">ค้นหาสินค้า<input className="input" name="q" defaultValue={params.q ?? ''}/></label><button className="button">ค้นหา</button></form>
    {params.error && <p role="alert" className="error">{params.error}</p>}{params.saved && <p role="status" className="notice">บันทึกการตั้งค่าสำเร็จ</p>}{(productError||statusError) && <p role="alert" className="error">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('reorder', productError||statusError)}</p>}
    <div className="grid lg:grid-cols-2 gap-4">{products.map(p=>{const s=status.get(p.id); const unit=unitLabel(p.base_stock_unit); const withUnit=(v:number|string|null|undefined)=>v==null?'ต้องตั้งค่า':`${v} ${unit}`; const state=stockStatus(Number(s?.usable_stock??0),s?.rop==null?null:Number(s.rop));return <section className="surface p-5 grid gap-3" key={p.id}><div><Link href={`/products/${p.id}`} className="font-bold text-brand">{p.product_code} · {p.display_name}</Link><p className="muted text-sm">ใช้ได้ {s?.usable_stock ?? 0} {unit} · {label(stockStatusLabels,state)} · ROP {withUnit(s?.rop)} · แนะนำสั่ง {withUnit(s?.suggested_order)}</p>{s?.missing_reason && <p className="text-sm text-amber-800">{s.missing_reason}</p>}</div>{canEdit && <form action={saveReorderSettings} className="grid grid-cols-2 gap-3"><input type="hidden" name="product_id" value={p.id}/><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field col-span-2">โหมด<select name="mode" className="input" defaultValue={s?.mode??'manual'}><option value="manual">Manual</option><option value="automatic">Automatic</option></select></label><label className="field">ROP ({unit})<input className="input" name="manual_rop_packs" type="number" inputMode="decimal" min="0" step="0.001" defaultValue={s?.manual_rop_packs??''}/></label><label className="field">ปริมาณสั่งต่อครั้ง ({unit})<input className="input" name="order_pack_quantity" type="number" inputMode="decimal" min="0.001" step="0.001" defaultValue={s?.order_pack_quantity??''}/></label><label className="field">ระยะเวลารอของ (วัน)<input className="input" name="lead_time_days" type="number" inputMode="numeric" min="0" step="1" defaultValue={s?.lead_time_days??''}/></label><label className="field">Safety stock ({unit})<input className="input" name="safety_stock" type="number" inputMode="decimal" min="0" step="0.001" defaultValue={s?.safety_stock??''}/></label><label className="field col-span-2">ต้องการให้พอใช้ (วัน)<input className="input" name="target_coverage_days" type="number" inputMode="numeric" min="1" step="1" defaultValue={s?.target_coverage_days??''}/></label><SubmitButton className="button col-span-2" label="บันทึกการตั้งค่า" pendingLabel="กำลังบันทึก…"/></form>}</section>;})}</div>{products.length===0 && !productError && <p className="surface p-5 muted">{q ? `ไม่พบสินค้าที่ตรงกับ "${q}" · ลองค้นด้วยรหัสสินค้าหรือชื่อบางส่วน` : 'ยังไม่มีสินค้าที่ใช้งานในคลังนี้'}</p>}{(page>1||hasNext) && <nav aria-label="หน้าผลการค้นหา" className="flex items-center gap-3">{page>1 && <Link className="button secondary" href={pageHref(page-1)}>ก่อนหน้า</Link>}<span className="muted text-sm">{products.length ? `หน้า ${page} · รายการที่ ${from+1}–${from+products.length}` : `ไม่มีรายการในหน้า ${page}`}</span>{hasNext && <Link className="button secondary" href={pageHref(page+1)}>ถัดไป</Link>}</nav>}
  </main>;
}
