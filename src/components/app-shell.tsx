import Link from 'next/link';
import { Boxes, ClipboardList, House, MoreHorizontal, PackagePlus, ScanLine, ArrowDownToLine, ArrowUpFromLine, SlidersHorizontal, History, NotebookTabs, Trash2, ListChecks, ShieldCheck, Users } from 'lucide-react';
import type { AccessContext } from '@/lib/auth';
import { signOut } from '@/app/actions/auth';

const links = [
  { href: '/', label: 'ภาพรวม', icon: House },
  { href: '/products', label: 'สินค้า', icon: Boxes },
  { href: '/stock', label: 'คงคลัง', icon: ClipboardList },
  { href: '/scan', label: 'สแกน Barcode', icon: ScanLine },
  { href: '/receive', label: 'รับเข้า', icon: PackagePlus },
  { href: '/attention', label: 'Need Attention', icon: ShieldCheck },
  { href: '/reorder', label: 'ROP / สั่งซื้อ', icon: SlidersHorizontal },
  { href: '/vendors', label: 'ผู้ขาย', icon: Users },
  { href: '/reports/monthly', label: 'รายงานรายเดือน', icon: NotebookTabs },
  { href: '/issue', label: 'เบิกใช้', icon: ArrowUpFromLine },
  { href: '/transfer', label: 'ย้ายที่เก็บ', icon: ArrowDownToLine },
  { href: '/counts', label: 'ตรวจนับ', icon: SlidersHorizontal },
  { href: '/adjust', label: 'ปรับยอด', icon: ListChecks },
  { href: '/dispose', label: 'กำจัดหมดอายุ', icon: Trash2 },
  { href: '/movements', label: 'ประวัติ', icon: History },
  { href: '/import', label: 'นำเข้าสินค้า', icon: NotebookTabs },
  { href: '/audit', label: 'Audit log', icon: ShieldCheck },
  { href: '/admin/users', label: 'ผู้ใช้', icon: Users },
];

export function AppShell({ access, children }: { access: AccessContext; children: React.ReactNode }) {
  const canWork = access.warehouses.some(w => w.role !== 'viewer');
  const canSupervise = access.warehouses.some(w => w.role === 'admin' || w.role === 'supervisor');
  const isAdminBoth = access.warehouses.some(w => w.code === 'CHE' && w.role === 'admin') && access.warehouses.some(w => w.code === 'IMM' && w.role === 'admin');
  const visibleLinks = links.filter(link => {
    if (['/issue','/transfer','/counts'].includes(link.href)) return canWork;
    if (['/adjust','/dispose'].includes(link.href)) return canSupervise;
    if (link.href === '/import' || link.href === '/admin/users') return isAdminBoth;
    if (link.href === '/audit') return canSupervise;
    return true;
  });
  return <div className="app-grid shell">
    <aside className="sidebar"><div className="px-3 pb-8"><div className="text-[.68rem] uppercase tracking-[.18em] text-teal-200 font-bold">Clinical inventory</div><div className="text-xl font-extrabold tracking-tight mt-2">CHEM-IMMUNO CBH</div><p className="text-xs text-slate-300 mt-2">Clinical Chemistry · Immunology</p></div><nav aria-label="เมนูหลัก" className="grid gap-1">{visibleLinks.map(({ href,label,icon:Icon }) => <Link className="side-link" href={href} key={href}><Icon size={18} aria-hidden />{label}</Link>)}</nav></aside>
    <div className="main-area"><header className="topbar"><Link href="/" className="font-extrabold text-[1.05rem] no-underline text-[var(--ink)] md:hidden">CHEM-IMMUNO <span className="text-[var(--teal)]">CBH</span></Link><p className="muted text-sm hidden md:block">ระบบคลัง Clinical Chemistry และ Immunology</p><div className="flex items-center gap-3"><div className="text-right"><p className="text-sm font-bold">{access.displayName}</p><p className="text-[.7rem] uppercase tracking-wide muted">{access.ephisId} · {access.warehouses.map(w => `${w.code}: ${w.role}`).join(' · ')}</p></div><form action={signOut}><button type="submit" className="button secondary text-xs px-3 min-h-11" aria-label="ออกจากระบบ">ออก</button></form></div></header><div className="pt-7">{children}</div></div>
    <nav className="bottom-nav print-hide" aria-label="เมนูมือถือ"><Link href="/"><House size={21} aria-hidden/>Home</Link><Link href="/stock"><Boxes size={21} aria-hidden/>Stock</Link><Link href="/scan"><ScanLine size={21} aria-hidden/>Scan</Link><Link href="/receive"><PackagePlus size={21} aria-hidden/>Receive</Link><Link href="/more"><MoreHorizontal size={21} aria-hidden/>More</Link></nav>
  </div>;
}
