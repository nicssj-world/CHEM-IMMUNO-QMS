'use client';

import { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import { AlertTriangle, CheckCircle2, Maximize2, Minimize2, X, XCircle } from 'lucide-react';
import { playScanTone, primeScanTone } from '@/lib/scan-tone';

/** A new `id` shows the result again, even when the text is the same as the last scan. */
export type ScanFeedback = { id: number; tone: 'ok' | 'warn' | 'error'; title: string; detail?: string };

const toneStyle = { ok: 'bg-emerald-700 text-white', warn: 'bg-amber-400 text-[#3b2a00]', error: 'bg-rose-700 text-white' } as const;
const toneIcon = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;

function FeedbackCard({ feedback, className = '' }: { feedback: ScanFeedback; className?: string }) {
  const Icon = toneIcon[feedback.tone];
  return <div aria-hidden className={`flex items-start gap-2 rounded-lg px-3 py-2 shadow-lg ${toneStyle[feedback.tone]} ${className}`}>
    <Icon size={20} className="mt-0.5 shrink-0" />
    <div className="min-w-0"><p className="font-bold text-sm leading-snug break-words">{feedback.title}</p>{feedback.detail && <p className="text-xs leading-snug opacity-90 break-words">{feedback.detail}</p>}</div>
  </div>;
}

/**
 * The continuous prop keeps the camera open across scans; a code held in view counts once, and counts again only after it left the frame.
 * With `dock`, the camera strip, the latest result and `summary` stay pinned to the top while the list below scrolls.
 */
export function BarcodeScanner({ onScan, continuous = false, dock = false, feedback, summary }: { onScan: (raw: string, symbology: string) => Promise<void> | void; continuous?: boolean; dock?: boolean; feedback?: ScanFeedback | null; summary?: React.ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const last = useRef<{ raw: string; at: number } | null>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [manual, setManual] = useState('');
  const [status, setStatus] = useState('กล้องยังไม่เปิด · พิมพ์หรือวาง Barcode ได้');

  useEffect(() => () => controls.current?.stop(), []);
  useEffect(() => { if (feedback) playScanTone(feedback.tone === 'ok'); }, [feedback]);

  function stop() {
    controls.current?.stop();
    controls.current = null;
    setActive(false);
  }

  async function accept(raw: string, symbology: string, fromCamera = false) {
    if (!raw.trim()) return;
    const now = Date.now();
    const previous = last.current;
    if (continuous) {
      // Every frame that still shows the same code refreshes the timestamp, so only a code that left the view can count again.
      if (fromCamera && previous?.raw === raw && now - previous.at < 1500) { previous.at = now; return; }
      last.current = { raw, at: now };
      navigator.vibrate?.(60);
      setStatus('อ่านแล้ว · สแกนชิ้นถัดไปได้เลย');
      await onScan(raw, symbology);
      return;
    }
    if (previous?.raw === raw && now - previous.at < 2500) { setStatus('สแกนซ้ำเร็วเกินไป · ตรวจรายการก่อนสแกนอีกครั้ง'); return; }
    last.current = { raw, at: now };
    stop();
    setStatus('อ่าน Barcode แล้ว · ตรวจ Product, LOT และวันหมดอายุก่อนบันทึก');
    await onScan(raw, symbology);
  }

  async function start() {
    if (!window.isSecureContext) { setStatus('กล้องต้องใช้ HTTPS; ใช้ช่องพิมพ์แทน'); return; }
    primeScanTone();
    setStatus('กำลังเปิดกล้องหลัง…');
    setActive(true);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      const hints = new Map<import('@zxing/library').DecodeHintType, boolean | import('@zxing/library').BarcodeFormat[]>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.DATA_MATRIX, BarcodeFormat.CODE_128]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints);
      controls.current = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' } } }, video.current!, (result) => {
        if (result) void accept(result.getText(), BarcodeFormat[result.getBarcodeFormat()] ?? 'camera', true);
      });
      setStatus(continuous ? 'เล็ง Barcode ทีละชิ้น · กล้องเปิดค้างไว้ต่อเนื่อง' : 'เล็ง Barcode ให้อยู่ในกรอบ');
    } catch {
      setActive(false);
      setStatus('เปิดกล้องไม่สำเร็จ · ตรวจสิทธิ์กล้องหรือใช้ช่องพิมพ์');
    }
  }

  const iconButton = 'grid place-items-center size-11 rounded-full bg-black/55 text-white backdrop-blur-sm';
  // Sticky is bounded by its parent box; `contents` lets the dock stay pinned across the list that follows the scanner.
  return <section className={dock ? 'contents' : 'grid gap-3'} aria-label="สแกน Barcode">
    <div className={`grid gap-2 ${dock && active ? 'scan-dock' : ''}`}>
      {!active && <div className="flex flex-wrap gap-2"><button type="button" className="button min-h-12" onClick={() => void start()}>{continuous ? 'เปิดกล้องสแกนต่อเนื่อง' : 'สแกนอีกครั้ง / เปิดกล้อง'}</button></div>}
      <div className={`relative w-full max-w-lg overflow-hidden rounded-xl bg-slate-900 ${active ? '' : 'hidden'}`}>
        <video ref={video} muted playsInline className={`block w-full object-cover ${expanded ? 'h-[min(60dvh,520px)]' : 'h-[clamp(150px,26dvh,220px)]'}`} aria-label="ภาพจากกล้องเพื่อสแกน Barcode"/>
        <div aria-hidden className="pointer-events-none absolute inset-0 m-auto aspect-square h-[62%] rounded-xl border-2 border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,.28)]" />
        {feedback ? <FeedbackCard key={feedback.id} feedback={feedback} className="scan-toast absolute inset-x-2 top-2" /> : <p aria-hidden className="absolute left-3 top-2 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white">เล็ง Barcode ในกรอบ</p>}
        <div className="absolute bottom-2 right-2 flex gap-2">
          <button type="button" className={iconButton} onClick={() => setExpanded(value => !value)} aria-label={expanded ? 'ย่อกล้อง' : 'ขยายกล้อง'} aria-pressed={expanded}>{expanded ? <Minimize2 size={18} aria-hidden /> : <Maximize2 size={18} aria-hidden />}</button>
          <button type="button" className={iconButton} onClick={stop} aria-label="หยุดกล้อง"><X size={20} aria-hidden /></button>
        </div>
      </div>
      {!active && feedback && <FeedbackCard feedback={feedback} />}
      {summary}
    </div>
    <p className="sr-only" aria-live="polite">{feedback ? `${feedback.title}${feedback.detail ? ` · ${feedback.detail}` : ''}` : ''}</p>
    <p className="muted text-sm" role="status">{status}</p>
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void accept(manual, 'manual'); setManual(''); manualInput.current?.focus(); }}><label className="field flex-1 min-w-48">พิมพ์หรือวาง Barcode<input ref={manualInput} className="input" value={manual} onChange={event => setManual(event.target.value)} autoCapitalize="off" autoComplete="off"/></label><button className="button secondary self-end" type="submit">ตรวจ Barcode</button></form>
  </section>;
}
