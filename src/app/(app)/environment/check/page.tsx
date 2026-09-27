import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { EnvironmentQrScanner } from '@/components/environment/qr-scanner';
import { bangkokDate, ROUND_LABEL, type DayRound } from '@/lib/environment';
import { logUserMessage } from '@/lib/messages';

export default async function EnvironmentCheckScannerPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const query = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, query.warehouse);
  const client = await createClient();
  if (!client) return <main><h1 className="page-title">ตรวจด้วย QR</h1><p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const [roundResult, locationResult] = await Promise.all([
    client.rpc('ci_environment_day_status', { p_warehouse_id: warehouse.id, p_date: bangkokDate() }),
    client.from('ci_locations').select('id,code,name').eq('warehouse_id', warehouse.id).eq('active', true),
  ]);
  const error = roundResult.error ?? locationResult.error;
  const due = ((roundResult.data ?? []) as DayRound[]).filter(round => round.state === 'due' || round.state === 'missed');
  const byId = new Map((locationResult.data ?? []).map(item => [item.id, item]));
  return <main className="grid gap-6 max-w-[760px]"><div><p className="eyebrow mb-2">Environment check</p><h1 className="page-title">ตรวจอุณหภูมิ/ความชื้นด้วย QR</h1><p className="muted mt-2">สแกนป้ายตำแหน่งเฝ้าระวัง หรือเลือกจากรายการเมื่อตัวป้ายชำรุด</p></div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/environment/check"/>
    {warehouse.role === 'viewer' ? <p className="notice">บัญชีนี้ดูข้อมูลได้ แต่บันทึกค่าไม่ได้</p> : <EnvironmentQrScanner/>}
    {error ? <p className="error">อ่านรอบตรวจไม่สำเร็จ: {logUserMessage('environmentCheck', error)}</p> : <section id="due" className="surface p-5 grid gap-3"><h2 className="font-bold">ตำแหน่งที่ถึงเวลาหรือขาดการตรวจวันนี้</h2>
      {due.length === 0 && <p className="muted">ไม่มีรอบที่ถึงเวลาหรือขาดการตรวจในคลังนี้</p>}
      {due.map(round => { const location = byId.get(round.location_id); return location && <Link key={`${round.location_id}:${round.round_no}`} className="border border-line rounded-lg p-3 no-underline text-[var(--ink)]" href={`/environment/check/${round.location_id}?warehouse=${warehouse.code}`}><strong>{location.code}</strong> · {location.name}<span className="muted block text-sm">{round.due_time?.slice(0, 5)} · {ROUND_LABEL[round.state]}</span></Link>; })}
    </section>}
  </main>;
}
