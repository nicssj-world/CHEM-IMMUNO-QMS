import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canMutate, canSupervise, type AccessContext } from '@/lib/auth';
import { setUnifiedCountLine, approveUnifiedCount } from '@/app/actions/inventory';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { IntegerQuantityInput } from '@/components/integer-quantity-input';
import { logUserMessage } from '@/lib/messages';
import { label, countStatusLabels } from '@/lib/labels';

export type UnifiedCountBatch = {
  id: string; created_at: string; note: string | null;
  che_count_id: string | null; imm_count_id: string | null;
};
type CountStatus = { id: string; warehouse_id: number; status: string };
type CountLine = {
  id: string; count_id: string; lot_id: string; warehouse_id: number;
  location_id: string; snapshot_quantity: number; physical_quantity: number | null;
  ci_stock_lots: { lot_number: string; product_id: string } | null;
  ci_locations: { code: string } | null;
};

export async function UnifiedCountDetail({ batch, access, client, query }: {
  batch: UnifiedCountBatch; access: AccessContext; client: SupabaseClient;
  query: { error?: string; saved?: string };
}) {
  const memberIds=[batch.che_count_id,batch.imm_count_id].filter((id):id is string=>Boolean(id));
  const [countResult,lineResult]=await Promise.all([
    client.from('ci_stock_counts').select('id,warehouse_id,status').in('id',memberIds),
    client.from('ci_stock_count_lines')
      .select('id,count_id,warehouse_id,lot_id,location_id,snapshot_quantity,physical_quantity,ci_stock_lots(lot_number,product_id),ci_locations(code)')
      .in('count_id',memberIds).order('id').limit(2000),
  ]);
  const counts=(countResult.data??[]) as CountStatus[];
  const rows=(lineResult.data??[]) as unknown as CountLine[];
  const productIds=[...new Set(rows.map(row=>row.ci_stock_lots?.product_id).filter((id):id is string=>Boolean(id)))];
  const productResult=productIds.length ? await client.from('ci_products').select('id,product_code,display_name').in('id',productIds).limit(2000) : {data:[],error:null};
  const products=new Map((productResult.data??[]).map(item=>[item.id,item]));
  const dataError=countResult.error??lineResult.error??productResult.error;
  const completeMembers=counts.length===memberIds.length;
  const allApproved=completeMembers && counts.every(count=>count.status==='approved');
  const allDraft=completeMembers && counts.every(count=>count.status==='draft');
  const allFilled=rows.length>0 && rows.every(row=>row.physical_quantity!==null);
  const canEdit=memberIds.length>0 && counts.every(count=>access.warehouses.some(w=>Number(w.id)===count.warehouse_id && canMutate(w.role)));
  const canApprove=memberIds.length>0 && counts.every(count=>access.warehouses.some(w=>Number(w.id)===count.warehouse_id && canSupervise(w.role)));
  const state=allApproved?'approved':counts.some(count=>count.status==='stale')?'stale':'draft';

  return <main className="grid gap-6 max-w-[1000px]">
    <div><Link href="/counts" className="muted text-sm">← รอบตรวจนับ</Link>
      <p className="eyebrow mt-5 mb-2">Unified physical count</p>
      <h1 className="page-title">รอบตรวจนับคลังน้ำยา</h1>
      <p className="muted mt-2 text-sm">{new Date(batch.created_at).toLocaleString('th-TH')} · {batch.note||'ไม่มีหมายเหตุ'}</p>
      <p className="mt-3"><span className="badge">{label(countStatusLabels,state)}</span></p>
    </div>
    {query.error && <p className="error" role="alert">{query.error}</p>}
    {query.saved && <p className="notice" role="status">บันทึกแล้ว</p>}
    {dataError && <p className="error" role="alert">อ่านรายการตรวจนับไม่สำเร็จ: {logUserMessage('unified-count',dataError)}</p>}
    {!completeMembers && <p className="error">ข้อมูลรอบตรวจนับไม่ครบ กรุณาติดต่อผู้ดูแลระบบ</p>}
    <div className="surface p-4 flex flex-wrap justify-between gap-3">
      <div><p className="muted text-sm">รายการ LOT × Location</p><strong className="text-xl tabular-nums">{rows.length}</strong></div>
      <div><p className="muted text-sm">บันทึกยอดจริงแล้ว</p><strong className="text-xl tabular-nums">{rows.filter(row=>row.physical_quantity!==null).length}/{rows.length}</strong></div>
    </div>
    <section className="grid gap-3">{rows.map(row=>{
      const product=row.ci_stock_lots ? products.get(row.ci_stock_lots.product_id) : null;
      const variance=row.physical_quantity===null?null:Number(row.physical_quantity)-Number(row.snapshot_quantity);
      return <article className="surface p-4 sm:p-5" key={row.id}>
        <div className="flex justify-between gap-3 flex-wrap">
          <div><strong>{product?.product_code ?? '—'} · {product?.display_name ?? '—'}</strong>
            <p className="muted text-xs mt-1">LOT {row.ci_stock_lots?.lot_number ?? '—'} · {row.ci_locations?.code ?? '—'}</p></div>
          <div className="text-right text-sm"><p>Snapshot <strong>{Number(row.snapshot_quantity)}</strong></p>
            <p>ส่วนต่าง <strong>{variance===null?'—':variance>0?`+${variance}`:variance}</strong></p></div>
        </div>
        {allDraft && canEdit ? <form action={setUnifiedCountLine} className="flex flex-wrap gap-3 items-end mt-4">
          <input type="hidden" name="batch_id" value={batch.id}/>
          <input type="hidden" name="count_id" value={row.count_id}/>
          <input type="hidden" name="line_id" value={row.id}/>
          <label className="field flex-1 min-w-[150px]">ยอดตรวจนับจริง
            <IntegerQuantityInput className="input" name="physical_quantity" min="0" defaultValue={row.physical_quantity??''} required/></label>
          <SubmitButton className="button secondary" label="บันทึกยอด" pendingLabel="กำลังบันทึก…"/>
        </form> : <p className="mt-3 text-sm">ยอดจริง <strong>{row.physical_quantity??'—'}</strong></p>}
      </article>;
    })}</section>
    {allDraft && canApprove && !dataError && <ConfirmForm action={approveUnifiedCount}
      message="ยืนยันผลตรวจนับทุกกลุ่มรหัสและสร้างรายการปรับยอดพร้อมกัน? หากข้อมูลของรายการใดเปลี่ยนหลัง Snapshot ระบบจะไม่อนุมัติทั้งชุด"
      className="surface p-5 sm:p-7 grid gap-4">
      <input type="hidden" name="batch_id" value={batch.id}/>
      <h2 className="font-bold text-lg">อนุมัติผลตรวจนับทั้งหมด</h2>
      <p className="muted text-sm">ระบบตรวจทุก LOT และบันทึกการปรับยอดแบบ Atomic · บันทึกยอดจริงครบก่อนอนุมัติ</p>
      <label className="field">เหตุผลอนุมัติ<input className="input" name="reason" maxLength={1000} required/></label>
      <SubmitButton className="button" disabled={!allFilled} label="อนุมัติและปรับยอดทั้งหมด" pendingLabel="กำลังตรวจสอบ…"/>
    </ConfirmForm>}
    {!allDraft && !allApproved && <p className="notice">รอบนี้ไม่พร้อมอนุมัติ กรุณาตรวจสอบสถานะและสร้าง Snapshot รอบใหม่เมื่อจำเป็น</p>}
  </main>;
}
