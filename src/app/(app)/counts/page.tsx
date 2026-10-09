import Link from 'next/link';
import { requireAccess, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createUnifiedCount } from '@/app/actions/inventory';
import { logUserMessage } from '@/lib/messages';
import { label, countStatusLabels } from '@/lib/labels';
import { SubmitButton } from '@/components/submit-button';

type Batch = { id: string; created_at: string; note: string | null; che_count_id: string | null; imm_count_id: string | null };
type Count = { id: string; warehouse_id: number; created_at: string; status: string; note: string | null };

export default async function CountsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params=await searchParams;
  const access=await requireAccess();
  const writable=access.warehouses.filter(item=>canMutate(item.role));
  const client=await createClient();
  const [batchResult,countResult]=client ? await Promise.all([
    client.from('ci_unified_stock_counts').select('id,created_at,note,che_count_id,imm_count_id').order('created_at',{ascending:false}).limit(100),
    client.from('ci_stock_counts').select('id,warehouse_id,created_at,status,note').order('created_at',{ascending:false}).limit(200),
  ]) : [{data:[],error:null},{data:[],error:null}];
  const batches=(batchResult.data ?? []) as Batch[];
  const counts=(countResult.data ?? []) as Count[];
  const countById=new Map(counts.map(count=>[count.id,count]));
  const groupedIds=new Set(batches.flatMap(batch=>[batch.che_count_id,batch.imm_count_id]).filter((id): id is string=>Boolean(id)));
  const historical=counts.filter(count=>!groupedIds.has(count.id));
  const error=batchResult.error ?? countResult.error;
  const canCreate=writable.some(item=>Number(item.id)===1) && writable.some(item=>Number(item.id)===2);

  return <main className="grid gap-6 max-w-[1000px]">
    <div><p className="eyebrow mb-2">Physical count</p><h1 className="page-title">ตรวจนับคลังน้ำยา</h1>
      <p className="muted mt-2 text-sm">สร้าง Snapshot ของน้ำยาทั้งหมดในครั้งเดียว · ระบบตรวจการเปลี่ยนแปลงของ Ledger ก่อนอนุมัติ</p></div>
    {params.error && <p className="error" role="alert">{params.error}</p>}
    {error && <p className="error" role="alert">โหลดรอบตรวจนับไม่สำเร็จ: {logUserMessage('counts',error)}</p>}
    {canCreate && !error && <form action={createUnifiedCount} className="surface p-5 sm:p-7 grid gap-4">
      <div><h2 className="font-extrabold text-lg">เริ่มรอบตรวจนับใหม่</h2><p className="muted text-sm mt-1">ระบบสร้าง Snapshot ของ LOT × Location ทุกกลุ่มรหัสในธุรกรรมเดียว</p></div>
      <label className="field">หมายเหตุ<input className="input" name="note" maxLength={1000} placeholder="เช่น ตรวจนับประจำเดือน"/></label>
      <div><SubmitButton className="button" label="สร้างรอบตรวจนับ" pendingLabel="กำลังสร้าง Snapshot…"/></div>
    </form>}
    <section className="surface p-5 sm:p-7">
      <h2 className="font-bold mb-4">รอบตรวจนับล่าสุด</h2>
      <div className="grid gap-2">{batches.map(batch=>{
        const members=[batch.che_count_id,batch.imm_count_id].filter((id):id is string=>Boolean(id)).map(id=>countById.get(id));
        const status=members.some(item=>!item) ? 'ไม่สามารถอ่านสถานะ' : members.every(item=>item?.status==='approved')?'approved':members.some(item=>item?.status==='stale')?'stale':'draft';
        return <Link key={batch.id} href={`/counts/${batch.id}`} className="rounded-xl border border-line p-4 no-underline text-[var(--ink)] flex justify-between gap-3">
          <span><strong>{new Date(batch.created_at).toLocaleString('th-TH')}</strong><span className="muted text-xs block mt-1">{batch.note||'รอบตรวจนับคลังน้ำยา'}</span></span>
          <span className="badge h-fit">{status==='ไม่สามารถอ่านสถานะ'?status:label(countStatusLabels,status)}</span>
        </Link>;
      })}{batches.length===0 && !error && <p className="muted text-sm">ยังไม่มีรอบตรวจนับใหม่</p>}</div>
    </section>
    {historical.length>0 && <section className="surface p-5 sm:p-7">
      <h2 className="font-bold mb-4">รอบตรวจนับเดิม</h2>
      <p className="muted text-xs mb-3">รายการเดิมยังคงหลักฐานและยอดตามที่บันทึกไว้</p>
      <div className="grid gap-2">{historical.map(count=><Link key={count.id} href={`/counts/${count.id}`} className="rounded-xl border border-line p-4 no-underline text-[var(--ink)] flex justify-between gap-3">
        <span><strong>{new Date(count.created_at).toLocaleString('th-TH')}</strong><span className="muted text-xs block mt-1">{count.note||count.id.slice(0,8)}</span></span>
        <span className="badge h-fit">{label(countStatusLabels,count.status)}</span></Link>)}</div>
    </section>}
  </main>;
}
