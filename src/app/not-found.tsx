import Link from 'next/link';

export default function NotFound() {
  return <main className="min-h-dvh grid place-items-center p-6">
    <div className="surface p-7 grid gap-4 max-w-md w-full">
      <p className="eyebrow">ไม่พบหน้า (404)</p>
      <h1 className="page-title">ไม่พบข้อมูลที่ต้องการ</h1>
      <p className="muted">ลิงก์อาจไม่ถูกต้อง หรือรายการนี้ถูกลบ ปิดใช้งาน หรืออยู่ในคลังที่บัญชีนี้ไม่มีสิทธิ์</p>
      <div className="flex flex-wrap gap-2"><Link className="button" href="/">กลับหน้าภาพรวม</Link><Link className="button secondary" href="/products">ค้นหาสินค้า</Link></div>
    </div>
  </main>;
}
