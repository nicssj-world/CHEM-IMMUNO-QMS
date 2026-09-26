'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { openWorkspaceFor, scanItem, sidebarSections, tabHref, toggleWorkspace, type NavPermissions, type WorkspaceKey } from '@/lib/nav';

/**
 * The Scan quick action, then one accordion section per workspace (desktop only: the sidebar is hidden on narrow screens,
 * where the tab strip and the bottom bar take over). One workspace is open at a time and the workspace of the current page
 * opens by itself. Everything comes from src/lib/nav.ts.
 */
export function SideNav({ permissions }: { permissions: NavPermissions }) {
  const pathname = usePathname();
  const warehouse = useSearchParams().get('warehouse');
  const ScanIcon = scanItem.icon;
  const activeKey = openWorkspaceFor(pathname);
  // Navigating into another workspace opens it; the state is adjusted during render so there is no flash of the old section.
  const [state, setState] = useState<{ open: WorkspaceKey | null; seen: WorkspaceKey | null }>({ open: activeKey, seen: activeKey });
  let open = state.open;
  if (state.seen !== activeKey) { open = activeKey; setState({ open: activeKey, seen: activeKey }); }
  const sections = sidebarSections(permissions, pathname, open);
  return <nav aria-label="เมนูหลัก" className="grid gap-4">
    <Link href={scanItem.href} className="side-scan" aria-current={pathname === scanItem.href ? 'page' : undefined}><ScanIcon size={18} aria-hidden />{scanItem.label}</Link>
    <div className="grid gap-0.5">
      {sections.map(({ workspace, active, expanded, tabs, activeHref }) => {
        const Icon = workspace.icon;
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return <div key={workspace.key}>
          <button type="button" className="side-parent" data-active={active || undefined} aria-expanded={expanded} aria-controls={`side-sub-${workspace.key}`} onClick={() => setState({ open: toggleWorkspace(open, workspace.key), seen: activeKey })}>
            <span className="flex items-center gap-[11px]"><Icon size={18} aria-hidden />{workspace.label}</span><Chevron size={16} aria-hidden />
          </button>
          <ul id={`side-sub-${workspace.key}`} className="side-sub" hidden={tabs.length === 0} aria-label={workspace.label}>
            {tabs.map(({ href, label }) => <li key={href}><Link className="side-child" href={tabHref(href, warehouse)} aria-current={activeHref === href ? 'page' : undefined}>{label}</Link></li>)}
          </ul>
        </div>;
      })}
    </div>
  </nav>;
}
