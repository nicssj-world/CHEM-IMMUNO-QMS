import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { decideMapping } from '@/app/actions/control';

type Request = {id:string;product_id:string;identifier_kind:string;identifier_value:string;raw_payload:string;proposed_by:string;proposed_at:string};
type Product = {id:string;product_code:string;display_name:string};

export default async function MappingReviewPage({searchParams}:{searchParams:Promise<{warehouse?:string;error?:string;saved?:string}>}) {
  const params=await searchParams;
  const access=await requireAccess();
  const warehouse=selectedWarehouse(access,params.warehouse);
  const client=await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const [requestsResult,productsResult]=await Promise.all([
    client.from('ci_identifier_mapping_requests').select('id,product_id,identifier_kind,identifier_value,raw_payload,proposed_by,proposed_at').eq('warehouse_id',warehouse.id).eq('status','proposed').order('proposed_at').limit(100),
    client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id',warehouse.id).limit(300),
  ]);
  const products=new Map(((productsResult.data??[]) as Product[]).map(p=>[p.id,p]));
  const requests=(requestsResult.data??[]) as Request[];
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Identifier governance</p><h1 className="page-title">คิวอนุมัติ Barcode</h1><p className="muted text-sm">ข้อเสนอจะยังไม่ใช้ค้นหาสินค้าจนกว่า Supervisor/Admin อนุมัติ</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/scan/review"/>
    {params.error&&<p role="alert" className="error">{params.error}</p>}{params.saved&&<p role="status" className="notice">บันทึกผลแล้ว</p>}{(requestsResult.error||productsResult.error)&&<p role="alert" className="error">อ่านข้อมูลไม่สำเร็จ: {(requestsResult.error||productsResult.error)?.message}</p>}
    {requests.map(item=><article className="surface p-5 grid gap-3" key={item.id}><h2 className="font-bold">{item.identifier_kind} · {item.identifier_value}</h2><p>{products.get(item.product_id)?.product_code} · {products.get(item.product_id)?.display_name}</p><p className="muted text-xs break-all">Raw: {item.raw_payload}</p><p className="muted text-xs">เสนอ {item.proposed_at} · Actor {item.proposed_by}</p>{canSupervise(warehouse.role)&&<form action={decideMapping} className="grid gap-2"><input type="hidden" name="request_id" value={item.id}/><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field">เหตุผล / บันทึกการตัดสิน<textarea className="input" name="reason" required/></label><div className="flex gap-2"><button className="button" name="decision" value="approve">อนุมัติ</button><button className="button danger" name="decision" value="reject">ปฏิเสธ</button></div></form>}</article>)}{!requests.length&&<p className="notice">ไม่มี Barcode รอพิจารณา</p>}<Link href={`/scan?warehouse=${warehouse.code}`} className="button secondary">กลับไปสแกน</Link>
  </main>;
}
