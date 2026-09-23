import type { Metadata } from 'next';
import { signIn } from '@/app/actions/auth';

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <main className="min-h-dvh flex items-center justify-center px-4 py-10 bg-[radial-gradient(circle_at_top_right,#bcefe7,transparent_38%),linear-gradient(160deg,#eaf4f7,#f8fbfa)]">
    <section className="surface w-full max-w-[440px] p-7 sm:p-9">
      <div className="mb-8"><p className="eyebrow">Inventory system</p><h1 className="text-2xl font-extrabold mt-1">CHEM-IMMUNO CBH</h1></div>
      <h2 className="text-2xl font-bold mb-2">เข้าสู่ระบบ</h2><p className="muted mb-7 text-sm">ใช้ Ephis ID และรหัสผ่านที่ได้รับการจัดสรรสิทธิ์</p>
      {error && <p className="error mb-5" role="alert">{error === 'configuration' ? 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase' : 'Ephis ID หรือรหัสผ่านไม่ถูกต้อง หรือยังไม่มีสิทธิ์ใช้งาน'}</p>}
      <form action={signIn} className="grid gap-5" autoComplete="on">
        <label className="field">Ephis ID<input className="input" name="ephisId" autoComplete="username" required /></label>
        <label className="field">รหัสผ่าน<input className="input" name="password" type="password" autoComplete="current-password" required /></label>
        <button className="button w-full" type="submit">เข้าสู่ระบบ</button>
      </form>
      <p className="muted mt-6 text-xs">สิทธิ์เข้าถึงแต่ละคลังได้รับการตรวจในฐานข้อมูล</p>
    </section>
  </main>;
}
