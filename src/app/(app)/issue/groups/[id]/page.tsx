import { notFound } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { PickingChecklist, type PickingLine } from '@/components/picking-checklist';

type Group={id:string;status:string;purpose:string;created_at:string};
type Row={id:string;product_id:string;lot_id:string;location_id:string;quantity:number;picked:boolean};
export default async function IssueGroupPage({params}:{params:Promise<{id:string}>}) {
 await requireAccess();
 const {id}=await params;
 if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
 const client=await createClient();
 if(!client)notFound();
 const {data:group,error:groupError}=await client.from('ci_issue_groups').select('id,status,purpose,created_at').eq('id',id).maybeSingle();
 if(groupError||!group)notFound();
 const {data:raw,error}=await client.from('ci_issue_group_lines').select('id,product_id,lot_id,location_id,quantity,picked').eq('group_id',id).limit(100);
 if(error||!raw)throw new Error('ไม่สามารถอ่าน Checklist ได้');
 const source=raw as Row[];
 const pids=[...new Set(source.map(x=>x.product_id))];
 const lids=[...new Set(source.map(x=>x.lot_id))];
 const locids=[...new Set(source.map(x=>x.location_id))];
 const [p,l,loc,tx]=await Promise.all([
  pids.length?client.from('ci_products').select('id,product_code,display_name').in('id',pids):Promise.resolve({data:[],error:null}),
  lids.length?client.from('ci_stock_lots').select('id,lot_number,expiry_date').in('id',lids):Promise.resolve({data:[],error:null}),
  locids.length?client.from('ci_locations').select('id,code').in('id',locids):Promise.resolve({data:[],error:null}),
  client.from('ci_issue_group_transactions').select('warehouse_id,transaction_id').eq('group_id',id),
 ]);
 if(p.error||l.error||loc.error||tx.error)throw new Error('ไม่สามารถอ่านรายละเอียดน้ำยาได้');
 const products=new Map((p.data??[]).map(x=>[x.id,x]));
 const lots=new Map((l.data??[]).map(x=>[x.id,x]));
 const locations=new Map((loc.data??[]).map(x=>[x.id,x.code]));
 const lines:PickingLine[]=source.map(x=>({
  id:x.id,product_code:products.get(x.product_id)?.product_code??'—',
  product_name:products.get(x.product_id)?.display_name??'ไม่พบชื่อสินค้า',
  lot_number:lots.get(x.lot_id)?.lot_number??'—',
  expiry_date:lots.get(x.lot_id)?.expiry_date??'',
  location_code:locations.get(x.location_id)??'—',
  quantity:Number(x.quantity),picked:x.picked,
 }));
 return <PickingChecklist key={(group as Group).status} id={id} status={(group as Group).status} initialLines={lines}
  transactions={tx.data??[]}/>;
}
