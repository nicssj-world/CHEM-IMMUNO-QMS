'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAccess, canSupervise, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { normalizeSupplierCode } from '@/lib/supplier-bill-import';
import { supplierIdentifier } from '@/lib/supplier-identifier';
import { logUserMessage } from '@/lib/messages';

const codesSchema = z.object({
  rdthCode: z.string().trim().min(1).max(100),
  materialNo: z.string().trim().min(1).max(100),
});
const existingSchema = codesSchema.extend({
  productId: z.string().uuid(),
});
const createSchema = codesSchema.extend({
  warehouseId: z.number().int().positive(),
  productType: z.enum(['reagent', 'calibrator', 'control', 'consumable']),
  description: z.string().trim().min(1).max(300),
  packingSize: z.string().trim().max(300).default(''),
});
type ActionResult = { ok: true; status: 'linked' | 'requested' | 'created'; productId?: string } |
  { ok: false; message: string };

function validateCodes(rdthCode: string, materialNo: string) {
  // Do not let a client supply arbitrary OTHER codes or scanner identifiers.
  return [supplierIdentifier('rdth', rdthCode), supplierIdentifier('material', materialNo)];
}

async function checkMappings(client: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  productId: string, rdthCode: string, materialNo: string): Promise<string | null> {
  const { data, error } = await client.from('ci_product_identifiers')
    .select('product_id,kind,value,approved')
    .in('kind', ['REF_CURRENT', 'REF_LEGACY', 'MANUFACTURER_BARCODE', 'OTHER'])
    .limit(5000);
  if (error) return 'ตรวจสอบรหัสที่มีอยู่ไม่สำเร็จ';
  const ref = normalizeSupplierCode(rdthCode);
  const material = normalizeSupplierCode(materialNo);
  for (const item of data ?? []) {
    const isRef = (item.kind === 'REF_CURRENT' || item.kind === 'REF_LEGACY')
      && normalizeSupplierCode(item.value) === ref;
    const isMaterial = item.kind === 'MANUFACTURER_BARCODE'
      && normalizeSupplierCode(item.value) === material;
    const isAlias = item.kind === 'OTHER'
      && (item.value === supplierIdentifier('rdth', rdthCode)
       || item.value === supplierIdentifier('material', materialNo));
    if ((isRef || isMaterial || isAlias) && item.product_id !== productId)
      return 'รหัสนี้ถูกใช้โดยสินค้าอื่นแล้ว กรุณาตรวจสอบทะเบียนก่อนจับคู่';
  }
  return null;
}

