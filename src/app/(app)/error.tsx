'use client';

import Link from 'next/link';
import { useEffect } from 'react';

// Renders inside the app shell, so the menus stay usable while the failed page can be retried.
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <main className="grid gap-5 max-w-[640px]">
    <div><p className="eyebrow mb-2">เกิดข้อผิดพลาด</p><h1 className="page-title">โหลดหน้านี้ไม่สำเร็จ</h1></div>
    <div className="error grid gap-2" role="alert"><p>ระบบอ่านข้อมูลไม่สำเร็จ อาจเป็นเพราะสัญญาณเครือข่ายหรือเซิร์ฟเวอร์ขัดข้องชั่วคราว ข้อมูลที่บันทึกไว้แล้วไม่ได้รับผลกระทบ</p>{error.digest && <p className="text-xs">รหัสอ้างอิงสำหรับแจ้งผู้ดูแลระบบ: <span className="font-mono">{error.digest}</span></p>}</div>
    <div className="flex flex-wrap gap-2"><button type="button" className="button" onClick={() => retry()}>ลองใหม่</button><Link className="button secondary" href="/">กลับหน้าภาพรวม</Link></div>
  </main>;
}
