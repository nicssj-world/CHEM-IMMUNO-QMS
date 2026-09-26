import Link from 'next/link';
import { Printer, Plus } from 'lucide-react';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { createLocation } from '@/app/actions/inventory';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { SubmitButton } from '@/components/submit-button';
import { LocationTypeIcon } from '@/components/location-type-icon';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { safeReturnPath } from '@/lib/return-path';
import { ENV_CONFIG_COLUMNS, LOCATION_COLUMNS, LOCATION_TYPES, describeEnvConfig, locationBreadcrumb, locationTypeLabel, type EnvConfigRow, type LocationRow } from '@/lib/locations';
import { hasOwnMonitoring, latestConfigByLocation, resolveEnvironmentMonitor } from '@/lib/environment-monitor';

type SearchParams = { warehouse?: string; error?: string; saved?: string; return?: string; q?: string; type?: string; active?: string };

export default async function LocationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  const [locationResult, configResult] = client ? await Promise.all([
    client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouse.id).order('active', { ascending: false }).order('code'),
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('warehouse_id', warehouse.id),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  const error = locationResult.error ?? configResult.error;
  const all = (locationResult.data ?? []) as LocationRow[];
  const configs = (configResult.data ?? []) as EnvConfigRow[];
  const byId = new Map(all.map(location => [location.id, location]));
  const current = latestConfigByLocation(configs);

  const q = (params.q ?? '').trim().slice(0, 100);
  const type = LOCATION_TYPES.some(item => item.value === params.type) ? params.type! : '';
  const active = params.active === '1' || params.active === '0' ? params.active : '';
  const needle = q.toLocaleLowerCase();
  const shown = all.filter(location =>
    (!type || location.location_type === type)
    && (!active || location.active === (active === '1'))
    && (!needle || `${location.code} ${location.name} ${location.room ?? ''}`.toLocaleLowerCase().includes(needle)));

  const canAdd = canSupervise(warehouse.role);
  const returnTo = safeReturnPath(params.return);
  const listQuery = new URLSearchParams({ warehouse: warehouse.code });
  return <main className="grid gap-6 max-w-[980px]"><div><p className="eyebrow mb-2">Storage locations</p><h1 className="page-title">ตำแหน่งจัดเก็บ</h1><p className="muted mt-2 text-sm">ตู้เย็น ห้อง ตู้เก็บ และชั้นวางที่ใช้ตอนรับเข้า ย้ายที่เก็บ และตรวจนับ · แยกตามคลัง</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/locations"/>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved, 'บันทึกแล้ว')}</p>}{error && <p className="error" role="alert">อ่านตำแหน่งไม่สำเร็จ: {logUserMessage('locations', error)}</p>}
    {returnTo && <p className="notice text-sm">เปิดมาจากหน้ารับเข้า · เพิ่มตำแหน่งแล้วระบบจะพากลับไปที่เดิม · <a href={returnTo}>กลับโดยไม่เพิ่ม</a></p>}
    {canAdd ? <form action={createLocation} className="surface p-5 sm:p-7 grid gap-4 content-start"><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="font-bold text-lg">เพิ่มตำแหน่งใน {warehouse.name}</h2><div className="flex flex-wrap gap-2"><Link className="button secondary" href={`/locations/new?${listQuery}`}><Plus size={16} aria-hidden />เพิ่มแบบละเอียด (ประเภท ช่วงอุณหภูมิ Portal)</Link><Link className="button secondary" href={`/locations/qr?${listQuery}`}><Printer size={16} aria-hidden />พิมพ์ป้าย QR</Link></div></div><input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="warehouse_id" value={warehouse.id}/>{returnTo && <input type="hidden" name="return_to" value={returnTo}/>}
      <div className="grid sm:grid-cols-[180px_1fr] gap-4"><label className="field">รหัสตำแหน่ง<input className="input" name="code" required maxLength={40} autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="เช่น F1-A" autoFocus={Boolean(returnTo)}/></label><label className="field">ชื่อ / คำอธิบาย<input className="input" name="name" required maxLength={120} placeholder="เช่น ตู้เย็น 1 ชั้น A"/></label></div>
      <div><SubmitButton className="button" label="เพิ่มตำแหน่ง" pendingLabel="กำลังบันทึก…"/></div></form>
      : <p className="notice">เพิ่มและแก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้</p>}
    <form method="get" className="surface p-4 flex gap-3 flex-wrap items-end"><input type="hidden" name="warehouse" value={warehouse.code}/>
      <label className="field flex-1 min-w-[200px]">ค้นหาตำแหน่ง<input className="input" name="q" defaultValue={q} placeholder="รหัส ชื่อ หรือห้อง"/></label>
      <label className="field min-w-[150px]">ประเภท<select className="input" name="type" defaultValue={type}><option value="">ทุกประเภท</option>{LOCATION_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="field min-w-[150px]">สถานะ<select className="input" name="active" defaultValue={active}><option value="">ทั้งหมด</option><option value="1">ใช้งาน</option><option value="0">ปิดใช้งาน</option></select></label>
      <button className="button">กรอง</button></form>
    <section className="surface overflow-hidden"><div className="px-5 py-4 flex justify-between gap-3"><h2 className="font-bold">ตำแหน่งทั้งหมด</h2><span className="muted text-sm">แสดง {shown.length} จาก {all.length} · ใช้งาน {all.filter(l => l.active).length}</span></div>
      {shown.length ? <ul className="grid">{shown.map(location => {
        const monitorId = resolveEnvironmentMonitor(location.id, all, configs);
        const monitor = monitorId ? byId.get(monitorId) : null;
        const ranges = monitorId ? describeEnvConfig(current.get(monitorId) as EnvConfigRow | undefined) : null;
        const own = hasOwnMonitoring(current.get(location.id));
        return <li key={location.id} className="border-t border-line"><Link href={`/locations/${location.id}?warehouse=${warehouse.code}`} className="flex items-center justify-between gap-3 px-5 py-3 min-h-16 no-underline text-[var(--ink)] hover:bg-surface-2">
          <div className="flex items-center gap-3 min-w-0"><LocationTypeIcon type={location.location_type} className="text-[var(--teal)] shrink-0" /><div className="min-w-0"><p className="font-bold">{locationBreadcrumb(location, byId)}</p><p className="muted text-sm truncate">{location.name}{location.room ? ` · ${location.room}` : ''}</p></div></div>
          <div className="text-right shrink-0 grid gap-1 justify-items-end"><span className="flex flex-wrap justify-end gap-1"><span className="badge">{locationTypeLabel(location.location_type)}</span>{monitor && <span className="badge">{own ? 'เฝ้าระวัง' : `ตาม ${monitor.code}`}{ranges?.temperature ? ` · ${ranges.temperature}` : ''}{ranges?.humidity ? ` · ${ranges.humidity}` : ''}</span>}<span className="badge">{location.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></span></div>
        </Link></li>;
      })}</ul> : <p className="muted px-5 pb-5">{all.length ? 'ไม่พบตำแหน่งที่ตรงกับตัวกรอง' : 'ยังไม่มีตำแหน่งในคลังนี้ · ต้องมีอย่างน้อยหนึ่งตำแหน่งก่อนรับสินค้าเข้า'}</p>}
    </section>
  </main>;
}
