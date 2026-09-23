import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';

export default async function MorePage() {
  const access = await requireAccess();
  const canWork = access.warehouses.some(w=>w.role!=='viewer');
  const supervisor = access.warehouses.some(w=>canSupervise(w.role));
  const links = [
    ['/products','สินค้า'],['/attention','Need Attention'],['/reorder','ROP / สั่งซื้อ'],['/vendors','ผู้ขาย'],['/reports/monthly','รายงานรายเดือน'],
    ['/movements','ประวัติ Stock'],['/counts','ตรวจนับ'],['/issue','เบิกใช้'],['/transfer','ย้ายที่เก็บ'],['/adjust','ปรับยอด'],['/dispose','กำจัดหมดอายุ'],
  ];
  return <main className="grid gap-5"><div><p className="eyebrow mb-2">More</p><h1 className="page-title">งานเพิ่มเติม</h1></div><nav aria-label="งานเพิ่มเติม" className="grid sm:grid-cols-2 gap-3">{links.filter(([href])=>!['/issue','/transfer','/counts'].includes(href)||canWork).filter(([href])=>!['/adjust','/dispose'].includes(href)||supervisor).map(([href,label])=><Link key={href} href={href} className="surface p-4 min-h-12 no-underline text-[var(--ink)] font-semibold">{label} →</Link>)}</nav></main>;
}
