'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Boxes, House, MoreHorizontal, PackagePlus, ScanLine } from 'lucide-react';
import { isActivePath } from '@/lib/nav';

const tabs = [
  { href: '/', label: 'ภาพรวม', icon: House },
  { href: '/stock', label: 'คงคลัง', icon: Boxes },
  { href: '/scan', label: 'สแกน', icon: ScanLine },
  { href: '/receive', label: 'รับเข้า', icon: PackagePlus },
];

export function BottomNav() {
  const pathname = usePathname();
  // Every page without its own tab lives under "More", so that tab lights up for them.
  const current = tabs.find(tab => tab.href === '/scan' ? pathname === '/scan' : isActivePath(pathname, tab.href))?.href ?? '/more';
  return <nav className="bottom-nav print-hide" aria-label="เมนูมือถือ">
    {tabs.map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={current === href ? 'page' : undefined}><Icon size={21} aria-hidden />{label}</Link>)}
    <Link href="/more" aria-current={current === '/more' ? 'page' : undefined}><MoreHorizontal size={21} aria-hidden />เพิ่มเติม</Link>
  </nav>;
}
