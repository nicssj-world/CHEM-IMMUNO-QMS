import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { House } from 'lucide-react';
import {
  activeTab, activeWorkspace, categoryForPathname, navCategories, navPermissions, scanItem, sidebarCategories, tabHref, toggleCategory, visibleWorkspaces, workspaceHref, workspaces,
  type Workspace,
} from '../../src/lib/nav';
import type { AccessContext } from '../../src/lib/auth';

type Grant = { code: 'CHE' | 'IMM'; role: 'admin' | 'supervisor' | 'staff' | 'viewer' };
const access = (...grants: Grant[]): AccessContext => ({
  userId: 'user', ephisId: 'ephis', displayName: 'Tester',
  warehouses: grants.map(grant => ({ id: grant.code === 'CHE' ? '1' : '2', code: grant.code, name: grant.code, role: grant.role })),
});
const tabsOf = (grants: Grant[]) => Object.fromEntries(visibleWorkspaces(navPermissions(access(...grants))).map(workspace => [workspace.key, workspace.tabs.map(tab => tab.href)]));

const viewerOnly = [{ code: 'CHE', role: 'viewer' }] as Grant[];
const staffChe = [{ code: 'CHE', role: 'staff' }] as Grant[];
const mixed = [{ code: 'CHE', role: 'viewer' }, { code: 'IMM', role: 'supervisor' }] as Grant[];
const adminChe = [{ code: 'CHE', role: 'admin' }] as Grant[];
const adminBoth = [{ code: 'CHE', role: 'admin' }, { code: 'IMM', role: 'admin' }] as Grant[];

test('a viewer sees the read-only tabs, and a workspace with nothing visible is dropped', () => {
  assert.deepEqual(tabsOf(viewerOnly), {
    dashboard: ['/', '/attention'],
    inventory: ['/stock', '/products', '/locations', '/reorder', '/vendors'],
    operations: ['/receive'],
    reports: ['/reports/monthly', '/movements'],
  });
});

test('CHE staff can work (issue, transfer, count) but not adjust, dispose, audit or administer', () => {
  assert.deepEqual(tabsOf(staffChe), {
    dashboard: ['/', '/attention'],
    inventory: ['/stock', '/products', '/locations', '/reorder', '/vendors'],
    operations: ['/receive', '/issue', '/transfer', '/counts'],
    reports: ['/reports/monthly', '/movements'],
  });
});

test('roles are per warehouse: a supervisor in one warehouse gets supervisor tabs, without the both-warehouse admin tabs', () => {
  assert.deepEqual(tabsOf(mixed), {
    dashboard: ['/', '/attention'],
    inventory: ['/stock', '/products', '/locations', '/reorder', '/vendors'],
    operations: ['/receive', '/issue', '/transfer', '/counts', '/adjust', '/dispose'],
    reports: ['/reports/monthly', '/movements', '/audit'],
    admin: ['/scan/review'],
  });
});

test('an admin of one warehouse cannot see the both-warehouse admin pages; an admin of both can', () => {
  assert.deepEqual(tabsOf(adminChe).admin, ['/scan/review']);
  assert.deepEqual(tabsOf(adminBoth).admin, ['/scan/review', '/import', '/admin/users']);
});

test('the desktop sidebar has five workspaces plus the Scan quick action', () => {
  assert.equal(visibleWorkspaces(navPermissions(access(...adminBoth))).length, 5);
  assert.equal(visibleWorkspaces(navPermissions(access(...viewerOnly))).length, 4);
  assert.equal(scanItem.href, '/scan');
  assert.ok(!workspaces.some(workspace => workspace.tabs.some(tab => tab.href === '/scan')), 'Scan stays a quick action, not a tab');
});