export async function resolveSupplierExistingProduct(raw: unknown): Promise<ActionResult> {
  const parsed = existingSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'ข้อมูลจับคู่ไม่ถูกต้อง' };
  const { productId, rdthCode, materialNo } = parsed.data;
  let aliases: string[];
  try { aliases = validateCodes(rdthCode, materialNo); }
  catch { return { ok: false, message: 'รหัสสินค้าจาก Excel ไม่ถูกต้อง' }; }
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return { ok: false, message: 'ไม่สามารถเชื่อมต่อฐานข้อมูล' };
  const { data: product, error: productError } = await client.from('ci_products')
    .select('id,warehouse_id,active').eq('id', productId).eq('active', true).maybeSingle();
  if (productError || !product) return { ok: false, message: 'ไม่พบสินค้าในทะเบียนที่ใช้งานอยู่' };
  const wh = access.warehouses.find(w => Number(w.id) === Number(product.warehouse_id));
  if (!wh || !canMutate(wh.role))
    return { ok: false, message: 'ไม่มีสิทธิ์ดำเนินการกับคลังสินค้านี้' };
  const conflict = await checkMappings(client, productId, rdthCode, materialNo);
  if (conflict) return { ok: false, message: conflict };

  if (canSupervise(wh.role)) {
    const { data: existing, error } = await client.from('ci_product_identifiers')
      .select('kind,value,product_id').eq('kind', 'OTHER').in('value', aliases);
    if (error) return { ok: false, message: 'ตรวจสอบรหัสผู้ขายไม่สำเร็จ' };
    for (const alias of aliases) {
      if ((existing ?? []).some(item => item.value === alias && item.product_id === productId)) continue;
      const { error: writeError } = await client.rpc('ci_save_product_identifier', {
        p_data: { product_id: productId, kind: 'OTHER', value: alias, source: 'supplier_excel_mapping' },
      });
      if (writeError)
        return { ok: false, message: logUserMessage('supplier-mapping', writeError,
          'ผูกรหัสไม่สำเร็จ กรุณาตรวจสอบว่ามีสินค้าอื่นใช้รหัสนี้อยู่แล้ว') };
    }
    revalidatePath('/products');
    return { ok: true, status: 'linked', productId };
  }

  // A staff member may submit the same aliases to the existing supervisor
  // barcode-approval queue; approval, not submission, makes them importable.
  const { data: pending, error: pendingError } = await client
    .from('ci_identifier_mapping_requests')
    .select('identifier_value,product_id')
    .eq('product_id', productId).eq('status', 'proposed')
    .in('identifier_value', aliases);
  if (pendingError) return { ok: false, message: 'ตรวจสอบคำขออนุมัติไม่สำเร็จ' };
  const { data: approved, error: approvedError } = await client.from('ci_product_identifiers')
    .select('value').eq('product_id', productId).eq('kind', 'OTHER')
    .eq('approved', true).in('value', aliases);
  if (approvedError) return { ok: false, message: 'ตรวจสอบรหัสผู้ขายไม่สำเร็จ' };
  for (const alias of aliases) {
    if ((pending ?? []).some(item => item.identifier_value === alias)) continue;
    if ((approved ?? []).some(item => item.value === alias)) continue;
    const { error } = await client.rpc('ci_propose_identifier_mapping', {
      p_product_id: productId, p_kind: 'OTHER', p_value: alias,
      p_raw: 'Supplier Excel: ' + rdthCode + ' / ' + materialNo,
    });
    if (error) return { ok: false, message: logUserMessage('supplier-mapping-request', error, 'ส่งคำขอไม่สำเร็จ') };
  }
  return { ok: true, status: 'requested', productId };
}

export async function createSupplierExcelProduct(raw: unknown): Promise<ActionResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'กรุณาตรวจสอบคลัง ประเภทสินค้า ชื่อ และรหัสสินค้า' };
  const { warehouseId, productType, description, packingSize, rdthCode, materialNo } = parsed.data;
  try { validateCodes(rdthCode, materialNo); }
  catch { return { ok: false, message: 'รหัสสินค้าจาก Excel ไม่ถูกต้อง' }; }
  const access = await requireAccess();
  const role = access.warehouses.find(wh => Number(wh.id) === warehouseId);
  if (!role || !canSupervise(role.role)) return { ok: false, message: 'เฉพาะ Supervisor/Admin ของคลังเท่านั้นที่เพิ่มสินค้าได้' };
  const client = await createClient();
  if (!client) return { ok: false, message: 'ไม่สามารถเชื่อมต่อฐานข้อมูล' };
  const { data: similar, error } = await client.from('ci_products')
    .select('id,product_code,display_name').eq('warehouse_id', warehouseId)
    .eq('active', true).ilike('display_name', description).limit(1);
  if (error) return { ok: false, message: 'ตรวจทะเบียนสินค้าซ้ำไม่สำเร็จ' };
  if (similar?.length)
    return { ok: false, message: 'พบชื่อสินค้าเดียวกันในคลัง (' + similar[0].product_code +
      ') กรุณาเลือกจับคู่กับทะเบียนเดิมแทน' };
  const conflict = await checkMappings(client, '', rdthCode, materialNo);
  if (conflict) return { ok: false, message: conflict };

  const { data: productId, error: createError } = await client.rpc('ci_create_product', {
    p_data: {
      warehouse_id: warehouseId, product_type: productType,
      source_name: description, display_name: description, packing_size_raw: packingSize || null,
      current_ref: rdthCode, manufacturer_barcode: materialNo, default_location_id: null,
    },
  });
  if (createError || !productId)
    return { ok: false, message: logUserMessage('supplier-create-product', createError, 'เพิ่มสินค้าไม่สำเร็จ') };
  revalidatePath('/products');
  revalidatePath('/receive');
  return { ok: true, status: 'created', productId: String(productId) };
}
