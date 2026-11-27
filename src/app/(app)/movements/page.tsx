import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { reverseTransaction } from '@/app/actions/inventory';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { StockMovementCards } from '@/components/stock-movement-cards';
import { loadMovementDetails, type MovementTransaction } from '@/lib/stock-history';
import { label, movementKindLabels } from '@/lib/labels';
import { formatDateTimeBE } from '@/lib/format';
import { logUserMessage, savedNotice } from '@/lib/messages';

const kinds = ['receive','issue','transfer','adjustment','reversal','expired_disposal'] as const;
const size = 20;

export default async function MovementsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; kind?: string; page?: string }> }) {
  const access = await requireAccess();
  const params = await searchParams;
  const client = await createClient();
  const scopeIds = access.warehouses.map(w => Number(w.id));
  const page = Math.min(500, Math.max(1, Number.parseInt(params.page ?? '1',10) || 1));
  const kind = kinds.find(item=>item===params.kind) ?? '';
  let request = client?.from('ci_stock_transactions')
    .select('id,warehouse_id,kind,created_at,reason,purpose,actor_id,source_transaction_id', {count:'exact'})
    .in('warehouse_id', scopeIds);
  if (kind) request = request?.eq('kind', kind);
  const { data, error, count } = request
    ? await request.order('created_at',{ascending:false}).order('id',{ascending:false})
        .range((page-1)*size,page*size-1)
    : { data: [], error: null, count: 0 };
  const rows = (data ?? []) as MovementTransaction[];
  const details = client && !error
    ? await loadMovementDetails(client,rows,access).catch(()=>null)
    : null;
  const supervisorIds = new Set(access.warehouses.filter(w=>w.role==='admin'||w.role==='supervisor').map(w=>Number(w.id)));
  const reversible = rows.filter(row=>row.kind!=='reversal' && supervisorIds.has(Number(row.warehouse_id)));
  const query = new URLSearchParams();
  if (kind) query.set('kind',kind);

  return <main className="grid gap-5 min-w-0">
    <header>
      <p className="eyebrow mb-2">Stock movement history</p>
      <h1 className="page-title">ประวัติการเคลื่อนไหว</h1>
      <p className="muted text-sm mt-2">แสดงน้ำยา LOT จำนวน ผู้ทำรายการ วันเวลา และยอดคงเหลือปัจจุบัน · ประวัติที่ยืนยันแล้วเป็นแบบ Append-only</p>
    </header>
    {params.error && <p className="error" role="alert">{params.error}</p>}
    {params.saved && <p className="notice" role="status">{savedNotice(params.saved,'สร้างรายการย้อนกลับแล้ว')}</p>}
    <form method="get" className="surface p-4 flex flex-wrap gap-3 items-end">
      <label className="field flex-1 min-w-48">ประเภท
        <select className="input" name="kind" defaultValue={kind}>
          <option value="">ทั้งหมด</option>
          {kinds.map(item=><option key={item} value={item}>{label(movementKindLabels,item)}</option>)}
        </select>
      </label>
      <button className="button secondary" type="submit">กรองรายการ</button>
    </form>
    {error && <p className="error" role="alert">โหลดประวัติไม่สำเร็จ: {logUserMessage('movements',error)}</p>}
    {!error && details === null && <p className="error" role="alert">โหลดรายละเอียดประวัติไม่ครบ กรุณาลองใหม่อีกครั้ง</p>}
    {!error && details !== null && <>
      <p className="muted text-xs">ทั้งหมด {(count ?? 0).toLocaleString('th-TH')} รายการ · หน้า {page} จาก {Math.max(1,Math.ceil((count??0)/size))}</p>
      <StockMovementCards rows={details}/>
      <nav aria-label="หน้าประวัติการเคลื่อนไหว" className="flex gap-3 justify-between">
        {page>1?<Link className="button secondary" href={'/movements?'+query+'&page='+(page-1)}>← ก่อนหน้า</Link>:<span/>}
        {page*size<(count??0)&&<Link className="button secondary" href={'/movements?'+query+'&page='+(page+1)}>ถัดไป →</Link>}
      </nav>
    </>}
    {reversible.length>0 && <details className="surface p-4 sm:p-6">
      <summary className="cursor-pointer font-semibold">ยกเลิกรายการที่ยืนยัน (Supervisor / Admin)</summary>
      <div className="mt-4 grid gap-3">
        <p className="muted text-sm">การยกเลิกสร้างรายการย้อนกลับใหม่ ไม่แก้ไขประวัติเดิม และต้องมีเหตุผล</p>
        <ConfirmForm action={reverseTransaction} message="ยืนยันสร้าง movement ตรงข้ามกับรายการนี้?" className="grid gap-4">
          <input type="hidden" name="idempotency_key" value={randomUUID()}/>
          <input type="hidden" name="warehouse" value="ALL"/>
          <label className="field">รายการต้นทาง
            <select className="input" name="source_id" defaultValue="" required>
              <option value="">เลือกรายการ</option>
              {reversible.map(row=><option key={row.id} value={row.id}>
                {formatDateTimeBE(row.created_at)} · {label(movementKindLabels,row.kind)} · {row.id.slice(0,8)}
              </option>)}
            </select>
          </label>
          <label className="field">เหตุผล <textarea className="input min-h-24" name="reason" required/></label>
          <SubmitButton className="button danger" label="ยืนยันยกเลิกรายการ" pendingLabel="กำลังยกเลิกรายการ…"/>
        </ConfirmForm>
      </div>
    </details>}
  </main>;
}
