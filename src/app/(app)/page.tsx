import Link from 'next/link';
import { Boxes, PackagePlus, ArrowUpFromLine, ClipboardCheck, AlertTriangle } from 'lucide-react';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, (await searchParams).warehouse);
  const client = await createClient();
  const [products, locations, lots] = client ? await Promise.all([
    client.from('ci_products').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).eq('active', true),
    client.from('ci_locations').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id).eq('active', true),
    client.from('ci_stock_lots').select('id', { count: 'exact', head: true }).eq('warehouse_id', warehouse.id),
  ]) : [{ count: null }, { count: null }, { count: null }];
  const cards = [
    { label: 'สินค้าที่ใช้งาน', count: products.count, icon: Boxes },
    { label: 'ตำแหน่งจัดเก็บ', count: locations.count, icon: ClipboardCheck },
    { label: 'LOT ที่บันทึก', count: lots.count, icon: PackagePlus },
  ];
  return <main className="grid gap-7">
    <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="eyebrow mb-2">Warehouse overview</p><h1 className="page-title">ภาพรวมคลัง</h1><p className="muted mt-2 text-sm">ข้อมูลของคลังที่คุณมีสิทธิ์เข้าถึง</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse}/></div>
    <div className="grid gap-3 sm:grid-cols-3">{cards.map(({ label,count,icon:Icon }) => <div className="surface p-5" key={label}><div className="flex items-center justify-between"><p className="muted text-sm font-semibold">{label}</p><Icon size={18} className="text-[#09958f]"/></div><p className="text-3xl font-extrabold mt-4">{count ?? '—'}</p></div>)}</div>
    <section className="surface p-5 sm:p-7"><div className="flex items-center gap-3 mb-5"><div className="h-10 w-10 rounded-xl bg-[#e8f5f5] text-[#068984] flex items-center justify-center"><Boxes size={20}/></div><div><h2 className="font-bold text-lg">ทำงานกับคลัง {warehouse.name}</h2><p className="muted text-sm">เลือกงานที่ต้องทำ</p></div></div><div className="grid gap-3 sm:grid-cols-3"><Link href={`/products?warehouse=${warehouse.code}`} className="button secondary">ค้นหาสินค้า</Link><Link href={`/receive?warehouse=${warehouse.code}`} className="button"><PackagePlus size={18}/>รับเข้า</Link><Link href={`/issue?warehouse=${warehouse.code}`} className="button secondary"><ArrowUpFromLine size={18}/>เบิกใช้</Link></div></section>
    <div className="notice flex items-start gap-3"><AlertTriangle size={18} className="shrink-0 mt-0.5"/><p className="text-sm">ตัวเลขสรุป stock, reorder และ expiry จะเปิดใช้พร้อม Dashboard เต็มรูปแบบใน Phase 3 ข้อมูลธุรกรรมและยอดคงเหลือจริงอยู่ในหน้า Stock และ Movement</p></div>
  </main>;
}
