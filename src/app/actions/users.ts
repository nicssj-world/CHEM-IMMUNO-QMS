'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { requireAccess } from '@/lib/auth';
import { internalAuthEmail, normalizeEphisId } from '@/lib/auth-identity';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

function fail(message: string): never { redirect(`/admin/users?error=${encodeURIComponent(message)}`); }

export async function provisionUser(form: FormData) {
  const actor = await requireAccess();
  if (!actor.warehouses.some(w => w.id === '1' && w.role === 'admin') ||
      !actor.warehouses.some(w => w.id === '2' && w.role === 'admin')) {
    fail('ต้องเป็น Admin ทั้งสองคลังเพื่อจัดการผู้ใช้');
  }

  const ephisId = normalizeEphisId(String(form.get('ephis_id') ?? ''));
  const displayName = String(form.get('display_name') ?? '').trim();
  const role = String(form.get('role') ?? '');
  const warehouseIds = [...new Set(form.getAll('warehouse_ids').map(value => Number(value)))];
  const active = form.get('active') === 'on';
  const password = String(form.get('initial_password') ?? '');
  if (!ephisId || displayName.length < 1 || displayName.length > 120 ||
      !['admin','supervisor','staff','viewer'].includes(role) ||
      warehouseIds.some(id => id !== 1 && id !== 2) || (active && warehouseIds.length === 0)) {
    fail('ตรวจสอบ Ephis ID, ชื่อ, บทบาท และคลังที่เลือก');
  }

  const authClient = await createClient();
  const adminClient = createAdminClient();
  if (!authClient || !adminClient) fail('ยังไม่ได้ตั้งค่า Supabase Auth สำหรับ provision ผู้ใช้');
  const email = internalAuthEmail(ephisId);
  if (!email) fail('Ephis ID ไม่ถูกต้อง');

  let existingAuthUser: User | null = null;
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fail('ตรวจบัญชี Auth ไม่สำเร็จ');
    existingAuthUser = data.users.find(user => user.email?.toLowerCase() === email) ?? null;
    if (existingAuthUser || data.users.length < 1000) break;
    if (page === 100) fail('มีบัญชี Auth มากเกินกว่าจะตรวจสอบได้อย่างปลอดภัย');
  }

  const { data: existingProfile, error: profileError } = await authClient
    .from('ci_user_profiles').select('user_id,ephis_id').eq('ephis_id', ephisId).maybeSingle();
  if (profileError) fail('ตรวจ Ephis ID ใน Product system ไม่สำเร็จ');
  if (existingProfile && (!existingAuthUser || existingProfile.user_id !== existingAuthUser.id)) {
    fail('Ephis ID นี้มี identity conflict; ระบบยังไม่เปลี่ยนบัญชีเดิม');
  }

  if (!existingAuthUser) {
    if (password.length < 12 || password.length > 128) fail('บัญชีใหม่ต้องมีรหัสผ่านเริ่มต้นอย่างน้อย 12 ตัวอักษร');
    const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) fail('สร้างบัญชี Auth ไม่สำเร็จ');
  }

  const { error } = await authClient.rpc('ci_provision_user', {
    p_ephis_id: ephisId,
    p_display_name: displayName,
    p_role: role,
    p_warehouse_ids: warehouseIds,
    p_active: active,
  });
  if (error) fail(error.message);
  revalidatePath('/admin/users');
  redirect('/admin/users?saved=1');
}