test('paused modules and their reports are hidden from navigation', () => {
  assert.deepEqual(workspaces.map(workspace => workspace.key), ['dashboard', 'inventory', 'operations', 'reports', 'admin']);
  const hrefs = workspaces.flatMap(workspace => workspace.tabs.map(tab => tab.href));
  for (const href of ['/morning-talk', '/morning-talk/history', '/morning-talk/actions', '/environment', '/environment/check', '/environment/history', '/environment/excursions', '/reports/morning-talk', '/reports/environment']) assert.ok(!hrefs.includes(href), `${href} stays out of navigation`);
});

test('paused modules stay out of navigation for every warehouse role', () => {
  for (const grants of [viewerOnly, staffChe, mixed, adminChe, adminBoth]) {
    const hrefs = Object.values(tabsOf(grants)).flat();
    assert.ok(!hrefs.some(href => href.startsWith('/morning-talk') || href.startsWith('/environment') || href === '/reports/morning-talk' || href === '/reports/environment'));
  }
});

test('paused module routes are outside navigation; active reports stay in Reports', () => {
  const at = (pathname: string) => { const found = activeTab(pathname); return found ? `${found.workspace.key}:${found.tab.href}` : null; };
  for (const pathname of ['/morning-talk', '/morning-talk/history', '/morning-talk/actions', '/morning-talk/new', '/morning-talk/0a1b2c/edit', '/environment', '/environment/check', '/environment/history', '/environment/excursions', '/reports/morning-talk', '/reports/environment']) assert.equal(at(pathname), null, `${pathname} has no navigation tab while paused`);
  assert.equal(at('/reports/monthly'), 'reports:/reports/monthly');
  assert.equal(at('/morning-talks'), null, 'a prefix must end at a path boundary');
  assert.equal(activeWorkspace('/morning-talk/history'), null);
  assert.equal(activeWorkspace('/reports/morning-talk'), null);
});

test('the mobile bottom bar is not changed by the new workspace', async () => {
  const { readFile } = await import('node:fs/promises');
  const bottom = await readFile(path.join(process.cwd(), 'src/components/bottom-nav.tsx'), 'utf8');
  assert.doesNotMatch(bottom, /morning/i, 'paused modules stay out of the mobile bottom bar');
  for (const label of ['ภาพรวม', 'คงคลัง', 'สแกน', 'รับเข้า', 'เพิ่มเติม']) assert.ok(bottom.includes(label), label);
});

test('navigation does not relax any authorization: every tab keeps its previous role gate', () => {
  const previous: Record<string, string | undefined> = {
    '/': undefined, '/attention': undefined, '/receive': undefined, '/issue': 'work', '/transfer': 'work', '/counts': 'work', '/adjust': 'supervise', '/dispose': 'supervise',
    '/products': undefined, '/stock': undefined, '/reorder': undefined, '/vendors': undefined, '/reports/monthly': undefined, '/movements': undefined,
    '/scan/review': 'supervise', '/locations': 'supervise', '/import': 'adminBoth', '/audit': 'supervise', '/admin/users': 'adminBoth',
  };
  for (const tab of workspaces.flatMap(workspace => workspace.tabs)) {
    if (tab.href === '/locations') { assert.equal(tab.need, undefined, 'the Locations tab is now visible to every role that can read a warehouse (navigation only)'); continue; }
    assert.equal(tab.need, previous[tab.href], tab.href);
  }
  assert.deepEqual(Object.keys(previous).sort(), workspaces.flatMap(workspace => workspace.tabs.map(tab => tab.href)).sort(), 'no route was added or lost');
});

test('a workspace opens on its first visible tab', () => {
  const staff = visibleWorkspaces(navPermissions(access(...staffChe)));
  assert.equal(workspaceHref(staff.find(workspace => workspace.key === 'operations')!), '/receive');
  const gated: Workspace = { key: 'admin', label: 'x', icon: House, tabs: [{ href: '/a', label: 'a', icon: House, need: 'adminBoth' }, { href: '/b', label: 'b', icon: House }] };
  assert.equal(workspaceHref(visibleWorkspaces({ work: true, supervise: true, adminBoth: false }, [gated])[0]), '/b');
  assert.deepEqual(visibleWorkspaces({ work: true, supervise: true, adminBoth: false }, [{ ...gated, tabs: [gated.tabs[0]] }]), []);
});

