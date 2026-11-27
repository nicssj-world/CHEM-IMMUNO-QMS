import Link from 'next/link';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { ScanWorkbench } from '@/components/scan-workbench';

export default async function ScanPage({searchParams}:{searchParams:Promise<{warehouse?:string}>}) {
  const access = await requireAccess();
  void searchParams;
  return <main className="grid gap-6 max-w-3xl"><div><p className="eyebrow mb-2">Scan</p><h1 className="page-title">ตรวจ Barcode</h1><p className="muted text-sm">ตรวจ Product, LOT และวันหมดอายุโดยไม่เพิ่มยอด Stock</p></div>
    {access.warehouses.some(w => canMutate(w.role)) ? <section className="surface p-5 sm:p-7"><ScanWorkbench/></section> : <p className="notice">บัญชีนี้มีสิทธิ์อ่านอย่างเดียว</p>}
    <div className="flex gap-2 flex-wrap"><Link href="/receive" className="button">ไปหน้ารับเข้า</Link>{access.warehouses.some(w => canSupervise(w.role)) && <Link href="/scan/review" className="button secondary">คิวอนุมัติ Barcode</Link>}</div>
  </main>;
}
