'use client';

import './globals.css';

// Replaces the root layout when it fails, so it carries its own document; styles come from the stylesheet because the production CSP blocks inline style attributes.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <html lang="th">
    <body>
      <title>เกิดข้อผิดพลาด · CHEM-IMMUNO CBH</title>
      <main className="min-h-dvh grid place-items-center p-6">
        <div className="surface p-7 grid gap-4 max-w-md w-full">
          <h1 className="page-title">ระบบขัดข้องชั่วคราว</h1>
          <p>เปิดระบบไม่สำเร็จ ข้อมูลที่บันทึกไว้แล้วไม่ได้รับผลกระทบ กรุณาลองใหม่อีกครั้ง</p>
          {error.digest && <p className="muted text-xs">รหัสอ้างอิง: <span className="font-mono">{error.digest}</span></p>}
          <button type="button" className="button" onClick={() => retry()}>ลองใหม่</button>
        </div>
      </main>
    </body>
  </html>;
}
