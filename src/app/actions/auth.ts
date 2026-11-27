'use server';

import { redirect } from 'next/navigation';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { signInWithEphisId } from '@/lib/ephis-auth';
import { safeReturnPath } from '@/lib/return-path';

export async function signIn(formData: FormData) {
  const client = await createClient();
  const next = safeReturnPath(String(formData.get('next') ?? ''));
  const keep = next ? `&next=${encodeURIComponent(next)}` : '';
  if (!client) redirect(`/login?error=configuration${keep}`);
  const ephisId = String(formData.get('ephisId') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!await signInWithEphisId(client, ephisId, password)) redirect(`/login?error=credentials${keep}`);
  redirect(next ?? '/');
}

export async function signOut() {
  const client = await createClient();
  if (client) await client.auth.signOut();
  redirect('/login');
}

export type ChangePasswordState = { status: 'idle' | 'success' | 'error'; message?: string };

const changeError = (message: string): ChangePasswordState => ({ status: 'error', message });

export async function changeOwnPassword(_previous: ChangePasswordState, form: FormData): Promise<ChangePasswordState> {
  const current = String(form.get('current_password') ?? '');
  const next = String(form.get('new_password') ?? '');
  const confirmation = String(form.get('confirm_password') ?? '');
  if (!current) return changeError('กรอกรหัสผ่านปัจจุบัน');
  if (next.length < 12 || next.length > 128) return changeError('รหัสผ่านใหม่ต้องมี 12–128 ตัวอักษร');
  if (next !== confirmation) return changeError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
  if (next === current) return changeError('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน');

  const client = await createClient();
  if (!client) return changeError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
  const { data: userResult, error: userError } = await client.auth.getUser();
  const email = userResult.user?.email;
  if (userError || !email) redirect('/login');

  // Verify the current password on a throwaway client so this session's cookies are untouched.
  const verifier = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { error: verifyError } = await verifier.auth.signInWithPassword({ email, password: current });
  if (verifyError) return changeError('รหัสผ่านปัจจุบันไม่ถูกต้อง');

  const { error } = await client.auth.updateUser({ password: next });
  if (error) {
    console.warn('[auth] self password change refused', JSON.stringify({ code: error.code, status: error.status }));
    return changeError('เปลี่ยนรหัสผ่านไม่สำเร็จ ตรวจสอบว่ารหัสผ่านผ่านเงื่อนไขของระบบ');
  }
  // Keep this device signed in; end every other session that used the old password.
  await client.auth.signOut({ scope: 'others' });
  return { status: 'success' };
}
