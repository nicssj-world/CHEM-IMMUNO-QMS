import type { Metadata } from 'next';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChangeOwnPasswordForm } from '@/components/change-own-password-form';
import { SignatureSettings } from '@/components/signature-settings';

export const metadata: Metadata = { title: 'บัญชีของฉัน' };

export default async function AccountPage() {
  const access = await requireAccess();
  const client = await createClient();
  const [{ data: profile }, { data: signature }] = client ? await Promise.all([
    client.from('ci_user_profiles').select('position_title').eq('user_id', access.userId).maybeSingle(),
    client.from('ci_user_signatures').select('signature_png').eq('user_id', access.userId).maybeSingle(),
  ]) : [{ data: null }, { data: null }];
  return <main className="grid gap-6 max-w-[640px]">
    <div><p className="eyebrow mb-2">Account</p><h1 className="page-title">บัญชีของฉัน</h1><p className="muted mt-2 text-sm"><span className="font-bold text-[var(--ink)]">{access.ephisId}</span> · {access.displayName}</p></div>
    <section className="surface p-5 sm:p-7 grid gap-5" aria-labelledby="account-signer">
      <div><h2 id="account-signer" className="font-extrabold text-lg">ตำแหน่งและลายเซ็น</h2><p className="muted text-sm mt-1">ใช้กับรายงานประเมินผู้ขายประจำปี</p></div>
      <SignatureSettings userId={access.userId} position={profile?.position_title ?? null} signature={signature?.signature_png ?? null} />
    </section>
    <section className="surface p-5 sm:p-7 grid gap-5">
      <div><h2 className="font-extrabold text-lg">เปลี่ยนรหัสผ่าน</h2><p className="muted text-sm mt-1">เมื่อเปลี่ยนแล้ว อุปกรณ์อื่นที่ล็อกอินอยู่จะถูกออกจากระบบ</p></div>
      <ChangeOwnPasswordForm />
    </section>
  </main>;
}
