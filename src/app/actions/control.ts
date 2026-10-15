'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';

function value(form: FormData, key: string) { return String(form.get(key) ?? '').trim(); }
function path(warehouse: string, page: string) { return `/${page}?warehouse=${encodeURIComponent(warehouse)}`; }

export async function saveReorderSettings(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const mode = value(form,'mode');
  const stockRequirement = value(form,'stock_requirement');
  const query = new URLSearchParams();
  const search = value(form,'return_q').slice(0,80);
  const requirementFilter = value(form,'return_requirement');
  const page = Number(value(form,'return_page'));
  if (search) query.set('q',search);
  if (['required','on_demand','unclassified'].includes(requirementFilter)) query.set('requirement',requirementFilter);
  if (Number.isInteger(page) && page > 1 && page <= 100) query.set('page',String(page));
  const back = '/reorder' + (query.size ? '?' + query : '');
  const withMessage = (key: string, message: string) => back + (query.size ? '&' : '?') + key + '=' + encodeURIComponent(message);
  if (!['manual','automatic'].includes(mode) || !['unclassified','required','on_demand'].includes(stockRequirement)) {
    redirect(withMessage('error','โหมด ROP หรือประเภทการสำรองน้ำยาไม่ถูกต้อง'));
  }
  const numeric = (key: string) => value(form,key) === '' ? null : Number(value(form,key));
  const payload = {
    mode, stock_requirement:stockRequirement, manual_rop_packs:numeric('manual_rop_packs'),
    lead_time_days:numeric('lead_time_days'), safety_stock:numeric('safety_stock'),
    target_coverage_days:numeric('target_coverage_days'), order_pack_quantity:numeric('order_pack_quantity')
  };
  if (Object.values(payload).some(v => typeof v === 'number' && !Number.isFinite(v))) {
    redirect(withMessage('error','ตัวเลขไม่ถูกต้อง กรุณาตรวจค่าที่กรอก'));
  }
  // One RPC: permission check, product classification, and ROP settings in one DB transaction.
  const { error } = await client.rpc('ci_save_reorder_settings',{p_product_id:value(form,'product_id'),p_data:payload});
  if (error) redirect(withMessage('error',logUserMessage('control',error)));
  for (const route of ['/reorder','/','/attention','/products','/reports/monthly']) revalidatePath(route);
  redirect(withMessage('saved','1'));
}

export async function decideMapping(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const warehouse = value(form,'warehouse');
  const { error } = await client.rpc('ci_decide_identifier_mapping',{ p_id:value(form,'request_id'), p_approve:value(form,'decision')==='approve', p_reason:value(form,'reason') });
  if (error) redirect(`${path(warehouse,'scan/review')}&error=${encodeURIComponent(logUserMessage('control', error))}`);
  revalidatePath('/scan/review');
  redirect(`${path(warehouse,'scan/review')}&saved=1`);
}

