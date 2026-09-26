'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { isStockUnit } from '@/lib/units';

function text(form: FormData, field: string) { return String(form.get(field) ?? '').trim(); }
function fail(path: string, message: string): never { redirect(`${path}?error=${encodeURIComponent(logUserMessage(path, message))}`); }

export async function createProduct(form: FormData) {
  const access = await requireAccess();
  const parsed = z.object({ warehouse_id: z.coerce.number().int(), product_type: z.enum(['reagent','calibrator','control','consumable']), source_name: z.string().min(1).max(300), display_name: z.string().min(1).max(300), packing_size_raw: z.string().max(300), current_ref: z.string().min(1), manufacturer_barcode: z.string().min(1) }).safeParse({
    warehouse_id: text(form,'warehouse_id'), product_type: text(form,'product_type'), source_name: text(form,'source_name'), display_name: text(form,'display_name'), packing_size_raw: text(form,'packing_size_raw'), current_ref: text(form,'current_ref'), manufacturer_barcode: text(form,'manufacturer_barcode'),
  });
  if (!parsed.success) fail('/products/new','กรอกข้อมูลสินค้าให้ครบและถูกต้อง');
  const warehouse = access.warehouses.find(w => Number(w.id) === parsed.data.warehouse_id);
  if (!warehouse || !canSupervise(warehouse.role)) fail('/products/new','ไม่มีสิทธิ์จัดการสินค้าคลังนี้');
  const client = await createClient();
  if (!client) fail('/products/new','ยังไม่ได้ตั้งค่า Supabase');
  const { data: id, error } = await client.rpc('ci_create_product',{ p_data: {
    warehouse_id: parsed.data.warehouse_id, product_type: parsed.data.product_type, source_name: parsed.data.source_name,
    display_name: parsed.data.display_name, packing_size_raw: parsed.data.packing_size_raw || null,
    current_ref: parsed.data.current_ref, manufacturer_barcode: parsed.data.manufacturer_barcode,
  }});
  if (error || !id) fail('/products/new',error?.message ?? 'สร้างสินค้าไม่สำเร็จ');
  revalidatePath('/products');
  redirect(`/products/${id}`);
}

export async function deleteProduct(form: FormData) {
  const productId = text(form,'id');
  const client = await createClient();
  if (!client) fail('/products','ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_delete_product',{ p_id: productId });
  if (error) fail(`/products/${productId}`,error.message);
  revalidatePath('/products');
  redirect('/products?saved=deleted');
}

export async function updateProduct(form: FormData) {
  await requireAccess();
  const id = text(form,'id');
  const client = await createClient();
  if (!client) fail(`/products/${id}`,'ยังไม่ได้ตั้งค่า Supabase');
  const unit = text(form,'base_stock_unit') || 'pack';
  if (!isStockUnit(unit)) fail(`/products/${id}`,'หน่วยนับไม่อยู่ในรายการที่กำหนด กรุณาเลือกจากรายการ');
  const data = { display_name: text(form,'display_name'), packing_size_raw: text(form,'packing_size_raw') || null, product_type: text(form,'product_type'), base_stock_unit: unit, active: form.get('active') === 'on' };
  const { error } = await client.rpc('ci_update_product',{ p_id: id, p_data: data });
  if (error) fail(`/products/${id}`,error.message);
  revalidatePath(`/products/${id}`);
  redirect(`/products/${id}?saved=1`);
}

export async function saveIdentifier(form: FormData) {
  await requireAccess();
  const productId = text(form,'product_id');
  const payload = { product_id: productId, id: text(form,'id') || undefined, kind: text(form,'kind'), value: text(form,'value'), source: 'manual' };
  const client = await createClient();
  if (!client) fail(`/products/${productId}`,'ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_save_product_identifier',{ p_data: payload });
  if (error) fail(`/products/${productId}`,error.message);
  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}?saved=1`);
}

export async function deleteIdentifier(form: FormData) {
  await requireAccess();
  const productId = text(form,'product_id');
  const client = await createClient();
  if (!client) fail(`/products/${productId}`,'ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_delete_product_identifier',{ p_id: text(form,'id') });
  if (error) fail(`/products/${productId}`,error.message);
  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}?saved=1`);
}

export async function saveRelation(form: FormData) {
  await requireAccess();
  const sourceId = text(form,'source_product_id');
  const client = await createClient();
  if (!client) fail(`/products/${sourceId}`,'ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_save_product_relation',{ p_data: {
    id: text(form,'id') || undefined, source_product_id: sourceId,
    target_product_id: text(form,'target_product_id'), relation_type: text(form,'relation_type'), note: text(form,'note') || null,
  }});
  if (error) fail(`/products/${sourceId}`,error.message);
  revalidatePath(`/products/${sourceId}`);
  redirect(`/products/${sourceId}?saved=1`);
}

export async function deleteRelation(form: FormData) {
  await requireAccess();
  const sourceId = text(form,'source_product_id');
  const client = await createClient();
  if (!client) fail(`/products/${sourceId}`,'ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_delete_product_relation',{ p_id: text(form,'id') });
  if (error) fail(`/products/${sourceId}`,error.message);
  revalidatePath(`/products/${sourceId}`);
  redirect(`/products/${sourceId}?saved=1`);
}

export async function savePlatform(form: FormData) {
  await requireAccess();
  const productId = text(form,'product_id');
  const client = await createClient();
  if (!client) fail(`/products/${productId}`,'ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_save_product_platform',{ p_data: {
    id: text(form,'id') || undefined, product_id: productId, platform_id: text(form,'platform_id'), source_text: text(form,'source_text') || null,
  }});
  if (error) fail(`/products/${productId}`,error.message);
  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}?saved=1`);
}

export async function deletePlatform(form: FormData) {
  await requireAccess();
  const productId = text(form,'product_id');
  const client = await createClient();
  if (!client) fail(`/products/${productId}`,'ยังไม่ได้ตั้งค่า Supabase');
  const { error } = await client.rpc('ci_delete_product_platform',{ p_id: text(form,'id') });
  if (error) fail(`/products/${productId}`,error.message);
  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}?saved=1`);
}
