'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BarcodeScanner } from './barcode-scanner';
import { resolveScan, type ScanResolution } from '@/app/actions/scanner';
import { userMessage } from '@/lib/messages';

export function ScanWorkbench({warehouseId}:{warehouseId:number}) {
  const [result,setResult] = useState<ScanResolution | null>(null);
  const [error,setError] = useState('');
  return <div className="grid gap-4"><BarcodeScanner onScan={async(raw,symbology)=>{try{setError('');setResult(await resolveScan(raw,symbology,warehouseId));}catch(cause){setError(userMessage(cause instanceof Error?cause.message:null,'สแกนไม่สำเร็จ'));}}}/>
    {error && <p role="alert" className="error">{error}</p>}{result?.locationQr && <section className="notice grid gap-2"><strong>นี่คือ QR ตำแหน่งจัดเก็บ</strong><p className="text-sm">ไม่ใช่ Barcode สินค้า · ไม่มีการเปลี่ยนยอด Stock และไม่ถูกบันทึกเป็นข้อเสนอจับคู่ Barcode</p>{result.locationQr.path && <Link className="button" href={result.locationQr.path}>เปิดตำแหน่งนี้</Link>}</section>}{result && !result.locationQr && <section className="notice grid gap-2"><strong>{result.productCode ?? result.message ?? 'ไม่พบสินค้า'}</strong><p className="text-sm">{result.parsed.standard} · {result.parsed.symbology}</p><p className="text-sm">LOT {result.parsed.lot ?? '—'} · หมดอายุ {result.parsed.expiry ?? '—'}</p><p className="text-xs break-all">Raw: {result.parsed.raw}</p>{result.parsed.warnings.map((item,i)=><p key={i} role="alert">{item}</p>)}<p className="text-xs">เป็นร่างตรวจสอบเท่านั้น ไม่มีการเปลี่ยนยอด Stock</p></section>}
  </div>;
}
