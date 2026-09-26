'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createLocationRecord, updateLocationRecord } from '@/app/actions/locations';
import { LOCATION_TYPES, isMonitorableType } from '@/lib/locations';
import { SubmitButton } from './submit-button';

export type LocationFormFields = {
  code: string; name: string; location_type: string; parent_location_id: string; room: string; description: string; storage_condition: string;
  portal_equipment_url: string; portal_equipment_label: string; own_monitoring: boolean;
  temperature_monitored: boolean; temp_min_c: string; temp_max_c: string; humidity_monitored: boolean; rh_min_pct: string; rh_max_pct: string;
};
export const EMPTY_LOCATION_FORM: LocationFormFields = {
  code: '', name: '', location_type: 'refrigerator', parent_location_id: '', room: '', description: '', storage_condition: '', portal_equipment_url: '', portal_equipment_label: '',
  own_monitoring: false, temperature_monitored: false, temp_min_c: '', temp_max_c: '', humidity_monitored: false, rh_min_pct: '', rh_max_pct: '',
};

type Props = {
  mode: 'create' | 'edit';
  warehouse: { id: number; code: string; name: string };
  initial: LocationFormFields;
  parents: { id: string; label: string }[];
  cancelHref: string;
  locationId?: string;
  expectedUpdatedAt?: string;
  codeLocked?: boolean;
  hasChildren?: boolean;
};

/** Phones often have no minus key on the decimal keypad, so every range field gets a sign toggle. */
function flipSign(text: string) { const value = text.trim(); return value.startsWith('-') ? value.slice(1) : `-${value}`; }

