import { randomUUID } from 'node:crypto';
import { requireAccess } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { reverseTransaction } from '@/app/actions/inventory';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { formatDateTime } from '@/lib/format';
import { label, movementKindLabels } from '@/lib/labels';
import { logUserMessage, savedNotice } from '@/lib/messages';

type Movement = { id: string; kind: string; created_at: string; reason: string | null; purpose: string | null; idempotency_key: string; ci_stock_movement_lines: { quantity_delta: number }[] };

export default async function MovementsPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string; saved?: string }> }) {
  const access = await requireAccess();
  const params = await searchParams;
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  const { data, error } = client ? await client.from('ci_stock_transactions').select('id,kind,created_at,reason,purpose,idempotency_key,ci_stock_movement_lines(quantity_delta)').eq('warehouse_id', warehouse.id).order('created_at', { ascending: false }).limit(100) : { data: [], error: null };
  const rows = (data ?? []) as Movement[];
  const canReverse = warehouse.role === 'admin' || warehouse.role === 'supervisor';
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Append-only ledger</p><h1 className="page-title">ประวัติการเคลื่อนไหว</h1><p className="muted mt-2 text-sm">รายการที่ยืนยันแล้วแก้ไขหรือลบไม่ได้ การแก้ยอดใช้รายการย้อนกลับ</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/movements"/>{params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved,'สร้างรายการย้อนกลับแล้ว')}</p>}{error && <p className="error" role="alert">โหลดประวัติไม่สำเร็จ: {logUserMessage('movements',error)}</p>}<section className="surface overflow-hidden"><div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>เวลา</th><th>ชนิด</th><th>รายการเคลื่อนไหว</th><th>เหตุผล / Purpose</th><th>รหัสรายการ</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{formatDateTime(row.created_at)}</td><td><span className="badge">{label(movementKindLabels,row.kind)}</span></td><td>{row.ci_stock_movement_lines?.map(x => Number(x.quantity_delta).toLocaleString()).join(', ') || '—'}</td><td>{row.reason || row.purpose || '—'}</td><td className="font-mono text-xs">{row.id.slice(0,8)}</td></tr>)}</tbody></table></div><div className="mobile-card-list p-4">{rows.map(row => <article className="border border-[var(--line)] rounded-xl p-4" key={row.id}><div className="flex justify-between"><span className="badge">{label(movementKindLabels,row.kind)}</span><span className="muted text-xs">{formatDateTime(row.created_at)}</span></div><p className="font-bold mt-3">{row.ci_stock_movement_lines?.map(x => Number(x.quantity_delta).toLocaleString()).join(' / ') || '—'}</p><p className="muted text-xs mt-1">{row.reason || row.purpose || row.id.slice(0,8)}</p></article>)}</div>{rows.length === 0 && <p className="muted p-5">ยังไม่มีประวัติรายการ</p>}</section>{canReverse && <section className="surface p-5 sm:p-7"><h2 className="font-extrabold text-lg">ย้อนรายการที่ยืนยัน</h2><p className="muted text-sm mt-1 mb-5">เลือก source transaction เพียงครั้งเดียว ต้องมีเหตุผล และต้องไม่ทำให้ยอดติดลบ</p><ConfirmForm action={reverseTransaction} message="ยืนยันสร้าง movement ตรงข้ามกับรายการนี้?" className="grid gap-4"><input type="hidden" name="idempotency_key" value={randomUUID()}/><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field">รายการต้นทาง<select className="input" name="source_id" defaultValue="" required><option value="">เลือกรายการ</option>{rows.filter(r => r.kind !== 'reversal').map(r => <option key={r.id} value={r.id}>{formatDateTime(r.created_at)} · {label(movementKindLabels,r.kind)} · {r.ci_stock_movement_lines?.map(x => Number(x.quantity_delta).toLocaleString()).join(' / ')} · {r.reason || r.purpose || r.id.slice(0,8)}</option>)}</select></label><label className="field">เหตุผล<textarea className="input min-h-24" name="reason" required/></label><div><SubmitButton className="button danger" label="ยืนยันย้อนรายการ" pendingLabel="กำลังย้อนรายการ…"/></div></ConfirmForm></section>}</main>;
}
