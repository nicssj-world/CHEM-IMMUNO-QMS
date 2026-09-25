'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActivePath, scanItem, visibleNavGroups, type NavPermissions } from '@/lib/nav';

export function SideNav({ permissions }: { permissions: NavPermissions }) {
  const pathname = usePathname();
  const ScanIcon = scanItem.icon;
  return <nav aria-label="เมนูหลัก" className="grid gap-4">
    <Link href={scanItem.href} className="side-scan" aria-current={pathname === scanItem.href ? 'page' : undefined}><ScanIcon size={18} aria-hidden />{scanItem.label}</Link>
    {visibleNavGroups(permissions).map(group => <div key={group.title} role="group" aria-label={group.title} className="grid gap-0.5">
      <p className="side-heading" aria-hidden>{group.title}</p>
      {group.items.map(({ href, label, icon: Icon }) => <Link className="side-link" href={href} key={href} aria-current={isActivePath(pathname, href) ? 'page' : undefined}><Icon size={18} aria-hidden />{label}</Link>)}
    </div>)}
  </nav>;
}
