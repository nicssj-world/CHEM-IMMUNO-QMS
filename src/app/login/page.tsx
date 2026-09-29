import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';
import { safeReturnPath } from '@/lib/return-path';

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const returnTo = safeReturnPath(next);
  return <main className="min-h-dvh flex items-center justify-center px-4 py-10 bg-[radial-gradient(circle_at_top_right,#bcefe7,transparent_38%),linear-gradient(160deg,#eaf4f7,#f8fbfa)]">
    <section className="surface w-full max-w-[440px] p-7 sm:p-9">
      <div className="mb-8"><p className="eyebrow">Inventory system</p><h1 className="text-2xl font-extrabold mt-1">CHEM-IMMUNO CBH</h1></div>
      <h2 className="text-2xl font-bold mb-2">เข้าสู่ระบบ</h2><p className="muted mb-7 text-sm">ใช้เลข Ephis ID ในการเข้าสู่ระบบ</p>
      {error && <p className="error mb-5" role="alert">{error === 'configuration' ? 'ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบ' : 'Ephis ID หรือรหัสผ่านไม่ถูกต้อง หรือยังไม่มีสิทธิ์ใช้งาน'}</p>}
      {returnTo && !error && <p className="notice mb-5 text-sm" role="status">เซสชันหมดอายุ · เข้าสู่ระบบอีกครั้งเพื่อกลับไปยังหน้าที่ทำค้างไว้</p>}
      <LoginForm next={returnTo ?? ''} />
    </section>
  </main>;
}
