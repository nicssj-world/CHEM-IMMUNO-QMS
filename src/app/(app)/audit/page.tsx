import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';

type AuditRow = { id: number; action: string; entity_table: string; entity_id: string; created_at: string; reason: string | null; old_value: unknown; new_value: unknown; actor_id: string | null };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const access = await requireAccess(); const warehouse = selectedWarehouse(access,(await searchParams).warehouse); const client = await createClient();
  const { data,error } = client && canSupervise(warehouse.role) ? await client.from('ci_audit_logs').select('id,action,entity_table,entity_id,created_at,reason,old_value,new_value,actor_id').eq('warehouse_id',warehouse.id).order('created_at',{ascending:false}).limit(200) : { data: [],error:null };
  const rows = (data ?? []) as AuditRow[];
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Audit trail</p><h1 className="page-title">บันทึกการตรวจสอบ</h1><p className="muted mt-2 text-sm">เหตุการณ์ master data, access, approvals และ stock operation</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/audit"/>{!canSupervise(warehouse.role) && <p className="error">หน้านี้ใช้ได้เฉพาะ Supervisor หรือ Admin</p>}{error && <p className="error">{error.message}</p>}<section className="surface grid gap-3 p-4 sm:p-6">{rows.map(row => <details key={row.id} className="rounded-xl border border-[#dce7eb] p-4"><summary className="cursor-pointer min-h-11 flex items-center justify-between gap-3"><span><span className="badge">{row.action}</span> <strong className="ml-2">{row.entity_table}</strong></span><time className="muted text-xs">{new Date(row.created_at).toLocaleString('th-TH')}</time></summary><dl className="grid sm:grid-cols-2 gap-3 mt-3 text-xs"><div><dt className="muted">Entity</dt><dd className="font-mono break-all">{row.entity_id}</dd></div><div><dt className="muted">Actor</dt><dd className="font-mono break-all">{row.actor_id ?? '—'}</dd></div><div><dt className="muted">เหตุผล</dt><dd>{row.reason ?? '—'}</dd></div><div><dt className="muted">Before / After</dt><dd className="break-all">{JSON.stringify(row.old_value ?? row.new_value ?? {})}</dd></div></dl></details>)}{rows.length === 0 && <p className="muted">ไม่มี audit event ในคลังนี้</p>}</section></main>;
}
