import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createLocation } from '@/app/actions/inventory';
import { LiveSearchForm } from '@/components/live-search-form';
import { SubmitButton } from '@/components/submit-button';
import { LocationTypeIcon } from '@/components/location-type-icon';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { safeReturnPath } from '@/lib/return-path';
import { LOCATION_COLUMNS, LOCATION_TYPES, locationBreadcrumb, locationTypeLabel, type LocationRow } from '@/lib/locations';

type SearchParams = { warehouse?: string; error?: string; saved?: string; return?: string; q?: string; type?: string; active?: string };

export default async function LocationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const manager = access.warehouses.find(w => canSupervise(w.role));
  const client = await createClient();
  const locationResult = client
    ? await client.from('ci_locations').select(LOCATION_COLUMNS).order('active', { ascending: false }).order('code')
    : { data: [], error: null };
  const error = locationResult.error;
  const all = (locationResult.data ?? []) as LocationRow[];
  const byId = new Map(all.map(location => [location.id, location]));

  const q = (params.q ?? '').trim().slice(0, 100);
  const type = LOCATION_TYPES.some(item => item.value === params.type) ? params.type! : '';
  const active = params.active === '1' || params.active === '0' ? params.active : '';
  const needle = q.toLocaleLowerCase();
  const shown = all.filter(location =>
    (!type || location.location_type === type)
    && (!active || location.active === (active === '1'))
    && (!needle || `${location.code} ${location.name} ${location.room ?? ''}`.toLocaleLowerCase().includes(needle)));

  const canAdd = Boolean(manager);
  const duplicateCodes = new Map<string, number>();
  for (const location of all) duplicateCodes.set(location.code.trim().toLowerCase(), (duplicateCodes.get(location.code.trim().toLowerCase()) ?? 0) + 1);
  const returnTo = safeReturnPath(params.return);
  const listQuery = new URLSearchParams();
  return <main className="grid gap-6 max-w-[980px]"><div><p className="eyebrow mb-2">Storage locations</p><h1 className="page-title">ตำแหน่งจัดเก็บ</h1><p className="muted mt-2 text-sm">ตู้เย็น ห้อง ตู้เก็บ และชั้นวางที่ใช้ตอนรับเข้า ย้ายที่เก็บ และตรวจนับ · ใช้ร่วมกันทั้ง CHE และ IMM</p></div>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved, 'บันทึกแล้ว')}</p>}{error && <p className="error" role="alert">อ่านตำแหน่งไม่สำเร็จ: {logUserMessage('locations', error)}</p>}
    {returnTo && <p className="notice text-sm">เปิดมาจากหน้ารับเข้า · เพิ่มตำแหน่งแล้วระบบจะพากลับไปที่เดิม · <a href={returnTo}>กลับโดยไม่เพิ่ม</a></p>}
    {canAdd ? <form action={createLocation} className="surface p-5 sm:p-7 grid gap-4 content-start"><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="font-bold text-lg">เพิ่มตำแหน่งจัดเก็บ</h2><div className="flex flex-wrap gap-2"><Link className="button secondary" href={`/locations/new?${listQuery}`}><Plus size={16} aria-hidden />เพิ่มแบบละเอียด</Link></div></div><input type="hidden" name="warehouse_id" value={manager?.id ?? ""}/>{returnTo && <input type="hidden" name="return_to" value={returnTo}/>}
      <div className="grid sm:grid-cols-[180px_1fr] gap-4"><label className="field">รหัสตำแหน่ง<input className="input" name="code" required maxLength={40} autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="เช่น F1-A" autoFocus={Boolean(returnTo)}/></label><label className="field">ชื่อ / คำอธิบาย<input className="input" name="name" required maxLength={120} placeholder="เช่น ตู้เย็น 1 ชั้น A"/></label></div>
      <div><SubmitButton className="button" label="เพิ่มตำแหน่ง" pendingLabel="กำลังบันทึก…"/></div></form>
      : <p className="notice">เพิ่มและแก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบ</p>}
    <LiveSearchForm ariaLabel="ค้นหาและกรองตำแหน่งจัดเก็บ" className="surface p-4 flex gap-3 flex-wrap items-end">
      <label className="field flex-1 min-w-[200px]">ค้นหาตำแหน่ง<input className="input" type="search" name="q" maxLength={100} defaultValue={q} placeholder="รหัส ชื่อ หรือห้อง"/></label>
      <label className="field min-w-[150px]">ประเภท<select className="input" name="type" defaultValue={type}><option value="">ทุกประเภท</option>{LOCATION_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="field min-w-[150px]">สถานะ<select className="input" name="active" defaultValue={active}><option value="">ทั้งหมด</option><option value="1">ใช้งาน</option><option value="0">ปิดใช้งาน</option></select></label>
    </LiveSearchForm>
    <section className="surface overflow-hidden"><div className="px-5 py-4 flex justify-between gap-3"><h2 className="font-bold">ตำแหน่งทั้งหมด</h2><span className="muted text-sm">แสดง {shown.length} จาก {all.length} · ใช้งาน {all.filter(l => l.active).length}</span></div>
      {shown.length ? <ul className="grid">{shown.map(location => {
        return <li key={location.id} className="border-t border-line"><Link href={`/locations/${location.id}`} className="flex items-center justify-between gap-3 px-5 py-3 min-h-16 no-underline text-[var(--ink)] hover:bg-surface-2">
          <div className="flex items-center gap-3 min-w-0"><LocationTypeIcon type={location.location_type} className="text-[var(--teal)] shrink-0" /><div className="min-w-0"><p className="font-bold">{locationBreadcrumb(location, byId)}</p><p className="muted text-sm truncate">{location.name}{location.room ? ` · ${location.room}` : ''}</p></div></div>
          <div className="text-right shrink-0 grid gap-1 justify-items-end"><span className="flex flex-wrap justify-end gap-1"><span className="badge">{locationTypeLabel(location.location_type)}</span>{(duplicateCodes.get(location.code.trim().toLowerCase()) ?? 0) > 1 && <span className="badge">รหัสซ้ำ · ตรวจสอบ</span>}<span className="badge">{location.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></span></div>
        </Link></li>;
      })}</ul> : <p className="muted px-5 pb-5">{all.length ? 'ไม่พบตำแหน่งที่ตรงกับตัวกรอง' : 'ยังไม่มีตำแหน่งจัดเก็บ · เพิ่มอย่างน้อยหนึ่งตำแหน่งก่อนรับน้ำยาเข้า'}</p>}
    </section>
  </main>;
}
