import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { House } from 'lucide-react';
import {
  activeTab, activeWorkspace, navPermissions, scanItem, tabHref, visibleWorkspaces, workspaceHref, workspaces,
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

test('the desktop sidebar is compact: at most five workspaces plus the Scan quick action', () => {
  assert.equal(visibleWorkspaces(navPermissions(access(...adminBoth))).length, 5);
  assert.equal(visibleWorkspaces(navPermissions(access(...viewerOnly))).length, 4);
  assert.equal(scanItem.href, '/scan');
  assert.ok(!workspaces.some(workspace => workspace.tabs.some(tab => tab.href === '/scan')), 'Scan stays a quick action, not a tab');
});

test('no placeholder workspaces: Morning Talk and Temperature/Humidity are absent until they ship', () => {
  assert.deepEqual(workspaces.map(workspace => workspace.key), ['dashboard', 'inventory', 'operations', 'reports', 'admin']);
  const hrefs = workspaces.flatMap(workspace => workspace.tabs.map(tab => tab.href));
  assert.ok(!hrefs.some(href => /morning|environment|temperature/i.test(href)));
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
  const qrEntry = (route: string) => route === '/q/sample';
  for (const route of routes) {
    const owners = workspaces.flatMap(workspace => workspace.tabs.filter(tab => activeTab(route)?.tab === tab).map(() => workspace.key));
    if (outside.has(route) || qrEntry(route)) { assert.equal(owners.length, 0, `${route} is intentionally outside the workspaces`); continue; }
    assert.equal(owners.length, 1, `${route} must belong to exactly one workspace tab`);
  }
  for (const tab of workspaces.flatMap(workspace => workspace.tabs)) assert.ok(routes.includes(tab.href), `${tab.href} must be a real page`);
});
