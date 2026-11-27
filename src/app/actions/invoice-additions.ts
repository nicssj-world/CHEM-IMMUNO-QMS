'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess,canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';

export type InvoiceAddition={product_id:string;quantity:number};
export type InvoiceAmendInput={
 invoice_number:string;invoice_date:string;po_number:string;
 lines:InvoiceAddition[];
};
export type InvoiceAmendResult={ok:true}|{ok:false;message:string};
export async function amendInvoice(invoiceId:string,input:InvoiceAmendInput):Promise<InvoiceAmendResult>{
 const access=await requireAccess();
 if(!access.warehouses.some(w=>canMutate(w.role)))return {ok:false,message:'ไม่มีสิทธิ์เพิ่มการรับเข้า'};
 const client=await createClient();
 if(!client)return {ok:false,message:'ไม่สามารถเชื่อมต่อฐานข้อมูล'};
 if(!invoiceId||!input.invoice_number.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(input.invoice_date))
   return {ok:false,message:'กรุณากรอกข้อมูล Invoice ให้ครบ'};
 if(!Array.isArray(input.lines)||input.lines.length>100)return {ok:false,message:'รายการที่เพิ่มมากเกินไป'};
 const seen=new Set<string>();
 for(const x of input.lines){
   if(!x.product_id||seen.has(x.product_id)||!Number.isSafeInteger(x.quantity)||x.quantity<=0||x.quantity>1000000)
     return {ok:false,message:'ตรวจสินค้าและจำนวนที่ต้องการเพิ่ม (จำนวนเต็มมากกว่า 0)'};
   seen.add(x.product_id);
 }
 const {error}=await client.rpc('ci_amend_invoice',{
   p_id:invoiceId,
   p_header:{invoice_number:input.invoice_number.trim(),invoice_date:input.invoice_date,po_number:input.po_number.trim()},
   p_lines:input.lines,
 });
 if(error)return {ok:false,message:logUserMessage('amend-invoice',error,'ไม่สามารถแก้ไข Invoice นี้ได้')};
 for(const p of ['/receive','/stock','/issue','/movements'])revalidatePath(p);
 return {ok:true};
}
