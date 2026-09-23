'use client';

import { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';

export function BarcodeScanner({ onScan }: { onScan: (raw: string, symbology: string) => Promise<void> | void }) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const last = useRef<{ raw: string; at: number } | null>(null);
  const [active, setActive] = useState(false);
  const [manual, setManual] = useState('');
  const [status, setStatus] = useState('กล้องยังไม่เปิด · พิมพ์หรือวาง Barcode ได้');

  useEffect(() => () => controls.current?.stop(), []);

  async function accept(raw: string, symbology: string) {
    if (!raw.trim()) return;
    const now = Date.now();
    if (last.current?.raw === raw && now - last.current.at < 2500) { setStatus('สแกนซ้ำเร็วเกินไป · ตรวจรายการก่อนสแกนอีกครั้ง'); return; }
    last.current = { raw, at: now };
    controls.current?.stop();
    controls.current = null;
    setActive(false);
    setStatus('อ่าน Barcode แล้ว · ตรวจ Product, LOT และวันหมดอายุก่อนบันทึก');
    await onScan(raw, symbology);
  }

  async function start() {
    if (!window.isSecureContext) { setStatus('กล้องต้องใช้ HTTPS; ใช้ช่องพิมพ์แทน'); return; }
    setStatus('กำลังเปิดกล้องหลัง…');
    setActive(true);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      const hints = new Map<import('@zxing/library').DecodeHintType, boolean | import('@zxing/library').BarcodeFormat[]>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.DATA_MATRIX, BarcodeFormat.CODE_128]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints);
      controls.current = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' } } }, video.current!, (result) => {
        if (result) void accept(result.getText(), BarcodeFormat[result.getBarcodeFormat()] ?? 'camera');
      });
      setStatus('เล็ง Barcode ให้อยู่ในกรอบ');
    } catch {
      setActive(false);
      setStatus('เปิดกล้องไม่สำเร็จ · ตรวจสิทธิ์กล้องหรือใช้ช่องพิมพ์');
    }
  }

  return <section className="grid gap-3" aria-label="สแกน Barcode">
    <div className="flex flex-wrap gap-2"><button type="button" className="button min-h-12" onClick={() => void start()}>{active ? 'กล้องกำลังทำงาน' : 'สแกนอีกครั้ง / เปิดกล้อง'}</button>{active && <button type="button" className="button secondary" onClick={() => { controls.current?.stop(); controls.current=null; setActive(false); }}>หยุดกล้อง</button>}</div>
    <video ref={video} muted playsInline className={`w-full max-w-lg rounded-xl bg-slate-900 ${active ? '' : 'hidden'}`} aria-label="ภาพจากกล้องเพื่อสแกน Barcode"/>
    <p className="muted text-sm" role="status">{status}</p>
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void accept(manual, 'manual'); setManual(''); }}><label className="field flex-1 min-w-48">พิมพ์หรือวาง Barcode<input className="input" value={manual} onChange={event => setManual(event.target.value)} autoCapitalize="off" autoComplete="off"/></label><button className="button secondary self-end" type="submit">ตรวจ Barcode</button></form>
  </section>;
}
