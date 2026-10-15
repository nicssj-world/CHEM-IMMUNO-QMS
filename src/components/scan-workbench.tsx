'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BarcodeScanner } from './barcode-scanner';
import { resolveProductScan, type ProductScan } from '@/app/actions/scanner';
import { userMessage } from '@/lib/messages';

const unrecognizedStandard = 'Unrecognized barcode standard; use manual Product search';

export function ScanWorkbench() {
  const [result, setResult] = useState<ProductScan | null>(null);
  const [error, setError] = useState('');

  const found = Boolean(result?.product);
  const plainIdentifier = found && result?.parsed.standard === 'UNKNOWN'
    && result.parsed.warnings.every(warning => warning === unrecognizedStandard);
  const warnings = result?.parsed.warnings.filter(warning => !(plainIdentifier && warning === unrecognizedStandard)) ?? [];

  return <div className="grid gap-4">
    <BarcodeScanner onScan={async (raw, symbology) => {
      setError('');
      setResult(null);
      try { setResult(await resolveProductScan(raw, symbology)); }
      catch (cause) { setError(userMessage(cause instanceof Error ? cause.message : null, 'สแกนไม่สำเร็จ')); }
    }} />
    {error && <p role="alert" className="error">{error}</p>}
    {result?.locationQr && <section className="notice grid gap-2">
      <strong>นี่คือ QR ตำแหน่งจัดเก็บ</strong>
      <p className="text-sm">ไม่ใช่ Barcode น้ำยา · ไม่มีการเปลี่ยนยอด Stock และไม่ถูกบันทึกเป็นข้อเสนอจับคู่ Barcode</p>
      {result.locationQr.path && <Link className="button" href={result.locationQr.path}>เปิดตำแหน่งนี้</Link>}
    </section>}
    {result && !result.locationQr && <section className="notice grid gap-2">
      <strong>{found ? `พบสินค้า ${result.product?.code}` : result.message ?? 'ไม่พบน้ำยา'}</strong>
      <p className="text-sm">รูปแบบข้อมูล: {plainIdentifier ? 'รหัสสินค้าเดี่ยว' : result.parsed.standard} · {result.parsed.symbology === 'manual' ? 'ป้อนด้วยมือ' : result.parsed.symbology}</p>
      <p className="text-sm">LOT {result.parsed.lot ?? '—'} · หมดอายุ {result.parsed.expiry ?? '—'}</p>
      {found && (!result.parsed.lot || !result.parsed.expiry) && <p className="text-sm">พบสินค้าแล้ว แต่รหัสที่ได้รับไม่มี LOT หรือวันหมดอายุครบถ้วน · กรุณาสแกน Data Matrix บนฉลากเพื่อดึงข้อมูลอัตโนมัติ</p>}
      <p className="text-xs break-all">Raw: {result.parsed.raw}</p>
      {warnings.map((warning, i) => <p key={i} role="alert">{warning}</p>)}
      <p className="text-xs">เป็นการตรวจสอบเท่านั้น ไม่มีการเปลี่ยนยอด Stock</p>
    </section>}
  </div>;
}
