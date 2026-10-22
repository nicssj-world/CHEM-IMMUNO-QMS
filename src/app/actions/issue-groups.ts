'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';

export type IssueGroupInputLine = {
  product_id: string; lot_id: string; location_id: string; quantity: number;
  override_reason?: string | null;
};
export type IssueGroupInput = {
  client_key: string; purpose: string; lines: IssueGroupInputLine[];
};
export type IssueGroupResult = { ok: true; id: string } | { ok: false; message: string };
const purposes = new Set(['Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other']);
async function authenticatedClient() {
  const access = await requireAccess();
  const client = await createClient();
  return { access, client };
}
function validate(input: IssueGroupInput) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input.client_key)) return 'กรุณาเริ่มรายการใหม่';
  if (!purposes.has(input.purpose)) return 'กรุณาเลือกวัตถุประสงค์การเบิก';
  if (!Array.isArray(input.lines) || input.lines.length<1 || input.lines.length>100) return 'รายการเบิกต้องมี 1–100 แถว';
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!line.product_id || !line.lot_id || !line.location_id || !Number.isSafeInteger(line.quantity) || line.quantity<1 || line.quantity>1000000) return 'ตรวจสอบสินค้า LOT ตำแหน่งและจำนวนที่เบิก';
    const key = line.lot_id+':'+line.location_id;
    if (seen.has(key)) return 'พบสินค้า LOT และตำแหน่งซ้ำ กรุณารวมเป็นรายการเดียว';
    seen.add(key);
    if (line.override_reason && line.override_reason.length>500) return 'เหตุผลที่เลือก LOT อื่นยาวเกินไป';
  }
  return '';
}
function refreshIssue() { for (const p of ['/issue','/stock','/movements','/']) revalidatePath(p); }
export async function createIssueGroup(input: IssueGroupInput, immediate=false): Promise<IssueGroupResult> {
  const problem = validate(input);
  if (problem) return {ok:false,message:problem};
  const {access,client} = await authenticatedClient();
  if (!client || !access.warehouses.some(w=>canMutate(w.role))) return {ok:false,message:'ไม่มีสิทธิ์สร้างรายการเบิก'};
  const {data,error}=await client.rpc(immediate?'ci_issue_group_now':'ci_create_issue_group',{p_data:input});
  if (error || typeof data!=='string') return {ok:false,message:logUserMessage('issue-groups',error,'ไม่สามารถบันทึกรายการเบิกได้ โปรดตรวจ Stock อีกครั้ง')};
  refreshIssue();
  return {ok:true,id:data};
}
export async function setIssueLinePicked(groupId:string,lineId:string,picked:boolean):Promise<{ok:boolean;message?:string}> {
  const {client}=await authenticatedClient();
  if (!client) return {ok:false,message:'ไม่สามารถเชื่อมต่อฐานข้อมูล'};
  const {error}=await client.rpc('ci_set_issue_group_picked',{p_group:groupId,p_line:lineId,p_picked:picked});
  if (error) return {ok:false,message:logUserMessage('issue-pick',error,'บันทึกการหยิบสินค้าไม่สำเร็จ')};
  revalidatePath('/issue/groups/'+groupId);
  return {ok:true};
}
export async function completeIssueGroup(groupId:string):Promise<{ok:boolean;message?:string}> {
  const {client}=await authenticatedClient();
  if (!client) return {ok:false,message:'ไม่สามารถเชื่อมต่อฐานข้อมูล'};
  const {error}=await client.rpc('ci_complete_issue_group',{p_group:groupId});
  if (error) return {ok:false,message:logUserMessage('issue-close',error,'ปิดรายการไม่ได้ ตรวจ FEFO หรือยอดคงเหลือล่าสุด')};
  refreshIssue();
  revalidatePath('/issue/groups/'+groupId);
  return {ok:true};
}
export async function cancelIssueGroup(groupId:string):Promise<{ok:boolean;message?:string}> {
  const {client}=await authenticatedClient();
  if (!client) return {ok:false,message:'ไม่สามารถเชื่อมต่อฐานข้อมูล'};
  const {error}=await client.rpc('ci_cancel_issue_group',{p_group:groupId});
  if (error) return {ok:false,message:logUserMessage('issue-cancel',error,'ไม่สามารถยกเลิกรายการได้')};
  refreshIssue();
  revalidatePath('/issue/groups/'+groupId);
  return {ok:true};
}
