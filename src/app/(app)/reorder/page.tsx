import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { saveReorderSettings } from '@/app/actions/control';
import { stockStatus } from '@/lib/inventory-insights';

type Product = { id: string; product_code: string; display_name: string };
type Status = { product_id: string; mode: string | null; manual_rop_packs: number | null; lead_time_days: number | null; safety_stock: number | null; target_coverage_days: number | null; order_pack_quantity: number | null; usable_stock: number; average_daily_issue: number | null; rop: number | null; suggested_order: number | null; missing_reason: string | null };

export default async function ReorderPage({ searchParams }: { searchParams: Promise<{warehouse?:string;q?:string;error?:string;saved?:string}> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access,params.warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const q = (params.q ?? '').trim().slice(0,80).replace(/[(),.%]/g,'');
  let query = client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id',warehouse.id).eq('active',true).order('product_code').limit(50);
  if (q) query = query.or(`product_code.ilike.%${q}%,display_name.ilike.%${q}%`);
  const {data: productData,error:productError} = await query;
  const products = (productData ?? []) as Product[];
  const {data: statusData,error:statusError} = products.length ? await client.from('ci_reorder_status').select('*').in('product_id',products.map(p=>p.id)) : {data:[],error:null};
  const status = new Map(((statusData ?? []) as Status[]).map(s=>[s.product_id,s]));
  const canEdit = access.warehouses.some(w=>w.id===warehouse.id && canSupervise(w.role));
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Inventory control</p><h1 className="page-title">ROP และ Suggested Order</h1><p className="muted text-sm">การคำนวณอัตโนมัติใช้ยอดเบิกสุทธิ 90 วัน · ไม่หักยอด PO ที่ยังไม่รับ</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/reorder"/>
    <form method="get" className="surface p-4 flex gap-3 items-end"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field flex-1">ค้นหาสินค้า<input className="input" name="q" defaultValue={params.q ?? ''}/></label><button className="button">ค้นหา</button></form>
    {params.error && <p role="alert" className="error">{params.error}</p>}{params.saved && <p role="status" className="notice">บันทึกการตั้งค่าสำเร็จ</p>}{(productError||statusError) && <p role="alert" className="error">อ่านข้อมูลไม่สำเร็จ: {(productError||statusError)?.message}</p>}
    <div className="grid lg:grid-cols-2 gap-4">{products.map(p=>{const s=status.get(p.id); const state=stockStatus(Number(s?.usable_stock??0),s?.rop==null?null:Number(s.rop));return <section className="surface p-5 grid gap-3" key={p.id}><div><Link href={`/products/${p.id}`} className="font-bold text-[#126390]">{p.product_code} · {p.display_name}</Link><p className="muted text-sm">usable {s?.usable_stock ?? 0} · {state} · ROP {s?.rop ?? 'ต้องตั้งค่า'} · แนะนำสั่ง {s?.suggested_order ?? 'ต้องตั้งค่า'}</p>{s?.missing_reason && <p className="text-sm text-amber-800">{s.missing_reason}</p>}</div>{canEdit && <form action={saveReorderSettings} className="grid grid-cols-2 gap-3"><input type="hidden" name="product_id" value={p.id}/><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field col-span-2">โหมด<select name="mode" className="input" defaultValue={s?.mode??'manual'}><option value="manual">Manual</option><option value="automatic">Automatic</option></select></label><label className="field">ROP (packs)<input className="input" name="manual_rop_packs" type="number" min="0" step="0.001" defaultValue={s?.manual_rop_packs??''}/></label><label className="field">Order pack quantity<input className="input" name="order_pack_quantity" type="number" min="0.001" step="0.001" defaultValue={s?.order_pack_quantity??''}/></label><label className="field">Lead time (days)<input className="input" name="lead_time_days" type="number" min="0" step="1" defaultValue={s?.lead_time_days??''}/></label><label className="field">Safety stock<input className="input" name="safety_stock" type="number" min="0" step="0.001" defaultValue={s?.safety_stock??''}/></label><label className="field col-span-2">Target coverage (days)<input className="input" name="target_coverage_days" type="number" min="1" step="1" defaultValue={s?.target_coverage_days??''}/></label><button className="button col-span-2" type="submit">บันทึกการตั้งค่า</button></form>}</section>;})}</div>{products.length===50 && <p className="muted text-sm">แสดง 50 รายการแรก · ใช้ช่องค้นหาเพื่อเจาะจงสินค้า</p>}
  </main>;
}
