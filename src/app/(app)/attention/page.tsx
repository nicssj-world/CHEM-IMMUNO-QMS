import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { expiryBucket, stockStatus, type ExpiryBucket } from '@/lib/inventory-insights';

type Reorder = { product_id: string; usable_stock: number; rop: number | null; missing_reason: string | null };
type Product = { id: string; product_code: string; display_name: string };
type Balance = { product_id: string; lot_number: string; expiry_date: string; location_id: string; balance: number };
type Location = { id: string; code: string };

export default async function AttentionPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; type?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const [productResult, reorderResult, balanceResult, locationResult, mappingResult, assessmentResult, vendorIssueResult] = await Promise.all([
    client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id',warehouse.id).eq('active',true).limit(300),
    client.from('ci_reorder_status').select('product_id,usable_stock,rop,missing_reason').eq('warehouse_id',warehouse.id).limit(300),
    client.from('ci_stock_balances').select('product_id,lot_number,expiry_date,location_id,balance').eq('warehouse_id',warehouse.id).gt('balance',0).order('expiry_date').limit(500),
    client.from('ci_locations').select('id,code').eq('warehouse_id',warehouse.id).limit(200),
    client.from('ci_identifier_mapping_requests').select('id,product_id,identifier_kind,identifier_value,proposed_at').eq('warehouse_id',warehouse.id).eq('status','proposed').limit(100),
    client.from('ci_receipt_assessments').select('id,receipt_id,assessed_at').eq('warehouse_id',warehouse.id).eq('delivery_discrepancy',true).limit(100),
    client.from('ci_vendor_issues').select('id,description,created_at').eq('warehouse_id',warehouse.id).eq('status','open').limit(100),
  ]);
  const errors = [productResult.error,reorderResult.error,balanceResult.error,locationResult.error,mappingResult.error,assessmentResult.error,vendorIssueResult.error].filter(Boolean);
  if (errors.length) return <main className="grid gap-4"><h1 className="page-title">Need Attention</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {errors[0]?.message}</p></main>;
  const products = new Map(((productResult.data ?? []) as Product[]).map(p=>[p.id,p]));
  const locations = new Map(((locationResult.data ?? []) as Location[]).map(l=>[l.id,l]));
  const reorders = ((reorderResult.data ?? []) as Reorder[]).map(row=>({...row,status:stockStatus(Number(row.usable_stock),row.rop===null?null:Number(row.rop))}));
  const balances = ((balanceResult.data ?? []) as Balance[]).map(row=>({...row,bucket:expiryBucket(row.expiry_date)}));
  const mapping = mappingResult.data ?? [];
  const assessments = assessmentResult.data ?? [];
  const vendorIssues = vendorIssueResult.data ?? [];
  const counts = [
    {type:'stockout',label:'Stockout',count:reorders.filter(r=>r.status==='stockout').length},
    {type:'below',label:'ต่ำกว่า ROP',count:reorders.filter(r=>r.status==='below ROP').length},
    {type:'EXPIRED',label:'หมดอายุ',count:balances.filter(b=>b.bucket==='EXPIRED').length},
    ...(['≤30','31–60','61–90'] as ExpiryBucket[]).map(type=>({type,label:`หมดอายุ ${type} วัน`,count:balances.filter(b=>b.bucket===type).length})),
    {type:'mapping',label:'Barcode รออนุมัติ',count:mapping.length},
    {type:'discrepancy',label:'ผลตรวจรับคลาดเคลื่อน',count:assessments.length},
    {type:'vendor',label:'ปัญหาผู้ขาย',count:vendorIssues.length},
  ];
  const filter = params.type;
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Attention Center</p><h1 className="page-title">รายการที่ต้องติดตาม</h1><p className="muted mt-2 text-sm">อิงยอด LOT/Location และสิทธิ์ของคลังที่เลือก</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/attention"/>
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">{counts.map(item=><Link className="surface p-4 no-underline text-[var(--ink)]" href={`/attention?warehouse=${warehouse.code}&type=${encodeURIComponent(item.type)}`} key={item.type}><p className="muted text-xs">{item.label}</p><strong className="text-2xl">{item.count}</strong></Link>)}</div>
    {(!filter || filter==='stockout' || filter==='below') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">Stock / ROP</h2>{reorders.filter(r=>r.status==='stockout'||r.status==='below ROP').filter(r=>!filter||filter==='stockout'&&r.status==='stockout'||filter==='below'&&r.status==='below ROP').map(row=><Link key={row.product_id} href={`/products/${row.product_id}`} className="border rounded-lg p-3 no-underline text-[var(--ink)]"><strong>{products.get(row.product_id)?.product_code} · {products.get(row.product_id)?.display_name}</strong><p className="muted text-sm">{row.status} · usable {row.usable_stock} · ROP {row.rop ?? 'ต้องตั้งค่า'}</p></Link>)}<Link href={`/reorder?warehouse=${warehouse.code}`} className="button secondary">ตั้งค่า ROP</Link></section>}
    {(!filter || ['EXPIRED','≤30','31–60','61–90'].includes(filter)) && <section className="surface p-5 grid gap-2"><h2 className="font-bold">LOT ใกล้หมดอายุ</h2>{balances.filter(b=>b.bucket!=='>90').filter(b=>!filter||b.bucket===filter).map((row,i)=><div className="border rounded-lg p-3" key={`${row.product_id}:${row.lot_number}:${row.location_id}:${i}`}><strong>{products.get(row.product_id)?.product_code} · {products.get(row.product_id)?.display_name}</strong><p className="muted text-sm">LOT {row.lot_number} · {row.expiry_date} · {row.bucket} · {warehouse.name} · {locations.get(row.location_id)?.code ?? '—'} · {row.balance}</p></div>)}</section>}
    {(!filter || filter==='mapping') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">Barcode รออนุมัติ</h2>{mapping.map(row=><p className="border rounded-lg p-3" key={row.id}>{row.identifier_kind} {row.identifier_value} · {products.get(row.product_id)?.product_code ?? '—'}</p>)}<Link className="button secondary" href={`/scan/review?warehouse=${warehouse.code}`}>เปิดคิวพิจารณา</Link></section>}
    {(!filter || filter==='discrepancy') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">ผลตรวจรับคลาดเคลื่อน</h2>{assessments.map(row=><p className="border rounded-lg p-3" key={row.id}>Receipt {row.receipt_id} · {row.assessed_at}</p>)}</section>}
    {(!filter || filter==='vendor') && <section className="surface p-5 grid gap-2"><h2 className="font-bold">ปัญหาผู้ขาย</h2>{vendorIssues.map(row=><p className="border rounded-lg p-3" key={row.id}>{row.description} · {row.created_at}</p>)}<Link className="button secondary" href={`/vendors?warehouse=${warehouse.code}`}>ผู้ขาย</Link></section>}
  </main>;
}
