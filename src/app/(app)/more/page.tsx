import Link from 'next/link';
import { UserRound } from 'lucide-react';
import { requireAccess } from '@/lib/auth';
import { navPermissions, visibleNavGroups } from '@/lib/nav';

// The phone's full menu: the same groups and permission rules as the desktop sidebar.
export default async function MorePage() {
  const access = await requireAccess();
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">More</p><h1 className="page-title">เมนูทั้งหมด</h1></div>
    {visibleNavGroups(navPermissions(access)).map(group => <section key={group.title} className="grid gap-2" aria-labelledby={`more-${group.title}`}>
      <h2 id={`more-${group.title}`} className="text-xs font-bold tracking-wide muted">{group.title}</h2>
      <nav aria-label={group.title} className="grid sm:grid-cols-2 gap-2">{group.items.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className="surface flex items-center gap-3 p-4 min-h-12 no-underline text-[var(--ink)] font-semibold"><Icon size={19} aria-hidden className="text-[var(--teal)]" />{label}</Link>)}</nav>
    </section>)}
    <section className="grid gap-2"><h2 className="text-xs font-bold tracking-wide muted">บัญชี</h2><Link href="/account" className="surface flex items-center gap-3 p-4 min-h-12 no-underline text-[var(--ink)] font-semibold"><UserRound size={19} aria-hidden className="text-[var(--teal)]" />บัญชีของฉัน / เปลี่ยนรหัสผ่าน</Link></section>
  </main>;
}
