import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { formatDateTime } from '@/lib/format';
import { auditActionLabels, entityTableLabels, label } from '@/lib/labels';
import { logUserMessage } from '@/lib/messages';

type AuditRow = { id: number; action: string; entity_table: string; entity_id: string; created_at: string; reason: string | null; old_value: unknown; new_value: unknown; actor_id: string | null };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const access = await requireAccess(); const warehouse = selectedWarehouse(access,(await searchParams).warehouse); const client = await createClient();
  const { data,error } = client && canSupervise(warehouse.role) ? await client.from('ci_audit_logs').select('id,action,entity_table,entity_id,created_at,reason,old_value,new_value,actor_id').or(`warehouse_id.eq.${warehouse.id},warehouse_id.is.null`).order('created_at',{ascending:false}).limit(200) : { data: [],error:null };
  const rows = (data ?? []) as AuditRow[];
  // Actor ids resolve to names where the viewer can read profiles; otherwise the id stays as evidence.
  const actorIds = [...new Set(rows.map(r => r.actor_id).filter((id): id is string => Boolean(id)))];
  const { data: actorData } = client && actorIds.length ? await client.from('ci_user_profiles').select('user_id,display_name,ephis_id').in('user_id',actorIds) : { data: [] };
  const actors = new Map((actorData ?? []).map(a => [a.user_id as string, `${a.display_name} (${a.ephis_id})`]));
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Audit trail</p><h1 className="page-title">บันทึกการตรวจสอบ</h1><p className="muted mt-2 text-sm">เหตุการณ์ master data, access, approvals และ stock operation</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/audit"/>{!canSupervise(warehouse.role) && <p className="error">หน้านี้ใช้ได้เฉพาะ Supervisor หรือ Admin</p>}{error && <p className="error" role="alert">{logUserMessage('audit',error)}</p>}<section className="surface grid gap-3 p-4 sm:p-6">{rows.map(row => <details key={row.id} className="rounded-xl border border-[var(--line)] p-4"><summary className="cursor-pointer min-h-11 flex items-center justify-between gap-3"><span><span className="badge">{label(auditActionLabels,row.action)}</span> <strong className="ml-2">{label(entityTableLabels,row.entity_table)}</strong></span><time className="muted text-xs">{formatDateTime(row.created_at)}</time></summary><dl className="grid sm:grid-cols-2 gap-3 mt-3 text-xs"><div><dt className="muted">รหัสข้อมูล</dt><dd className="font-mono break-all">{row.entity_id}</dd></div><div><dt className="muted">ผู้ทำรายการ</dt><dd className="break-all">{row.actor_id ? actors.get(row.actor_id) ?? <span className="font-mono">{row.actor_id}</span> : '—'}</dd></div><div><dt className="muted">เหตุผล</dt><dd>{row.reason ?? '—'}</dd></div><div className="sm:col-span-2"><dt className="muted">ข้อมูลก่อน / หลัง</dt><dd><pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-[var(--bg)] p-3 whitespace-pre-wrap break-all">{JSON.stringify({ ก่อน: row.old_value ?? null, หลัง: row.new_value ?? null }, null, 2)}</pre></dd></div></dl></details>)}{rows.length === 0 && <p className="muted">ไม่มีบันทึกการตรวจสอบในคลังนี้</p>}</section></main>;
}
