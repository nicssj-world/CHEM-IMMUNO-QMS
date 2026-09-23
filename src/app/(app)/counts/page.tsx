import Link from 'next/link';
import { requireAccess, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { createCount } from '@/app/actions/inventory';

type Count = { id: string; created_at: string; status: string; note: string | null };

export default async function CountsPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string }> }) {
  const params = await searchParams; const access = await requireAccess(); const warehouse = selectedWarehouse(access,params.warehouse); const client = await createClient();
  const { data,error } = client ? await client.from('ci_stock_counts').select('id,created_at,status,note').eq('warehouse_id',warehouse.id).order('created_at',{ascending:false}).limit(50) : { data: [],error:null };
  const counts = (data ?? []) as Count[];
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Physical count</p><h1 className="page-title">ตรวจนับ stock</h1><p className="muted mt-2 text-sm">บันทึก snapshot → กรอกยอดจริง → Supervisor อนุมัติหลังตรวจความเปลี่ยนแปลงของ ledger</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/counts"/>{params.error && <p className="error" role="alert">{params.error}</p>}{error && <p className="error" role="alert">{error.message}</p>}{canMutate(warehouse.role) && <form action={createCount} className="surface p-5 sm:p-7 grid gap-4"><input type="hidden" name="warehouse_id" value={warehouse.id}/><div><h2 className="font-extrabold text-lg">เริ่มรอบตรวจนับ</h2><p className="muted text-sm mt-1">Snapshot LOT × Location ที่มียอดคงเหลือในคลังนี้</p></div><label className="field">หมายเหตุ<input className="input" name="note" placeholder="เช่น ตรวจนับประจำเดือน"/></label><div><button className="button" type="submit">สร้าง snapshot</button></div></form>}<section className="surface p-5 sm:p-7"><h2 className="font-bold mb-4">รอบตรวจนับล่าสุด</h2><div className="grid gap-2">{counts.map(count => <Link href={`/counts/${count.id}`} key={count.id} className="rounded-xl border border-[#dce7eb] p-4 no-underline text-[var(--ink)] flex justify-between gap-3"><span><strong>{new Date(count.created_at).toLocaleString('th-TH')}</strong><span className="muted text-xs block mt-1">{count.note || count.id.slice(0,8)}</span></span><span className="badge h-fit">{count.status}</span></Link>)}{counts.length === 0 && <p className="muted text-sm">ยังไม่มีรอบตรวจนับ</p>}</div></section></main>;
}
