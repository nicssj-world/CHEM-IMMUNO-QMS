'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { activeTab, tabHref, visibleWorkspaces, type NavPermissions } from '@/lib/nav';

/**
 * Route-backed secondary navigation for the workspace the current page belongs to. These are ordinary links (not an ARIA
 * tablist), so the browser back/forward buttons, deep links and "open in new tab" all behave normally. Only `?warehouse=`
 * is carried across tabs.
 */
export function WorkspaceTabs({ permissions }: { permissions: NavPermissions }) {
  const pathname = usePathname();
  const warehouse = useSearchParams().get('warehouse');
  const active = activeTab(pathname);
  const workspace = active && visibleWorkspaces(permissions).find(item => item.key === active.workspace.key);
  if (!workspace || workspace.tabs.length < 2) return null;
  return <nav aria-label={`เมนูย่อย ${workspace.label}`} className="workspace-tabs print-hide">
    {workspace.tabs.map(({ href, label, icon: Icon }) => <Link key={href} href={tabHref(href, warehouse)} aria-current={active.tab.href === href ? 'page' : undefined}><Icon size={16} aria-hidden />{label}</Link>)}
  </nav>;
}
