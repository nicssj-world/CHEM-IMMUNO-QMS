import Link from 'next/link';
import type { AccessContext } from '@/lib/auth';
import { signOut } from '@/app/actions/auth';
import { navPermissions } from '@/lib/nav';
import { label, roleLabels, roleShortLabels } from '@/lib/labels';
import { SideNav } from './side-nav';
import { BottomNav } from './bottom-nav';

export function AppShell({ access, children }: { access: AccessContext; children: React.ReactNode }) {
  const roles = access.warehouses.map(w => `${w.code}: ${label(roleShortLabels, w.role)}`).join(' · ');
  const rolesFull = access.warehouses.map(w => `${w.name}: ${label(roleLabels, w.role)}`).join(' · ');
  return <div className="app-grid shell">
    <a href="#main" className="skip-link">ข้ามไปยังเนื้อหา</a>
    <aside className="sidebar"><div className="sidebar-inner"><div className="px-3 pb-6"><div className="text-[.68rem] uppercase tracking-[.18em] text-teal-200 font-bold">Clinical inventory</div><div className="text-xl font-extrabold tracking-tight mt-2">CHEM-IMMUNO CBH</div><p className="text-xs text-slate-300 mt-2">Clinical Chemistry · Immunology</p></div><SideNav permissions={navPermissions(access)} /></div></aside>
    <div className="main-area"><header className="topbar"><Link href="/" className="mobile-only font-extrabold text-[1.05rem] no-underline text-[var(--ink)] shrink-0">CHEM-IMMUNO <span className="text-[var(--teal)]">CBH</span></Link><p className="desktop-only muted text-sm">ระบบคลัง Clinical Chemistry และ Immunology</p><div className="flex min-w-0 items-center gap-3"><Link href="/account" className="min-w-0 text-right no-underline text-[var(--ink)] min-h-11 grid content-center" aria-label={`บัญชีของฉัน: ${access.displayName} · ${rolesFull}`} title={rolesFull}><p className="truncate text-sm font-bold">{access.displayName}</p><p className="truncate text-xs muted">{access.ephisId}<span className="desktop-only-inline"> · {roles}</span></p></Link><form action={signOut}><button type="submit" className="button secondary text-xs px-3 min-h-11" aria-label="ออกจากระบบ">ออก</button></form></div></header><div id="main" tabIndex={-1} className="pt-7 outline-none">{children}</div></div>
    <BottomNav />
  </div>;
}
