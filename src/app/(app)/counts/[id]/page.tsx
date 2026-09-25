import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { setCountLine, approveCount } from '@/app/actions/inventory';
import { ConfirmForm } from '@/components/confirm-form';
import { logUserMessage } from '@/lib/messages';
import { label, countStatusLabels } from '@/lib/labels';
import { SubmitButton } from '@/components/submit-button';

type Count = { id: string; warehouse_id: number; status: string; created_at: string; note: string | null };
type Line = { id: string; lot_id: string; location_id: string; snapshot_quantity: number; physical_quantity: number | null; ci_stock_lots: { lot_number: string; product_id: string } | null; ci_locations: { code: string } | null };

export default async function CountDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params; const query = await searchParams; const access = await requireAccess(); const client = await createClient(); if (!client) notFound();
  const { data: countData, error } = await client.from('ci_stock_counts').select('id,warehouse_id,status,created_at,note').eq('id',id).single();
  if (error || !countData) notFound(); const count = countData as Count; const warehouse = access.warehouses.find(w => Number(w.id) === count.warehouse_id); if (!warehouse) notFound();
  const { data: lineData, error: lineError } = await client.from('ci_stock_count_lines').select('id,lot_id,location_id,snapshot_quantity,physical_quantity,ci_stock_lots(lot_number,product_id),ci_locations(code)').eq('count_id',id).order('id');
  const lines = (lineData ?? []) as unknown as Line[];
  const productIds = [...new Set(lines.map(l => l.ci_stock_lots?.product_id).filter((v): v is string => !!v))];
  const productResult = productIds.length ? await client.from('ci_products').select('id,product_code,display_name').in('id',productIds) : { data: [] };
  const products = new Map((productResult.data ?? []).map(p => [p.id,p]));
  return <main className="grid gap-6 max-w-[1000px]"><div><Link href={`/counts?warehouse=${warehouse.code}`} className="muted text-sm">← รอบตรวจนับ</Link><p className="eyebrow mt-5 mb-2">Physical count · {warehouse.name}</p><h1 className="page-title">รอบตรวจนับ</h1><p className="muted mt-2 text-sm">{new Date(count.created_at).toLocaleString('th-TH')} · {count.note || 'ไม่มีหมายเหตุ'}</p><p className="mt-3"><span className="badge">{label(countStatusLabels,count.status)}</span></p></div>{query.error && <p className="error" role="alert">{query.error}</p>}{query.saved && <p className="notice" role="status">บันทึกแล้ว</p>}{lineError && <p className="error" role="alert">{logUserMessage('count', lineError)}</p>}
    <section className="grid gap-3">{lines.map(line => { const product = line.ci_stock_lots ? products.get(line.ci_stock_lots.product_id) : null; const variance = line.physical_quantity == null ? null : Number(line.physical_quantity) - Number(line.snapshot_quantity); return <article className="surface p-4 sm:p-5" key={line.id}><div className="flex justify-between gap-3 flex-wrap"><div><strong>{product?.product_code ?? '—'} · {product?.display_name ?? '—'}</strong><p className="muted text-xs mt-1">LOT {line.ci_stock_lots?.lot_number ?? '—'} · {line.ci_locations?.code ?? '—'}</p></div><div className="text-right text-sm"><p>Snapshot <strong>{Number(line.snapshot_quantity)}</strong></p><p>ส่วนต่าง <strong>{variance == null ? '—' : variance > 0 ? `+${variance}` : variance}</strong></p></div></div>{count.status === 'draft' && canMutate(warehouse.role) ? <form action={setCountLine} className="flex flex-wrap gap-3 items-end mt-4"><input type="hidden" name="count_id" value={id}/><input type="hidden" name="line_id" value={line.id}/><label className="field flex-1 min-w-[150px]">ยอดตรวจนับจริง<input className="input" name="physical_quantity" type="number" inputMode="decimal" min="0" step="0.001" defaultValue={line.physical_quantity ?? ''} required/></label><SubmitButton className="button secondary" label="บันทึกยอด" pendingLabel="กำลังบันทึก…"/></form> : <p className="mt-3 text-sm">ยอดจริง <strong>{line.physical_quantity ?? '—'}</strong></p>}</article>; })}{lines.length === 0 && <p className="notice">รอบนี้ไม่มี LOT ในขอบเขต</p>}</section>
    {count.status === 'draft' && canSupervise(warehouse.role) && <ConfirmForm action={approveCount} message="ยืนยันอนุมัติผลตรวจนับและสร้าง adjustment ตามส่วนต่าง? หาก ledger เปลี่ยนหลัง snapshot ระบบจะหยุด" className="surface p-5 sm:p-7 grid gap-4"><input type="hidden" name="count_id" value={id}/><h2 className="font-bold text-lg">อนุมัติผลตรวจนับ</h2><p className="muted text-sm">ต้องกรอกยอดจริงทุกรายการ ฐานข้อมูลตรวจ snapshot ใหม่ใน transaction</p><label className="field">เหตุผลอนุมัติ<input className="input" name="reason" required/></label><div><SubmitButton className="button" label="อนุมัติและปรับยอด" pendingLabel="กำลังบันทึก…"/></div></ConfirmForm>}
  </main>;
}