test('active tab uses the longest matching path and treats "/" as exact', () => {
  const at = (pathname: string) => { const found = activeTab(pathname); return found ? `${found.workspace.key}:${found.tab.href}` : null; };
  assert.equal(at('/'), 'dashboard:/');
  assert.equal(at('/attention'), 'dashboard:/attention');
  assert.equal(at('/stock'), 'inventory:/stock');
  assert.equal(at('/products/new'), 'inventory:/products');
  assert.equal(at('/products/0a1b2c'), 'inventory:/products');
  assert.equal(at('/vendors/new'), 'inventory:/vendors');
  assert.equal(at('/vendors/evaluation-policy'), 'inventory:/vendors');
  assert.equal(at('/vendors/abc/evaluations/def'), 'inventory:/vendors');
  assert.equal(at('/locations'), 'inventory:/locations');
  assert.equal(at('/locations/new'), 'inventory:/locations');
  assert.equal(at('/locations/qr'), 'inventory:/locations');
  assert.equal(at('/locations/abc/edit'), 'inventory:/locations');
  assert.equal(at('/counts/abc'), 'operations:/counts');
  assert.equal(at('/reports/monthly'), 'reports:/reports/monthly');
  assert.equal(at('/scan/review'), 'admin:/scan/review', '/scan/review belongs to Admin, not to the Scan quick action');
  assert.equal(at('/scan'), null, 'Scan is not a workspace tab');
  assert.equal(at('/account'), null);
  assert.equal(at('/more'), null);
  assert.equal(at('/unknown-page'), null);
  assert.equal(at('/stockroom'), null, 'a prefix must end at a path boundary');
  assert.equal(activeWorkspace('/adjust')?.key, 'operations', 'a page opened by direct link still shows its workspace even when the user lacks the tab');
});

test('longest-prefix and extra match prefixes decide between tabs (also for workspaces added later)', () => {
  const source: Workspace[] = [
    { key: 'reports', label: 'r', icon: House, tabs: [{ href: '/reports', label: 'r', icon: House }, { href: '/reports/morning-talk', label: 'mt', icon: House }] },
    { key: 'inventory', label: 'i', icon: House, tabs: [{ href: '/x', label: 'x', icon: House, match: ['/y/deep'] }] },
  ];
  assert.equal(activeTab('/reports/monthly', source)?.tab.href, '/reports');
  assert.equal(activeTab('/reports/morning-talk', source)?.tab.href, '/reports/morning-talk');
  assert.equal(activeTab('/reports/morning-talk/2026-09-26', source)?.tab.href, '/reports/morning-talk');
  assert.equal(activeTab('/y/deep/1', source)?.tab.href, '/x');
  assert.equal(activeTab('/y', source), null);
});

test('tab links keep only a valid warehouse selection and drop every other query parameter', () => {
  assert.equal(tabHref('/stock', 'CHE'), '/stock?warehouse=CHE');
  assert.equal(tabHref('/stock', 'IMM'), '/stock?warehouse=IMM');
  assert.equal(tabHref('/stock', 'XYZ'), '/stock');
  assert.equal(tabHref('/stock', 'CHE&q=stale'), '/stock');
  assert.equal(tabHref('/stock', null), '/stock');
  assert.equal(tabHref('/', undefined), '/');
});

function pageRoutes(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) return name === 'page.tsx' ? [prefix || '/'] : [];
    return pageRoutes(full, name.startsWith('(') ? prefix : `${prefix}/${name.replace(/^\[.+\]$/, 'sample')}`);
  });
}

