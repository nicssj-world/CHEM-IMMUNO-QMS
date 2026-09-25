import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { createLocation } from '@/app/actions/inventory';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { SubmitButton } from '@/components/submit-button';
import { formatDate } from '@/lib/format';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { safeReturnPath } from '@/lib/return-path';

type Location = { id: string; code: string; name: string; active: boolean; created_at: string };

export default async function LocationsPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string; saved?: string; return?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  const { data, error } = client ? await client.from('ci_locations').select('id,code,name,active,created_at').eq('warehouse_id', warehouse.id).order('active', { ascending: false }).order('code') : { data: [], error: null };
  const locations = (data ?? []) as Location[];
  const canAdd = canSupervise(warehouse.role);
  const returnTo = safeReturnPath(params.return);
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Storage locations</p><h1 className="page-title">ตำแหน่งจัดเก็บ</h1><p className="muted mt-2 text-sm">ตำแหน่งที่ใช้ตอนรับเข้า ย้ายที่เก็บ และตรวจนับ · แยกตามคลัง</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/locations"/>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved, 'บันทึกแล้ว')}</p>}{error && <p className="error" role="alert">อ่านตำแหน่งไม่สำเร็จ: {logUserMessage('locations', error)}</p>}
    {returnTo && <p className="notice text-sm">เปิดมาจากหน้ารับเข้า · เพิ่มตำแหน่งแล้วระบบจะพากลับไปที่เดิม · <a href={returnTo}>กลับโดยไม่เพิ่ม</a></p>}
    {canAdd ? <form action={createLocation} className="surface p-5 sm:p-7 grid gap-4 content-start"><h2 className="font-bold text-lg">เพิ่มตำแหน่งใน {warehouse.name}</h2><input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="warehouse_id" value={warehouse.id}/>{returnTo && <input type="hidden" name="return_to" value={returnTo}/>}
      <div className="grid sm:grid-cols-[180px_1fr] gap-4"><label className="field">รหัสตำแหน่ง<input className="input" name="code" required maxLength={40} autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="เช่น F1-A" autoFocus={Boolean(returnTo)}/></label><label className="field">ชื่อ / คำอธิบาย<input className="input" name="name" required maxLength={120} placeholder="เช่น ตู้เย็น 1 ชั้น A"/></label></div>
      <div><SubmitButton className="button" label="เพิ่มตำแหน่ง" pendingLabel="กำลังบันทึก…"/></div></form>
      : <p className="notice">เพิ่มตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้</p>}
    <section className="surface overflow-hidden"><div className="px-5 py-4 flex justify-between gap-3"><h2 className="font-bold">ตำแหน่งทั้งหมด</h2><span className="muted text-sm">{locations.filter(l => l.active).length} ตำแหน่งที่ใช้งาน</span></div>
      {locations.length ? <ul className="grid">{locations.map(l => <li key={l.id} className="flex items-center justify-between gap-3 border-t border-line px-5 py-3"><div className="min-w-0"><p className="font-bold">{l.code}</p><p className="muted text-sm truncate">{l.name}</p></div><div className="text-right shrink-0"><span className="badge">{l.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span><p className="muted text-xs mt-1">เพิ่มเมื่อ {formatDate(l.created_at)}</p></div></li>)}</ul> : <p className="muted px-5 pb-5">ยังไม่มีตำแหน่งในคลังนี้ · ต้องมีอย่างน้อยหนึ่งตำแหน่งก่อนรับสินค้าเข้า</p>}
    </section>
    <p className="muted text-xs">การแก้ไขหรือปิดใช้งานตำแหน่งยังไม่รองรับในระบบ · แจ้งผู้ดูแลฐานข้อมูลหากต้องเปลี่ยน</p>
  </main>;
}
