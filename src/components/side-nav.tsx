'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeWorkspace, scanItem, visibleWorkspaces, workspaceHref, type NavPermissions } from '@/lib/nav';

/** One entry per workspace plus the Scan quick action; each workspace's own pages are the tabs shown above the page. */
export function SideNav({ permissions }: { permissions: NavPermissions }) {
  const pathname = usePathname();
  const ScanIcon = scanItem.icon;
  const current = activeWorkspace(pathname)?.key;
  return <nav aria-label="เมนูหลัก" className="grid gap-4">
    <Link href={scanItem.href} className="side-scan" aria-current={pathname === scanItem.href ? 'page' : undefined}><ScanIcon size={18} aria-hidden />{scanItem.label}</Link>
    <div className="grid gap-0.5">
      {visibleWorkspaces(permissions).map(workspace => {
        const Icon = workspace.icon;
        return <Link className="side-link" href={workspaceHref(workspace)} key={workspace.key} aria-current={current === workspace.key ? 'page' : undefined}><Icon size={18} aria-hidden />{workspace.label}</Link>;
      })}
    </div>
  </nav>;
}
