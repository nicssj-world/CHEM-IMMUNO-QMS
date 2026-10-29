'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import { recordEnvironmentReading } from '@/app/actions/environment';
import { apparentOutOfRange, environmentRange, READING_LABEL, type MonitorConfig } from '@/lib/environment';

type Props = { locationId: string; warehouseCode: string; config: MonitorConfig; source: 'manual' | 'qr'; canLate: boolean };
const sign = (text: string) => text.trim().startsWith('-') ? text.trim().slice(1) : `-${text.trim()}`;

export function EnvironmentCheckForm({ locationId, warehouseCode, config, source, canLate }: Props) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [temp, setTemp] = useState('');
  const [humidity, setHumidity] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [observedLocal, setObservedLocal] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ overall_status: string; excursion_id: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const out = apparentOutOfRange(temp, config.temperature_monitored, config.temp_min_c, config.temp_max_c) ||
    apparentOutOfRange(humidity, config.humidity_monitored, config.rh_min_pct, config.rh_max_pct);
  const missing = (config.temperature_monitored && !temp.trim()) || (config.humidity_monitored && !humidity.trim());
  function save() {
    setError(null);
    startTransition(async () => {
      const saved = await recordEnvironmentReading({
        locationId, temperature: temp, humidity, source, note, reason, clientRequestId: requestId,
        observedAt: observedLocal ? `${observedLocal}:00+07:00` : undefined,
      });
      if (!saved.ok) { setError(saved.message); return; }
      setResult(saved.reading);
      setRequestId(crypto.randomUUID());
      setConfirming(false);
    });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missing && !reason.trim()) { setError('บันทึกไม่ครบต้องระบุเหตุผล'); return; }
    if (observedLocal && !reason.trim()) { setError('บันทึกย้อนหลังต้องระบุเหตุผล'); return; }
    if (out && !confirming) { setConfirming(true); return; }
    save();
  }
  if (result) return <section className={`surface p-6 grid gap-5 ${result.overall_status === 'out_of_range' ? 'border-2 border-amber-500' : ''}`} role="status">
    <div><p className="text-4xl" aria-hidden>{result.overall_status === 'out_of_range' ? '⚠' : '✓'}</p><h2 className="text-2xl font-bold">{READING_LABEL[result.overall_status] ?? result.overall_status}</h2><p className="muted">{result.overall_status === 'out_of_range' ? 'บันทึกแล้วและเปิด/ผูกเหตุการณ์นอกช่วง' : 'บันทึกค่าแล้ว'}</p></div>
    <div className="flex flex-wrap gap-2"><Link className="button" href={`/environment/check?warehouse=${warehouseCode}`}>สแกนตำแหน่งถัดไป</Link><Link className="button secondary" href={`/environment/check?warehouse=${warehouseCode}#due`}>ตำแหน่งที่ยังไม่ตรวจวันนี้</Link>{result.excursion_id && <Link className="button secondary" href={`/environment/excursions/${result.excursion_id}`}>ดูเหตุการณ์นอกช่วง</Link>}</div>
  </section>;
  return <form onSubmit={submit} className="surface p-5 sm:p-7 grid gap-5" noValidate>
    <div><h2 className="font-bold text-xl">บันทึกค่า</h2><p className="muted text-sm">ช่วงที่ยอมรับได้: {environmentRange(config)}</p></div>
    {config.temperature_monitored && <div className="grid gap-2"><label className="field" htmlFor="environment-temp">อุณหภูมิ (°C)</label><div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"><input id="environment-temp" className="input text-2xl min-h-14" inputMode="decimal" autoComplete="off" autoFocus value={temp} onChange={event => setTemp(event.target.value)}/><button type="button" className="button secondary" onClick={() => setTemp(sign(temp))} aria-label="สลับเครื่องหมายอุณหภูมิ">±</button></div>{temp && <p className={apparentOutOfRange(temp, true, config.temp_min_c, config.temp_max_c) ? 'text-amber-700 text-sm' : 'muted text-sm'}>{apparentOutOfRange(temp, true, config.temp_min_c, config.temp_max_c) ? '⚠ ค่านี้อาจอยู่นอกช่วง' : '✓ ค่านี้อยู่ในช่วงที่ตั้งไว้'}</p>}</div>}
    {config.humidity_monitored && <div className="grid gap-2"><label className="field" htmlFor="environment-humidity">ความชื้นสัมพัทธ์ (%RH)</label><input id="environment-humidity" className="input text-2xl min-h-14" inputMode="decimal" autoComplete="off" value={humidity} onChange={event => setHumidity(event.target.value)}/>{humidity && <p className={apparentOutOfRange(humidity, true, config.rh_min_pct, config.rh_max_pct) ? 'text-amber-700 text-sm' : 'muted text-sm'}>{apparentOutOfRange(humidity, true, config.rh_min_pct, config.rh_max_pct) ? '⚠ ค่านี้อาจอยู่นอกช่วง' : '✓ ค่านี้อยู่ในช่วงที่ตั้งไว้'}</p>}</div>}
    {canLate && <label className="field">เวลาที่สังเกต (เวลาไทย; เว้นว่าง = ตอนนี้)<input className="input" type="datetime-local" value={observedLocal} onChange={event => setObservedLocal(event.target.value)}/></label>}
    {(missing || observedLocal || confirming) && <label className="field">เหตุผล{confirming && !missing && !observedLocal ? ' / การดำเนินการเบื้องต้น (ถ้ามี)' : ''}<textarea className="input" rows={2} value={reason} onChange={event => setReason(event.target.value)} required={missing || Boolean(observedLocal)} maxLength={1000}/></label>}
    <label className="field">หมายเหตุเพิ่มเติม (ไม่บังคับ)<textarea className="input" rows={2} value={note} onChange={event => setNote(event.target.value)} maxLength={1000}/></label>
    {confirming && <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950" role="alert"><strong>ค่าอยู่นอกช่วง {environmentRange(config)} — ยืนยันบันทึก?</strong><p className="text-sm mt-1">ระบบจะเก็บค่าจริงและเปิดเหตุการณ์นอกช่วงให้ติดตาม</p><button type="button" className="button secondary mt-3" onClick={() => setConfirming(false)}>กลับไปแก้ค่า</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
    <button type="submit" className="button justify-self-start min-w-32" disabled={pending}>{pending ? 'กำลังบันทึก…' : confirming ? 'ยืนยันบันทึก' : 'บันทึก'}</button>
  </form>;
}
