'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { activeTab, categoryForPathname, scanItem, sidebarCategories, tabHref, toggleCategory, type NavCategoryKey, type NavPermissions } from '@/lib/nav';

/**
 * The Scan quick action, then a category-level accordion: Home always shows its two links; every other category is a
 * button that opens/closes its direct links (no expand step for STOCK/OPERATIONS/etc. individually - the button IS the
 * category). At most one collapsible category is open at a time, and the category holding the current page opens by
 * itself. Everything comes from src/lib/nav.ts.
 */
export function SideNav({ permissions }: { permissions: NavPermissions }) {
  const pathname = usePathname();
  const warehouse = useSearchParams().get('warehouse');
  const ScanIcon = scanItem.icon;
  const currentHref = activeTab(pathname)?.tab.href ?? null;
  const currentCategory = categoryForPathname(pathname);
  // Navigating into another category's page opens it and closes whichever was open; the state is adjusted during render
  // so there is no flash of the old category. Staying inside the same category (e.g. /stock -> a product detail)
  // never disturbs a category the user opened by hand, since `seen` only changes when the current category itself does.
  const [state, setState] = useState<{ open: NavCategoryKey | null; seen: NavCategoryKey | null }>({ open: currentCategory, seen: currentCategory });
  let open = state.open;
  if (state.seen !== currentCategory) { open = currentCategory; setState({ open: currentCategory, seen: currentCategory }); }
  const categories = sidebarCategories(permissions);

  return <nav aria-label="เมนูหลัก" className="grid gap-4">
    <Link href={scanItem.href} className="side-scan" aria-current={pathname === scanItem.href ? 'page' : undefined}><ScanIcon size={18} aria-hidden />{scanItem.label}</Link>
    <div className="grid gap-1">
      {categories.map(({ key, label, collapsible, groups }) => {
        const expanded = !collapsible || open === key;
        const panelId = `side-panel-${key}`;
        const list = <div id={panelId} className="grid gap-1" hidden={!expanded}>
          {groups.map(({ workspaceKey, workspaceLabel, items }) => <div key={workspaceKey}>
            {/* If a category groups multiple workspaces, label each group so similarly named tabs stay distinguishable. */}
            {groups.length > 1 && <p className="side-subheading">{workspaceLabel}</p>}
            <ul className="grid gap-0.5" aria-label={groups.length > 1 ? workspaceLabel : label}>
              {items.map(({ href, label: itemLabel, icon: Icon }) => <li key={href}>
                <Link className="side-link" href={tabHref(href, warehouse)} aria-current={currentHref === href ? 'page' : undefined}><Icon size={18} aria-hidden />{itemLabel}</Link>
              </li>)}
            </ul>
          </div>)}
        </div>;
        if (!collapsible) return <div key={key}>
          <p className="side-heading">{label}</p>
          {list}
        </div>;
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return <div key={key}>
          <button type="button" className="side-category" aria-expanded={expanded} aria-controls={panelId} onClick={() => setState({ open: toggleCategory(open, key), seen: currentCategory })}>
            {label}<Chevron size={14} aria-hidden />
          </button>
          {list}
        </div>;
      })}
    </div>
  </nav>;
}
