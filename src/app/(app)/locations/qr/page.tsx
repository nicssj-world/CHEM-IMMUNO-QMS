import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { PrintButton } from '@/components/print-button';
import { ENV_CONFIG_COLUMNS, LOCATION_COLUMNS, describeEnvConfig, locationBreadcrumb, type EnvConfigRow, type LocationRow } from '@/lib/locations';
import { latestConfigByLocation, resolveEnvironmentMonitor } from '@/lib/environment-monitor';
import { appOrigin, locationQrUrl } from '@/lib/location-qr';
import { qrDataUri } from '@/lib/qr';

type SearchParams = { warehouse?: string; ids?: string | string[]; include_inactive?: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?ids=` accepts a comma-separated list or repeated parameters (the selection form sends the latter). */
function parseIds(raw: string | string[] | undefined) {
  const values = (Array.isArray(raw) ? raw : [raw ?? '']).flatMap(value => value.split(','));
  return [...new Set(values.map(value => value.trim()).filter(value => uuid.test(value)))];
}

export default async function LocationQrPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  if (!canSupervise(warehouse.role)) {
    return <main className="grid gap-4 max-w-[900px]"><div><p className="eyebrow mb-2">QR labels</p><h1 className="page-title">พิมพ์ป้าย QR ตำแหน่ง</h1></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/locations/qr"/><p className="notice">พิมพ์ป้าย QR ได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้ · <Link href={`/locations?warehouse=${warehouse.code}`}>กลับไปรายการตำแหน่ง</Link></p></main>;
  }
  const client = await createClient();
  const [locationResult, configResult] = client ? await Promise.all([
    client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouse.id).order('code'),
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('warehouse_id', warehouse.id),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  const all = (locationResult.data ?? []) as LocationRow[];
  const configs = (configResult.data ?? []) as EnvConfigRow[];
  const byId = new Map(all.map(location => [location.id, location]));
  const current = latestConfigByLocation(configs);

  const ids = parseIds(params.ids);
  const selected = ids.length ? all.filter(location => ids.includes(location.id)) : all;
  const includeInactive = params.include_inactive === '1';
  const inactive = selected.filter(location => !location.active);
  const labels = selected.filter(location => location.active || includeInactive);
  const origin = appOrigin();
  const qr = await Promise.all(labels.map(location => qrDataUri(locationQrUrl(location.qr_token, origin))));
  const selectionQuery = new URLSearchParams({ warehouse: warehouse.code });
  if (ids.length) selectionQuery.set('ids', ids.join(','));

  return <main className="grid gap-6">
    <div className="print-hide"><p className="eyebrow mb-2">QR labels</p><h1 className="page-title">พิมพ์ป้าย QR ตำแหน่ง</h1><p className="muted mt-2 text-sm">ป้ายขนาด 50 × 30 มม. บนกระดาษ A4 แนวตั้ง · QR ชี้ไปที่ {origin} · ผู้สแกนต้องเข้าสู่ระบบและมีสิทธิ์ของคลังนั้น</p></div>
    <div className="print-hide grid gap-4"><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/locations/qr"/>
      {inactive.length > 0 && <p className="notice" role="status">{includeInactive ? `รวมตำแหน่งที่ปิดใช้งาน ${inactive.length} รายการในป้ายด้านล่างแล้ว` : `ข้ามตำแหน่งที่ปิดใช้งาน ${inactive.length} รายการ (${inactive.map(location => location.code).join(', ')})`} · <Link href={`/locations/qr?${new URLSearchParams({ ...Object.fromEntries(selectionQuery), ...(includeInactive ? {} : { include_inactive: '1' }) })}`}>{includeInactive ? 'ไม่รวมตำแหน่งที่ปิดใช้งาน' : 'รวมด้วย'}</Link></p>}
      <details className="surface p-4"><summary className="font-bold cursor-pointer min-h-11 flex items-center">เลือกตำแหน่งที่จะพิมพ์ ({labels.length} ป้าย)</summary>
        <form method="get" className="grid gap-3 mt-3"><input type="hidden" name="warehouse" value={warehouse.code}/>
          <fieldset className="grid sm:grid-cols-2 gap-x-6"><legend className="text-sm muted mb-1">ตำแหน่งที่ใช้งานใน {warehouse.name}</legend>
            {all.filter(location => location.active).map(location => <label key={location.id} className="flex items-center gap-3 min-h-11"><input type="checkbox" className="h-5 w-5" name="ids" value={location.id} defaultChecked={ids.includes(location.id)}/><span><span className="font-semibold">{locationBreadcrumb(location, byId)}</span> <span className="muted text-sm">{location.name}</span></span></label>)}
          </fieldset>
          <div className="flex flex-wrap gap-3"><button className="button">แสดงป้ายที่เลือก</button><Link className="button secondary" href={`/locations/qr?warehouse=${warehouse.code}`}>เลือกทั้งหมด</Link></div>
        </form></details>
      {labels.length > 0 && <div><PrintButton /></div>}
    </div>
    {labels.length === 0 ? <p className="notice print-hide">{ids.length ? 'ไม่พบตำแหน่งที่เลือกในคลังนี้' : 'ยังไม่มีตำแหน่งที่ใช้งานในคลังนี้'}</p> : <section className="label-sheet" aria-label="ป้าย QR ตำแหน่ง">
      {labels.map((location, index) => {
        const monitorId = resolveEnvironmentMonitor(location.id, all, configs);
        const monitor = monitorId ? byId.get(monitorId) : null;
        const ranges = monitorId === location.id ? describeEnvConfig(current.get(location.id) as EnvConfigRow | undefined) : null;
        const detail = [location.storage_condition, ranges?.temperature, ranges?.humidity].filter(Boolean).join(' · ');
        return <article className="location-label" key={location.id}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URI; next/image cannot optimise it */}
          <img src={qr[index]} alt={`QR ตำแหน่ง ${location.code}`} />
          <div className="location-label-text">
            <p className="location-label-code">{location.code}</p>
            <p className="location-label-name">{location.name}</p>
            <p className="location-label-meta">{warehouse.code}{detail ? ` · ${detail}` : ''}{!location.active ? ' · ปิดใช้งาน' : ''}</p>
            <p className="location-label-foot">{monitor && monitor.id !== location.id ? `ควบคุมสภาพแวดล้อมโดย ${monitor.code}` : 'สแกนเพื่อเปิดตำแหน่ง'}</p>
          </div>
        </article>;
      })}
    </section>}
  </main>;
}