export function LocationForm({ mode, warehouse, initial, parents, cancelHref, locationId, expectedUpdatedAt, codeLocked = false, hasChildren = false }: Props) {
  const router = useRouter();
  const [value, setValue] = useState<LocationFormFields>(initial);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof LocationFormFields>(field: K, next: LocationFormFields[K]) => setValue(current => ({ ...current, [field]: next }));
  const monitorable = isMonitorableType(value.location_type);
  const showMonitoring = monitorable || value.own_monitoring;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    const data = new FormData();
    data.set('warehouse_id', String(warehouse.id));
    for (const [field, entry] of Object.entries(value)) if (typeof entry === 'string') data.set(field, entry); else if (entry) data.set(field, 'on');
    startTransition(async () => {
      const result = mode === 'create' ? await createLocationRecord(data) : await updateLocationRecord(locationId!, data, expectedUpdatedAt!);
      if (!result.ok) { setError(result.message); setErrors(result.errors ?? {}); return; }
      const done = mode === 'create' ? `เพิ่มตำแหน่ง ${value.code.trim()}` : 'บันทึกการแก้ไขแล้ว';
      router.push(`/locations/${result.id}?warehouse=${warehouse.code}&saved=${encodeURIComponent(done)}&at=${Date.now().toString(36)}`);
      router.refresh();
    });
  }

  const fieldError = (field: string) => errors[field] ? <p id={`error-${field}`} className="text-sm text-[#8c2534]" role="alert">{errors[field]}</p> : null;
  const describe = (field: string) => (errors[field] ? { 'aria-invalid': true, 'aria-describedby': `error-${field}` } as const : {});
  const range = (label: string, minField: 'temp_min_c' | 'rh_min_pct', maxField: 'temp_max_c' | 'rh_max_pct', unit: string) => (
    <div className="grid sm:grid-cols-2 gap-3">
      {([['ต่ำสุด', minField], ['สูงสุด', maxField]] as const).map(([side, field]) => <div key={field} className="grid gap-1">
        <label className="field" htmlFor={`f-${field}`}>{label} {side} ({unit})</label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <input id={`f-${field}`} className="input" inputMode="decimal" autoComplete="off" value={value[field]} onChange={event => set(field, event.target.value)} placeholder="ไม่จำกัด" {...describe(field)} />
          <button type="button" className="button secondary px-3" aria-label={`สลับเครื่องหมายบวก/ลบ ${label} ${side}`} onClick={() => set(field, flipSign(value[field]))}>±</button>
        </div>
        {fieldError(field)}
      </div>)}
    </div>
  );

  return <form onSubmit={submit} className="grid gap-5" noValidate>
    <section className="surface p-5 sm:p-7 grid gap-4 content-start">
      <h2 className="font-bold text-lg">ข้อมูลตำแหน่งใน {warehouse.name}</h2>
      <div className="grid sm:grid-cols-[200px_1fr] gap-4">
        <div className="grid gap-1"><label className="field" htmlFor="f-code">รหัสตำแหน่ง
          <input id="f-code" className="input" value={value.code} onChange={event => set('code', event.target.value)} required maxLength={40} readOnly={codeLocked} autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="เช่น CHE-FR-01" {...describe('code')} />
        </label>{codeLocked && <p className="muted text-xs">รหัสนี้ถูกใช้ในประวัติสต็อกแล้ว จึงแก้ไขไม่ได้</p>}{fieldError('code')}</div>
        <div className="grid gap-1"><label className="field" htmlFor="f-name">ชื่อ / คำอธิบายสั้น
          <input id="f-name" className="input" value={value.name} onChange={event => set('name', event.target.value)} required maxLength={120} placeholder="เช่น ตู้เย็นน้ำยา Chemistry 1" {...describe('name')} />
        </label>{fieldError('name')}</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="grid gap-1"><label className="field" htmlFor="f-type">ประเภท
          <select id="f-type" className="input" value={value.location_type} onChange={event => set('location_type', event.target.value)} {...describe('location_type')}>
            {LOCATION_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>{fieldError('location_type')}</div>
        <div className="grid gap-1"><label className="field" htmlFor="f-parent">วางอยู่ใน (ตำแหน่งแม่)
          <select id="f-parent" className="input" value={value.parent_location_id} onChange={event => set('parent_location_id', event.target.value)} disabled={hasChildren} {...describe('parent_location_id')}>
            <option value="">— ไม่มี (เป็นตำแหน่งหลัก) —</option>
            {parents.map(parent => <option key={parent.id} value={parent.id}>{parent.label}</option>)}
          </select>
        </label>{hasChildren ? <p className="muted text-xs">ตำแหน่งนี้มีตำแหน่งย่อย จึงเป็นตำแหน่งแม่ได้เท่านั้น (ซ้อนได้ 2 ระดับ)</p> : <p className="muted text-xs">เลือกตู้เย็น/ห้อง/ตู้ ที่ชั้นวางหรือแร็คนี้อยู่ · ซ้อนได้ 2 ระดับ</p>}{fieldError('parent_location_id')}</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="grid gap-1"><label className="field" htmlFor="f-room">ห้อง / พื้นที่
          <input id="f-room" className="input" value={value.room} onChange={event => set('room', event.target.value)} maxLength={120} placeholder="เช่น Clinical Chemistry" {...describe('room')} />
        </label>{fieldError('room')}</div>
        <div className="grid gap-1"><label className="field" htmlFor="f-storage">เงื่อนไขการเก็บ (ข้อความบนป้าย)
          <input id="f-storage" className="input" value={value.storage_condition} onChange={event => set('storage_condition', event.target.value)} maxLength={120} placeholder="เช่น 2–8 °C ป้องกันแสง" {...describe('storage_condition')} />
        </label>{fieldError('storage_condition')}</div>
      </div>
      <div className="grid gap-1"><label className="field" htmlFor="f-description">รายละเอียดเพิ่มเติม
        <textarea id="f-description" className="input" rows={3} value={value.description} onChange={event => set('description', event.target.value)} maxLength={1000} {...describe('description')} />
      </label>{fieldError('description')}</div>
    </section>

    <section className="surface p-5 sm:p-7 grid gap-4 content-start" aria-labelledby="monitoring-heading">
      <div><h2 id="monitoring-heading" className="font-bold text-lg">ช่วงอุณหภูมิ / ความชื้นที่ยอมรับได้</h2><p className="muted text-sm mt-1">กำหนดช่วงของตำแหน่งที่ต้องเฝ้าระวัง (ห้อง ตู้เย็น ตู้แช่แข็ง ตู้เก็บ) · ตำแหน่งย่อยอย่างชั้นวางใช้ค่าจากตำแหน่งแม่โดยอัตโนมัติ · เว้นค่าต่ำสุดหรือสูงสุดว่างได้ เช่น ตู้แช่แข็ง “≤ -20 °C”</p></div>
      {!monitorable && <label className="flex items-center gap-3 min-h-11 font-semibold"><input type="checkbox" className="h-5 w-5" checked={value.own_monitoring} onChange={event => set('own_monitoring', event.target.checked)} />ตั้งค่าเฝ้าระวังแยกสำหรับตำแหน่งนี้ (ปกติใช้ค่าจากตำแหน่งแม่)</label>}
      {showMonitoring ? <>
        <label className="flex items-center gap-3 min-h-11 font-semibold"><input type="checkbox" className="h-5 w-5" checked={value.temperature_monitored} onChange={event => set('temperature_monitored', event.target.checked)} />เฝ้าระวังอุณหภูมิ (°C)</label>
        {value.temperature_monitored && range('อุณหภูมิ', 'temp_min_c', 'temp_max_c', '°C')}
        <label className="flex items-center gap-3 min-h-11 font-semibold"><input type="checkbox" className="h-5 w-5" checked={value.humidity_monitored} onChange={event => set('humidity_monitored', event.target.checked)} />เฝ้าระวังความชื้นสัมพัทธ์ (%RH)</label>
        {value.humidity_monitored && range('ความชื้น', 'rh_min_pct', 'rh_max_pct', '%RH')}
      </> : <p className="muted text-sm">ตำแหน่งนี้ไม่ตั้งค่าเฝ้าระวังเอง</p>}
    </section>

    <section className="surface p-5 sm:p-7 grid gap-4 content-start" aria-labelledby="portal-heading">
      <div><h2 id="portal-heading" className="font-bold text-lg">เครื่องมือใน Lab Management Portal (ไม่บังคับ)</h2><p className="muted text-sm mt-1">เก็บเป็นลิงก์เท่านั้น · ข้อมูลเครื่องมือ การบำรุงรักษา (PM/CAL) และการซ่อมยังอยู่ที่ Portal</p></div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="grid gap-1"><label className="field" htmlFor="f-portal-url">ลิงก์หน้าเครื่องมือใน Portal
          <input id="f-portal-url" className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value.portal_equipment_url} onChange={event => set('portal_equipment_url', event.target.value)} maxLength={500} placeholder="https://…/staff/equipment/…" {...describe('portal_equipment_url')} />
        </label>{fieldError('portal_equipment_url')}</div>
        <div className="grid gap-1"><label className="field" htmlFor="f-portal-label">ชื่อเครื่องมือที่แสดง
          <input id="f-portal-label" className="input" value={value.portal_equipment_label} onChange={event => set('portal_equipment_label', event.target.value)} maxLength={120} placeholder="เช่น ตู้เย็นน้ำยา 1" {...describe('portal_equipment_label')} />
        </label>{fieldError('portal_equipment_label')}</div>
      </div>
    </section>

    {error && <p className="error" role="alert">{error}</p>}
    <div className="flex flex-wrap gap-3"><SubmitButton className="button" label={mode === 'create' ? 'เพิ่มตำแหน่ง' : 'บันทึกการแก้ไข'} pendingLabel="กำลังบันทึก…" pending={pending} /><Link className="button secondary" href={cancelHref}>ยกเลิก</Link></div>
  </form>;
}
