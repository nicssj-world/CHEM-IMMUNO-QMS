import type { Metadata } from 'next';
import { requireAccess } from '@/lib/auth';
import { ChangeOwnPasswordForm } from '@/components/change-own-password-form';

export const metadata: Metadata = { title: 'บัญชีของฉัน' };

export default async function AccountPage() {
  const access = await requireAccess();
  return <main className="grid gap-6 max-w-[560px]">
    <div><p className="eyebrow mb-2">Account</p><h1 className="page-title">บัญชีของฉัน</h1><p className="muted mt-2 text-sm"><span className="font-bold text-[var(--ink)]">{access.ephisId}</span> · {access.displayName}</p></div>
    <section className="surface p-5 sm:p-7 grid gap-5">
      <div><h2 className="font-extrabold text-lg">เปลี่ยนรหัสผ่าน</h2><p className="muted text-sm mt-1">เมื่อเปลี่ยนแล้ว อุปกรณ์อื่นที่ล็อกอินอยู่จะถูกออกจากระบบ</p></div>
      <ChangeOwnPasswordForm />
    </section>
  </main>;
}
