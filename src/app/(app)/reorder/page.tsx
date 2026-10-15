import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { LiveSearchForm } from '@/components/live-search-form';
import { saveReorderSettings } from '@/app/actions/control';
import { stockStatus, type StockRequirement } from '@/lib/inventory-insights';
import { logUserMessage } from '@/lib/messages';
import { label, stockStatusLabels, stockRequirementLabels } from '@/lib/labels';
import { SubmitButton } from '@/components/submit-button';
import { unitLabel } from '@/lib/units';
import { IntegerQuantityInput } from '@/components/integer-quantity-input';

const PAGE_SIZE = 50;
type Product = { id: string; warehouse_id: number; product_code: string; display_name: string; base_stock_unit: string; stock_requirement: StockRequirement };
type Status = { product_id: string; mode: string | null; manual_rop_packs: number | null; lead_time_days: number | null; safety_stock: number | null; target_coverage_days: number | null; order_pack_quantity: number | null; usable_stock: number; average_daily_issue: number | null; rop: number | null; suggested_order: number | null; missing_reason: string | null };

export default async function ReorderPage({ searchParams }: { searchParams: Promise<{q?:string;requirement?:string;page?:string;error?:string;saved?:string}> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const scopeIds = access.warehouses.map(w => Number(w.id));
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const page = Math.min(100,Math.max(1,Number.parseInt(params.page ?? '1',10)||1));
  const from = (page-1)*PAGE_SIZE;
  const q = (params.q ?? '').trim().slice(0,80).replace(/[(),.%]/g,'');
  const requirement = (['unclassified','required','on_demand'] as string[]).includes(params.requirement ?? '') ? params.requirement! : '';
  let query = client.from('ci_products')
    .select('id,warehouse_id,product_code,display_name,base_stock_unit,stock_requirement')
    .in('warehouse_id',scopeIds).eq('active',true).order('product_code').range(from,from+PAGE_SIZE);
  if (q) query = query.or('product_code.ilike.%'+q+'%,display_name.ilike.%'+q+'%');
  if (requirement) query = query.eq('stock_requirement',requirement);
  const {data:productData,error:productError} = await query;
  const rows = (productData ?? []) as Product[];
  const hasNext = rows.length>PAGE_SIZE;
  const products = rows.slice(0,PAGE_SIZE);
  const {data:statusData,error:statusError} = products.length
    ? await client.from('ci_reorder_status').select('*').in('product_id',products.map(p=>p.id))
    : {data:[],error:null};
  const status = new Map(((statusData ?? []) as Status[]).map(s=>[s.product_id,s]));
  const queryParams = new URLSearchParams({q,requirement});
  const pageHref = (n:number) => '/reorder?'+queryParams+'&page='+n;

  return <main className="grid gap-5 min-w-0">
    <header className="grid gap-2">
      <p className="eyebrow">Inventory control · P0</p>
      <h1 className="page-title">ประเภทการสำรองน้ำยาและ ROP</h1>
      <p className="muted text-sm">กำหนดก่อนว่าน้ำยาใดต้องสำรองประจำ · รายการตามความต้องการจะไม่ถูกนับเป็น Stockout / ต่ำกว่า ROP</p>
      <p className="muted text-sm">Manual ROP คือจำนวนสต็อกขั้นต่ำโดยตรง (ไม่คูณจำนวนสั่งซื้อ) · Automatic ROP ต้องมีประวัติการเบิกอย่างน้อย 90 วัน</p>
    </header>
    <LiveSearchForm ariaLabel="ค้นหาและกรองประเภทการสำรองน้ำยา" className="surface p-4 grid sm:grid-cols-[minmax(0,1fr)_200px] gap-3 items-end">
      <label className="field">ค้นหาน้ำยา
        <input className="input" type="search" name="q" maxLength={80} defaultValue={params.q ?? ''} placeholder="ชื่อหรือรหัสน้ำยา"/>
      </label>
      <label className="field">ประเภทการสำรอง
        <select className="input" name="requirement" defaultValue={requirement}>
          <option value="">ทั้งหมด</option>
          <option value="unclassified">ยังไม่จัดประเภท</option>
          <option value="required">ต้องสำรองประจำ</option>
          <option value="on_demand">ใช้ตามความต้องการ</option>
        </select>
      </label>
    </LiveSearchForm>
    {params.error && <p role="alert" className="error">{params.error}</p>}
    {params.saved && <p role="status" className="notice">บันทึกประเภทการสำรองและการตั้งค่า ROP แล้ว</p>}
    {(productError||statusError) && <p role="alert" className="error">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('reorder',productError||statusError)}</p>}
    {!productError && !statusError && <div className="grid lg:grid-cols-2 gap-4">
      {products.map(p=>{
        const s=status.get(p.id);
        const unit=unitLabel(p.base_stock_unit);
        const state=stockStatus(Number(s?.usable_stock??0),s?.rop==null?null:Number(s.rop),p.stock_requirement);
        const canEdit=access.warehouses.some(w => Number(w.id)===p.warehouse_id && canSupervise(w.role));
        const configured=p.stock_requirement==='required';
        return <section className="surface p-4 sm:p-5 grid gap-3 min-w-0" key={p.id}>
          <header className="grid gap-2">
            <Link href={'/products/'+p.id} className="font-bold text-brand break-words">{p.product_code} · {p.display_name}</Link>
            <p className="text-sm"><strong>{label(stockRequirementLabels,p.stock_requirement)}</strong> · {label(stockStatusLabels,state)}</p>
            <p className="muted text-sm">
              คงเหลือพร้อมใช้ {Number(s?.usable_stock??0).toLocaleString('th-TH')} {unit}
              {configured ? ' · ROP '+(s?.rop==null?'ยังไม่กำหนด':Number(s.rop).toLocaleString('th-TH')+' '+unit) : ''}
            </p>
            {configured && s?.suggested_order!=null && <p className="muted text-sm">แนะนำสั่ง {Number(s.suggested_order).toLocaleString('th-TH')} {unit}</p>}
            {configured && s?.missing_reason && <p className="text-sm text-amber-800">{s.missing_reason}</p>}
          </header>
          {canEdit && <form action={saveReorderSettings} className="grid grid-cols-2 gap-3">
            <input type="hidden" name="product_id" value={p.id}/>
            <input type="hidden" name="return_q" value={q}/>
            <input type="hidden" name="return_requirement" value={requirement}/>
            <input type="hidden" name="return_page" value={page}/>
            <label className="field col-span-2">ประเภทการสำรอง
              <select name="stock_requirement" className="input" defaultValue={p.stock_requirement}>
                <option value="unclassified">ยังไม่จัดประเภท</option>
                <option value="required">ต้องสำรองประจำ</option>
                <option value="on_demand">ใช้ตามความต้องการ</option>
              </select>
            </label>
            <p className="col-span-2 muted text-xs">เฉพาะ “ต้องสำรองประจำ” จึงมีการเตือน Stockout และ ROP · เลือกประเภทแล้วกดบันทึกได้ แม้ยังไม่มีค่า ROP</p>
            <label className="field col-span-2">วิธีกำหนด ROP
              <select name="mode" className="input" defaultValue={s?.mode??'manual'}>
                <option value="manual">Manual — กำหนดเกณฑ์เอง</option>
                <option value="automatic">Automatic — ตามการเบิกย้อนหลัง</option>
              </select>
            </label>
            <label className="field">ROP ขั้นต่ำ ({unit})
              <IntegerQuantityInput className="input" name="manual_rop_packs" min="0" defaultValue={s?.manual_rop_packs??''}/>
            </label>
            <label className="field">จำนวนสั่งต่อครั้ง ({unit})
              <IntegerQuantityInput className="input" name="order_pack_quantity" min="1" defaultValue={s?.order_pack_quantity??''}/>
            </label>
            <p className="col-span-2 muted text-xs">เช่น กำหนด ROP 5 {unit} จะเตือนเมื่อคงเหลือพร้อมใช้ 5 {unit} หรือน้อยกว่า · จำนวนสั่งต่อครั้งใช้กับ Suggested Order เท่านั้น</p>
            <label className="field">Lead Time (วัน)
              <input className="input" name="lead_time_days" type="number" inputMode="numeric" min="0" step="1" defaultValue={s?.lead_time_days??''}/>
            </label>
            <label className="field">Safety Stock ({unit})
              <IntegerQuantityInput className="input" name="safety_stock" min="0" defaultValue={s?.safety_stock??''}/>
            </label>
            <label className="field col-span-2">ต้องการให้พอใช้ (วัน)
              <input className="input" name="target_coverage_days" type="number" inputMode="numeric" min="1" step="1" defaultValue={s?.target_coverage_days??''}/>
            </label>
            <SubmitButton className="button col-span-2" label="บันทึกประเภทการสำรองและ ROP" pendingLabel="กำลังบันทึก…"/>
          </form>}
        </section>;
      })}
    </div>}
    {products.length===0 && !productError && <p className="surface p-5 muted">ไม่พบน้ำยาตามเงื่อนไข</p>}
    {(page>1||hasNext) && <nav aria-label="หน้าผลการค้นหา ROP" className="flex flex-wrap items-center gap-3">
      {page>1 && <Link className="button secondary" href={pageHref(page-1)}>← ก่อนหน้า</Link>}
      <span className="muted text-sm">หน้า {page} · รายการ {from+1}–{from+products.length}</span>
      {hasNext && <Link className="button secondary" href={pageHref(page+1)}>ถัดไป →</Link>}
    </nav>}
  </main>;
}
