'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

function value(form: FormData, key: string) { return String(form.get(key) ?? '').trim(); }
function path(warehouse: string, page: string) { return `/${page}?warehouse=${encodeURIComponent(warehouse)}`; }

export async function saveReorderSettings(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const mode = value(form,'mode');
  const warehouse = value(form,'warehouse');
  if (!['manual','automatic'].includes(mode)) redirect(`${path(warehouse,'reorder')}&error=Invalid%20mode`);
  const numeric = (key: string) => value(form,key) === '' ? null : Number(value(form,key));
  const payload = { mode, manual_rop_packs: numeric('manual_rop_packs'), lead_time_days: numeric('lead_time_days'), safety_stock: numeric('safety_stock'), target_coverage_days: numeric('target_coverage_days'), order_pack_quantity: numeric('order_pack_quantity') };
  if (Object.values(payload).some(v => typeof v === 'number' && !Number.isFinite(v))) redirect(`${path(warehouse,'reorder')}&error=Invalid%20number`);
  const { error } = await client.rpc('ci_save_reorder_settings',{ p_product_id: value(form,'product_id'), p_data: payload });
  if (error) redirect(`${path(warehouse,'reorder')}&error=${encodeURIComponent(error.message)}`);
  revalidatePath('/reorder');
  redirect(`${path(warehouse,'reorder')}&saved=1`);
}

export async function decideMapping(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const warehouse = value(form,'warehouse');
  const { error } = await client.rpc('ci_decide_identifier_mapping',{ p_id:value(form,'request_id'), p_approve:value(form,'decision')==='approve', p_reason:value(form,'reason') });
  if (error) redirect(`${path(warehouse,'scan/review')}&error=${encodeURIComponent(error.message)}`);
  revalidatePath('/scan/review');
  redirect(`${path(warehouse,'scan/review')}&saved=1`);
}

export async function createVendorIssue(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const warehouse = value(form,'warehouse');
  const { error } = await client.rpc('ci_create_vendor_issue',{ p_vendor_id:value(form,'vendor_id'),p_warehouse_id:Number(value(form,'warehouse_id')),p_invoice_id:value(form,'invoice_id')||null,p_description:value(form,'description') });
  if (error) redirect(`${path(warehouse,'vendors')}&error=${encodeURIComponent(error.message)}`);
  revalidatePath('/vendors');
  redirect(`${path(warehouse,'vendors')}&saved=1`);
}

export async function resolveVendorIssue(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const warehouse = value(form,'warehouse');
  const { error } = await client.rpc('ci_resolve_vendor_issue',{p_id:value(form,'issue_id'),p_resolution:value(form,'resolution')});
  if (error) redirect(`${path(warehouse,'vendors')}&error=${encodeURIComponent(error.message)}`);
  revalidatePath('/vendors');
  redirect(`${path(warehouse,'vendors')}&saved=1`);
}

export async function saveVendorEvaluation(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const warehouse = value(form,'warehouse');
  const evidence = { notes:value(form,'notes') || null, source:'objective_receiving_records' };
  const { error } = await client.rpc('ci_save_vendor_evaluation',{p_vendor_id:value(form,'vendor_id'),p_warehouse_id:Number(value(form,'warehouse_id')),p_fiscal_year:Number(value(form,'fiscal_year')),p_evidence:evidence});
  if (error) redirect(`${path(warehouse,'vendors')}&error=${encodeURIComponent(error.message)}`);
  revalidatePath('/vendors');
  redirect(`${path(warehouse,'vendors')}&saved=1`);
}

export async function advanceVendorEvaluation(form: FormData) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('Supabase not configured');
  const warehouse = value(form,'warehouse');
  const { error } = await client.rpc('ci_advance_vendor_evaluation',{p_id:value(form,'evaluation_id'),p_step:value(form,'step')});
  if (error) redirect(`${path(warehouse,'vendors')}&error=${encodeURIComponent(error.message)}`);
  revalidatePath('/vendors');
  redirect(`${path(warehouse,'vendors')}&saved=1`);
}
