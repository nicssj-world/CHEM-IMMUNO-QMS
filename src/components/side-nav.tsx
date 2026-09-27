'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { activeTab, scanItem, sidebarCategories, tabHref, type NavPermissions } from '@/lib/nav';

/**
 * The Scan quick action, then one plain category heading per group with every visible tab rendered underneath as a direct
 * link (desktop only: the sidebar is hidden on narrow screens, where the tab strip and the bottom bar take over). No
 * accordion: nothing needs to be expanded to see a page. Everything comes from src/lib/nav.ts.
 */
export function SideNav({ permissions }: { permissions: NavPermissions }) {
  const pathname = usePathname();
  const warehouse = useSearchParams().get('warehouse');
  const ScanIcon = scanItem.icon;
  const currentHref = activeTab(pathname)?.tab.href ?? null;
  const categories = sidebarCategories(permissions);
  return <nav aria-label="เมนูหลัก" className="grid gap-4">
    <Link href={scanItem.href} className="side-scan" aria-current={pathname === scanItem.href ? 'page' : undefined}><ScanIcon size={18} aria-hidden />{scanItem.label}</Link>
    <div className="grid gap-1">
      {categories.map(({ key, label, groups }) => <div key={key}>
        <p className="side-heading">{label}</p>
        {groups.map(({ workspaceKey, workspaceLabel, items }) => <div key={workspaceKey}>
          {/* A category that groups more than one workspace (MONITORING today) needs its own sub-heading per workspace, so
             two tabs that happen to share a label and an icon (Morning Talk's and Environment's own "ประวัติ") stay tellable apart. */}
          {groups.length > 1 && <p className="side-subheading">{workspaceLabel}</p>}
          <ul className="grid gap-0.5" aria-label={groups.length > 1 ? workspaceLabel : label}>
            {items.map(({ href, label: itemLabel, icon: Icon }) => <li key={href}>
              <Link className="side-link" href={tabHref(href, warehouse)} aria-current={currentHref === href ? 'page' : undefined}><Icon size={18} aria-hidden />{itemLabel}</Link>
            </li>)}
          </ul>
        </div>)}
      </div>)}
    </div>
  </nav>;
}