test('every real page route belongs to exactly one workspace tab, or is one of the three explicit exceptions', () => {
  const routes = pageRoutes(path.join(process.cwd(), 'src/app/(app)'));
  assert.ok(routes.length > 25, 'the page scan found the app routes');
  const outside = new Set(['/scan', '/account', '/more']);
  const pausedModuleRoute = (route: string) => route.startsWith('/morning-talk') || route.startsWith('/environment') || route === '/reports/morning-talk' || route === '/reports/environment';
  const qrEntry = (route: string) => route === '/q/sample';
  for (const route of routes) {
    const owners = workspaces.flatMap(workspace => workspace.tabs.filter(tab => activeTab(route)?.tab === tab).map(() => workspace.key));
    if (outside.has(route) || qrEntry(route) || pausedModuleRoute(route)) { assert.equal(owners.length, 0, `${route} is intentionally outside the workspaces`); continue; }
    assert.equal(owners.length, 1, `${route} must belong to exactly one workspace tab`);
  }
  for (const tab of workspaces.flatMap(workspace => workspace.tabs)) assert.ok(routes.includes(tab.href), `${tab.href} must be a real page`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Desktop sidebar categories (pure helpers; the browser behaviour is covered by the Playwright suite)
// ---------------------------------------------------------------------------------------------------------------------
const categoriesFor = (grants: Grant[]) => sidebarCategories(navPermissions(access(...grants)));
const category = (grants: Grant[], key: string) => categoriesFor(grants).find(item => item.key === key)!;
const categoryHrefs = (grants: Grant[], key: string) => category(grants, key)?.groups.flatMap(g => g.items.map(i => i.href));

test('five named categories cover all five active workspaces', () => {
  assert.deepEqual(navCategories.map(c => c.key), ['home', 'stock', 'operations', 'reports', 'system']);
  const owned = navCategories.flatMap(c => c.workspaces);
  assert.deepEqual([...owned].sort(), workspaces.map(w => w.key).sort(), 'every workspace belongs to exactly one category');
});

test('every category still carries its full set of visible links (rendering collapses them, the data does not)', () => {
  const cats = categoriesFor(adminBoth);
  assert.deepEqual(Object.fromEntries(cats.map(c => [c.key, c.groups.flatMap(g => g.items.map(i => i.href))])), {
    home: ['/', '/attention'],
    stock: ['/stock', '/products', '/locations', '/reorder', '/vendors'],
    operations: ['/receive', '/issue', '/transfer', '/counts', '/adjust', '/dispose'],
    reports: ['/reports/monthly', '/movements', '/audit'],
    system: ['/scan/review', '/import', '/admin/users'],
  });
  for (const key of ['home', 'stock', 'operations', 'reports', 'system']) assert.equal(category(adminBoth, key).groups.length, 1, `${key} groups exactly one workspace`);
});

test('Home is the only non-collapsible category; every other category is collapsible', () => {
  assert.equal(category(adminBoth, 'home').collapsible, false);
  for (const key of ['stock', 'operations', 'reports', 'system']) assert.equal(category(adminBoth, key).collapsible, true, `${key} is collapsible`);
});

test('categoryForPathname resolves the category that owns the current route, or null outside every category', () => {
  assert.equal(categoryForPathname('/'), 'home');
  assert.equal(categoryForPathname('/attention'), 'home');
  assert.equal(categoryForPathname('/products/abc'), 'stock');
  assert.equal(categoryForPathname('/locations/abc/edit'), 'stock');
  assert.equal(categoryForPathname('/receive'), 'operations');
  assert.equal(categoryForPathname('/counts/abc'), 'operations');
  assert.equal(categoryForPathname('/morning-talk/history'), null);
  assert.equal(categoryForPathname('/environment/excursions/abc'), null);
  assert.equal(categoryForPathname('/reports/monthly'), 'reports');
  assert.equal(categoryForPathname('/admin/users'), 'system');
  assert.equal(categoryForPathname('/scan'), null, 'Scan is outside every category');
  assert.equal(categoryForPathname('/account'), null);
  assert.equal(categoryForPathname('/more'), null);
});

test('toggleCategory opens a closed category, closes the open one, and never leaves two open (single stored value)', () => {
  assert.equal(toggleCategory(null, 'reports'), 'reports');
  assert.equal(toggleCategory('stock', 'reports'), 'reports', 'opening a different category replaces the stored open key - there is only ever one');
  assert.equal(toggleCategory('reports', 'reports'), null, 'clicking the open category closes it');
});

test('role-restricted links are hidden, and an empty category is dropped entirely', () => {
  assert.equal(category(viewerOnly, 'system'), undefined, 'a viewer has no visible System link, so System is not rendered');
  assert.deepEqual(categoryHrefs(viewerOnly, 'stock'), ['/stock', '/products', '/locations', '/reorder', '/vendors'], 'read-only tabs stay visible to a viewer');
  assert.deepEqual(categoryHrefs(staffChe, 'operations'), ['/receive', '/issue', '/transfer', '/counts'], 'adjust/dispose need supervise');
  assert.deepEqual(categoryHrefs(mixed, 'system'), ['/scan/review'], 'a supervisor of one warehouse only sees the supervise-gated link');
});

test('relabelled links keep their route, need and icon: only the visible text changed', () => {
  const productsTab = workspaces.find(w => w.key === 'inventory')!.tabs.find(t => t.href === '/products')!;
  assert.equal(productsTab.label, 'ทะเบียนน้ำยา');
  assert.equal(productsTab.need, undefined);
  const importTab = workspaces.find(w => w.key === 'admin')!.tabs.find(t => t.href === '/import')!;
  assert.equal(importTab.label, 'นำเข้าทะเบียนน้ำยา');
  assert.equal(importTab.need, 'adminBoth');
});

test('the desktop tab strip is still mobile/tablet-only, and the sidebar is a category-level accordion (not workspace- or link-level)', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(css, /@media \(min-width: 801px\) \{ \.workspace-tabs \{ display: none; \} \}/);
  assert.match(css, /@media \(max-width: 800px\) \{[^}]*\n {2}\.app-grid \{ display: block; \}\n {2}\.sidebar \{ display: none; \}/, 'the sidebar is still hidden on narrow screens');
  assert.doesNotMatch(css, /\.shell \{/, 'the global centered shell restriction is removed');
  const shell = await readFile(path.join(process.cwd(), 'src/components/app-shell.tsx'), 'utf8');
  assert.match(shell, /<WorkspaceTabs /, 'the tab strip is still rendered for narrow screens');
  assert.doesNotMatch(shell, /\bshell\b/, 'the app-grid root no longer carries the centered shell class');
  const sidebar = await readFile(path.join(process.cwd(), 'src/components/side-nav.tsx'), 'utf8');
  assert.match(sidebar, /aria-expanded=\{expanded\}/, 'the category control exposes its state');
  assert.match(sidebar, /aria-controls=\{panelId\}/, 'the category control names its panel');
  assert.match(sidebar, /<button type="button" className="side-category"/, 'exactly one accordion control shape: the category button');
  assert.doesNotMatch(sidebar, /side-parent|className="side-sub"|side-child/, 'no leftover workspace-level accordion markup');
  // Only one accordion level: no second aria-expanded/button nested inside a tab list, and no per-link collapse state.
  const panelBlock = sidebar.slice(sidebar.indexOf('groups.map'), sidebar.indexOf('if (!collapsible)'));
  assert.doesNotMatch(panelBlock, /aria-expanded|<button/, 'nothing inside a category (workspace group or tab) is itself collapsible');
  assert.match(sidebar, /className="side-heading"/, "Home's heading renders as plain text, never a control");
  assert.match(sidebar, /className="side-link"/, 'every tab still renders as a direct link');
  assert.doesNotMatch(sidebar, /workspaces\.map|const .*= \[\s*\{ href/, 'the sidebar keeps no menu list of its own');
});
