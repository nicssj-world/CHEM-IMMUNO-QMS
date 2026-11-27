import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { createProduct } from '@/app/actions/products';
import { SubmitButton } from '@/components/submit-button';
import { ProductDefaultLocationField } from '@/components/product-default-location-field';

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; error?: string }> }) {
  const access = await requireAccess();
  const params = await searchParams;
  const warehouse = selectedWarehouse(access, params.warehouse);
  if (!access.warehouses.some(w => canSupervise(w.role))) return <p className="error">สิทธิ์ของคุณไม่อนุญาตให้เพิ่มน้ำยาในคลังนี้</p>;
  const supervisedWarehouses = access.warehouses.filter(w => canSupervise(w.role));
  const client = await createClient();
  const locationResult = client ? await client.from('ci_locations').select('id,warehouse_id,code,name,parent_location_id').eq('active', true).order('code').limit(400) : { data: [] };
  const locations = locationResult.data ?? [];
  return <main className="grid gap-6 max-w-[820px]"><div><Link href="/products" className="muted text-sm">← น้ำยาทั้งหมด</Link><p className="eyebrow mt-5 mb-2">Product master</p><h1 className="page-title">เพิ่มน้ำยา</h1><p className="muted text-sm mt-2">เลือกกลุ่มรหัส CHE หรือ IMM เพื่อให้ระบบสร้าง Product Code โดยอัตโนมัติ · ข้อมูลอยู่ในคลังน้ำยากลางเดียวกัน</p></div>{params.error && <p className="error" role="alert">{params.error}</p>}
    <form action={createProduct} className="surface p-5 sm:p-7 grid gap-5">
      <ProductDefaultLocationField warehouses={supervisedWarehouses.map(w => ({ id: Number(w.id), name: w.code === 'CHE' ? 'CHE — Chemistry' : 'IMM — Immunology' }))} locations={locations} defaultWarehouseId={Number(warehouse.id)}/>
      <div className="grid sm:grid-cols-2 gap-5"><label className="field">ชื่อน้ำยาตามแหล่งข้อมูล<input className="input" name="source_name" required maxLength={300}/></label><label className="field">ชื่อที่แสดง<input className="input" name="display_name" required maxLength={300}/></label></div><div className="grid sm:grid-cols-2 gap-5"><label className="field">ประเภท<select className="input" name="product_type" required><option value="reagent">Reagent</option><option value="calibrator">Calibrator</option><option value="control">Control</option><option value="consumable">Consumable</option></select></label><label className="field">ขนาดบรรจุ (ข้อความต้นฉบับ)<input className="input" name="packing_size_raw" maxLength={300}/></label></div><div className="grid sm:grid-cols-2 gap-5"><label className="field">REF ปัจจุบัน<input className="input" name="current_ref" required inputMode="text"/></label><label className="field">Manufacturer barcode<input className="input" name="manufacturer_barcode" required inputMode="text"/></label></div><p className="notice text-sm">เก็บ REF และ barcode เป็นข้อความเพื่อรักษาเลขศูนย์นำหน้า ไม่อนุมานว่า barcode เป็น GTIN</p><div className="flex flex-wrap gap-3"><SubmitButton className="button" label="สร้างน้ำยา" pendingLabel="กำลังบันทึก…"/><Link href="/products" className="button secondary">ยกเลิก</Link></div></form>
  </main>;
}
