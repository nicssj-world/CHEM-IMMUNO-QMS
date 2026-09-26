import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil, Printer, Thermometer } from 'lucide-react';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { rotateLocationQr, setLocationActive } from '@/app/actions/locations';
import { ConfirmForm } from '@/components/confirm-form';
import { LocationTypeIcon } from '@/components/location-type-icon';
import { PortalLink } from '@/components/portal-link';
import { expiryBucket, type ExpiryBucket } from '@/lib/inventory-insights';
import { formatDate, formatDateTime } from '@/lib/format';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { unitLabel } from '@/lib/units';
import {
  ENV_CONFIG_COLUMNS, LOCATION_COLUMNS, buildLocationStock, describeEnvConfig, locationTypeLabel,
  type BalanceRow, type EnvConfigRow, type LocationRow, type StockProduct,
} from '@/lib/locations';
import { latestConfigByLocation, resolveEnvironmentMonitor } from '@/lib/environment-monitor';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const expiryLabels: Record<ExpiryBucket, string> = { EXPIRED: 'หมดอายุแล้ว', '≤30': 'หมดอายุใน 30 วัน', '31–60': 'หมดอายุใน 31–60 วัน', '61–90': 'หมดอายุใน 61–90 วัน', '>90': '' };

export default async function LocationDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client || !uuid.test(id)) notFound();
  const { data } = await client.from('ci_locations').select(LOCATION_COLUMNS).eq('id', id).maybeSingle();
  const location = data as LocationRow | null;
  // Row-level security hides other warehouses' locations, so "not readable" and "does not exist" are the same answer.
  const warehouse = location && access.warehouses.find(item => Number(item.id) === location.warehouse_id);
  if (!location || !warehouse) notFound();
  const canManage = canSupervise(warehouse.role);

  const [locationResult, configResult] = await Promise.all([
    client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouse.id).order('code'),
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('warehouse_id', warehouse.id),
  ]);
  const all = (locationResult.data ?? []) as LocationRow[];
  const configs = (configResult.data ?? []) as EnvConfigRow[];
  const byId = new Map(all.map(item => [item.id, item]));
  const parent = location.parent_location_id ? byId.get(location.parent_location_id) : undefined;
  const children = all.filter(item => item.parent_location_id === id);
  const scope = [location, ...children];

  // Stock is read from the signed ledger through the balance view: this container plus its direct children, never a stored total.
  const balanceResult = await client.from('ci_stock_balances').select('product_id,lot_id,lot_number,expiry_date,location_id,balance').in('location_id', scope.map(item => item.id)).neq('balance', 0);
  const balances = (balanceResult.data ?? []) as BalanceRow[];
  const productIds = [...new Set(balances.map(row => row.product_id))];
  const productResult = productIds.length ? await client.from('ci_products').select('id,product_code,display_name,base_stock_unit').in('id', productIds) : { data: [], error: null };
  const stock = buildLocationStock(balances, (productResult.data ?? []) as StockProduct[], new Map(scope.map(item => [item.id, item.code])));
  const stockError = balanceResult.error ?? productResult.error;

  const monitorId = resolveEnvironmentMonitor(id, all, configs);
  const monitor = monitorId ? byId.get(monitorId) : undefined;
  const ranges = monitorId ? describeEnvConfig(latestConfigByLocation(configs).get(monitorId) as EnvConfigRow | undefined) : null;
  const here = `?warehouse=${warehouse.code}`;
  const showSubLocation = children.length > 0;

  return <main className="grid gap-6 max-w-[980px]">
    <div><p className="eyebrow mb-2">Storage location</p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h1 className="page-title flex items-center gap-3"><LocationTypeIcon type={location.location_type} size={26} className="text-[var(--teal)] shrink-0" /><span className="break-words">{parent ? <><Link href={`/locations/${parent.id}${here}`}>{parent.code}</Link> › </> : null}{location.code}</span></h1><p className="mt-1 font-semibold">{location.name}</p></div>
        <div className="flex flex-wrap gap-2 print-hide">
          {canManage && <Link className="button secondary" href={`/locations/${id}/edit${here}`}><Pencil size={16} aria-hidden />แก้ไข</Link>}
          {canManage && <Link className="button secondary" href={`/locations/qr?warehouse=${warehouse.code}&ids=${id}`}><Printer size={16} aria-hidden />พิมพ์ QR</Link>}
          <PortalLink url={location.portal_equipment_url} label={location.portal_equipment_label} />
          {parent?.portal_equipment_url && !location.portal_equipment_url ? <PortalLink url={parent.portal_equipment_url} label={parent.portal_equipment_label} context={`ของ ${parent.code}`} /> : null}
        </div>
      </div>
    </div>
    {query.error && <p className="error" role="alert">{query.error}</p>}{query.saved && <p className="notice" role="status">{savedNotice(query.saved, 'บันทึกแล้ว')}</p>}
    {!location.active && <p className="error" role="status">ตำแหน่งนี้ปิดการใช้งานอยู่ · รับเข้า ย้ายเข้า และปรับยอดเข้าตำแหน่งนี้ไม่ได้</p>}

    <section className="surface p-5 sm:p-7 grid gap-3" aria-labelledby="details-heading"><h2 id="details-heading" className="font-bold text-lg">ข้อมูลตำแหน่ง</h2>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div><dt className="muted">ประเภท</dt><dd className="font-semibold">{locationTypeLabel(location.location_type)}</dd></div>
        <div><dt className="muted">คลัง</dt><dd className="font-semibold">{warehouse.name}</dd></div>
        <div><dt className="muted">ห้อง / พื้นที่</dt><dd className="font-semibold">{location.room ?? '—'}</dd></div>
        <div><dt className="muted">เงื่อนไขการเก็บ</dt><dd className="font-semibold">{location.storage_condition ?? '—'}</dd></div>
        <div><dt className="muted">สถานะ</dt><dd><span className="badge">{location.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></dd></div>
        <div><dt className="muted">แก้ไขล่าสุด</dt><dd className="font-semibold">{formatDateTime(location.updated_at)}</dd></div>
        {location.description && <div className="sm:col-span-2"><dt className="muted">รายละเอียด</dt><dd className="whitespace-pre-line">{location.description}</dd></div>}
      </dl>
    </section>

    <section className="surface p-5 sm:p-7 grid gap-3" aria-labelledby="environment-heading"><h2 id="environment-heading" className="font-bold text-lg flex items-center gap-2"><Thermometer size={20} aria-hidden className="text-[var(--teal)]" />สภาพแวดล้อม (ช่วงที่ยอมรับได้)</h2>
      {monitor && monitor.id === id ? <p>ตำแหน่งนี้มีการเฝ้าระวังอุณหภูมิ/ความชื้นเอง</p>
        : monitor ? <p>สภาพแวดล้อมควบคุมโดย <Link className="font-bold" href={`/locations/${monitor.id}${here}`}>{monitor.code}</Link> · {monitor.name}</p>
        : <p className="muted">ไม่ได้ตั้งค่าการเฝ้าระวังอุณหภูมิ/ความชื้น</p>}
      {ranges && (ranges.temperature || ranges.humidity) && <dl className="grid sm:grid-cols-2 gap-3 text-sm">
        {ranges.temperature && <div><dt className="muted">อุณหภูมิที่ยอมรับได้</dt><dd className="text-lg font-bold">{ranges.temperature}</dd></div>}
        {ranges.humidity && <div><dt className="muted">ความชื้นสัมพัทธ์ที่ยอมรับได้</dt><dd className="text-lg font-bold">{ranges.humidity}</dd></div>}
      </dl>}
    </section>

    <section className="surface overflow-hidden" aria-labelledby="stock-heading"><div className="px-5 py-4 flex justify-between gap-3"><h2 id="stock-heading" className="font-bold">สินค้าคงเหลือ{showSubLocation ? ' (รวมตำแหน่งย่อย)' : ''}</h2><span className="muted text-sm">{stock.length} รายการ LOT</span></div>
      {stockError && <p className="error mx-5 mb-4" role="alert">อ่านยอดคงเหลือไม่สำเร็จ: {logUserMessage('locationStock', stockError)}</p>}
      {stock.length ? <>
        <div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>สินค้า</th><th>LOT</th><th>หมดอายุ</th><th>จำนวน</th>{showSubLocation && <th>ตำแหน่ง</th>}</tr></thead><tbody>{stock.map(row => { const bucket = expiryBucket(row.expiry_date); return <tr key={row.key}><td><span className="font-bold">{row.product_code}</span><br/><span className="muted text-sm">{row.product_name}</span></td><td>{row.lot_number}</td><td>{formatDate(row.expiry_date)}{expiryLabels[bucket] && <> <span className="badge">{expiryLabels[bucket]}</span></>}</td><td className="font-bold">{row.quantity.toLocaleString()} {unitLabel(row.unit)}</td>{showSubLocation && <td>{row.location_code}</td>}</tr>; })}</tbody></table></div>
        <ul className="mobile-card-list px-4 pb-4">{stock.map(row => { const bucket = expiryBucket(row.expiry_date); return <li key={row.key} className="rounded-xl border border-line p-3 grid gap-1"><p className="font-bold">{row.product_code} <span className="font-normal muted">{row.product_name}</span></p><p className="text-sm">LOT {row.lot_number} · หมดอายุ {formatDate(row.expiry_date)}{expiryLabels[bucket] && <> <span className="badge">{expiryLabels[bucket]}</span></>}</p><p className="text-sm font-bold">{row.quantity.toLocaleString()} {unitLabel(row.unit)}{showSubLocation ? <span className="font-normal muted"> · {row.location_code}</span> : null}</p></li>; })}</ul>
      </> : <p className="muted px-5 pb-5">ไม่มีสินค้าคงเหลือในตำแหน่งนี้</p>}
    </section>

    {children.length > 0 && <section className="surface overflow-hidden" aria-labelledby="children-heading"><div className="px-5 py-4"><h2 id="children-heading" className="font-bold">ตำแหน่งย่อยในตำแหน่งนี้</h2></div>
      <ul>{children.map(child => <li key={child.id} className="border-t border-line"><Link href={`/locations/${child.id}${here}`} className="flex items-center justify-between gap-3 px-5 py-3 min-h-14 no-underline text-[var(--ink)] hover:bg-surface-2"><span className="flex items-center gap-3 min-w-0"><LocationTypeIcon type={child.location_type} className="text-[var(--teal)] shrink-0" /><span className="min-w-0"><span className="font-bold">{child.code}</span><span className="muted text-sm block truncate">{child.name}</span></span></span><span className="flex gap-1 shrink-0"><span className="badge">{locationTypeLabel(child.location_type)}</span><span className="badge">{child.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></span></Link></li>)}</ul>
    </section>}

    {canManage && <section className="surface p-5 sm:p-7 grid gap-5 print-hide" aria-labelledby="manage-heading"><h2 id="manage-heading" className="font-bold text-lg">จัดการตำแหน่ง</h2>
      <ConfirmForm action={setLocationActive} className="grid gap-3 sm:grid-cols-[1fr_auto] items-end" message={location.active ? `ปิดการใช้งานตำแหน่ง ${location.code}?` : `เปิดใช้งานตำแหน่ง ${location.code} อีกครั้ง?`}>
        <input type="hidden" name="id" value={id}/><input type="hidden" name="active" value={String(!location.active)}/>
        <label className="field">{location.active ? 'เหตุผลที่ปิดการใช้งาน' : 'เหตุผลที่เปิดใช้งานอีกครั้ง'}<input className="input" name="reason" required maxLength={200} placeholder={location.active ? 'เช่น เลิกใช้ตู้นี้แล้ว' : 'เช่น นำกลับมาใช้'}/></label>
        <button className={`button ${location.active ? 'danger' : ''}`}>{location.active ? 'ปิดการใช้งาน' : 'เปิดใช้งานอีกครั้ง'}</button>
        {location.active && <p className="muted text-xs sm:col-span-2">ปิดได้เมื่อไม่มีสินค้าคงเหลือและไม่มีตำแหน่งย่อยที่ยังใช้งานอยู่ · ประวัติเดิมทั้งหมดยังคงอยู่</p>}
      </ConfirmForm>
      <ConfirmForm action={rotateLocationQr} className="grid gap-3 sm:grid-cols-[1fr_auto] items-end border-t border-line pt-5" message={`เปลี่ยน QR ของ ${location.code}? ป้ายที่พิมพ์ไว้เดิมจะสแกนไม่ได้อีก`}>
        <input type="hidden" name="id" value={id}/>
        <label className="field">เหตุผลที่เปลี่ยน QR<input className="input" name="reason" required maxLength={200} placeholder="เช่น ป้ายชำรุด หรือถูกถ่ายรูปเผยแพร่"/></label>
        <button className="button secondary">เปลี่ยน QR ใหม่</button>
        <p className="muted text-xs sm:col-span-2">QR ใหม่มีผลทันที · ป้ายเดิมจะแสดงว่าไม่พบตำแหน่ง · ต้องพิมพ์ป้ายใหม่มาติดแทน</p>
      </ConfirmForm>
    </section>}
  </main>;
}
