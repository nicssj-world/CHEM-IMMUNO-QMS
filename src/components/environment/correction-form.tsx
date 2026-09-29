'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { correctEnvironmentReading } from '@/app/actions/environment';
import type { EnvironmentReading } from '@/lib/environment';

export function EnvironmentCorrectionForm({ reading }: { reading: EnvironmentReading }) {
  const [kind, setKind] = useState<'correction' | 'void'>('correction');
  const [temp, setTemp] = useState(reading.temperature_c === null ? '' : String(reading.temperature_c));
  const [humidity, setHumidity] = useState(reading.humidity_rh === null ? '' : String(reading.humidity_rh));
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await correctEnvironmentReading({ readingId: reading.id, entryKind: kind,
        temperature: kind === 'correction' ? temp : '', humidity: kind === 'correction' ? humidity : '', reason, clientRequestId: requestId });
      setMessage(result.ok ? 'บันทึกหลักฐานการแก้ไขแล้ว · โหลดหน้าใหม่เพื่อดูประวัติทั้งหมด' : result.message);
    });
  }
  return <form onSubmit={submit} className="grid gap-2 border-t border-line pt-3"><div className="flex gap-3"><label><input type="radio" checked={kind === 'correction'} onChange={() => setKind('correction')}/> แก้ไขค่า</label><label><input type="radio" checked={kind === 'void'} onChange={() => setKind('void')}/> ยกเลิกข้อมูล</label></div>
    {kind === 'correction' && <div className="grid sm:grid-cols-2 gap-2"><label className="field">อุณหภูมิ °C<input className="input" inputMode="decimal" value={temp} onChange={event => setTemp(event.target.value)}/></label><label className="field">ความชื้น %RH<input className="input" inputMode="decimal" value={humidity} onChange={event => setHumidity(event.target.value)}/></label></div>}
    <label className="field">เหตุผล<input className="input" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}/></label>
    {message && <p role="status" className="text-sm">{message}</p>}<button className="button secondary justify-self-start" disabled={pending}>{pending ? 'กำลังบันทึก…' : kind === 'void' ? 'ยืนยันยกเลิกข้อมูล' : 'ยืนยันแก้ไข'}</button>
  </form>;
}
