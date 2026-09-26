import { ArrowLeftRight, ArrowUpFromLine, Boxes, ClipboardCheck, ClipboardList, FileUp, History, House, ListChecks, MapPin, NotebookTabs, PackagePlus, QrCode, ScanLine, ScrollText, ShieldCheck, SlidersHorizontal, Trash2, UserCog, Users, Wrench, type LucideIcon } from 'lucide-react';
import type { AccessContext } from '@/lib/auth';

// Navigation groups routes into workspaces. It changes where a link is shown, never who may use the page: every page, server
// action and database function still enforces its own role check, and a tab that needs a role is simply not listed without it.

export type NavNeed = 'work' | 'supervise' | 'adminBoth';
export type NavItem = { href: string; label: string; icon: LucideIcon; need?: NavNeed };
/** `match` lists extra path prefixes that keep the tab active, for routes whose URL does not start with the tab's own href. */
export type WorkspaceTab = NavItem & { match?: string[] };
export type WorkspaceKey = 'dashboard' | 'morning-talk' | 'inventory' | 'operations' | 'environment' | 'reports' | 'admin';
export type Workspace = { key: WorkspaceKey; label: string; icon: LucideIcon; tabs: WorkspaceTab[] };
export type NavPermissions = Record<NavNeed, boolean>;

// Only workspaces that exist today are listed. Morning Talk and Temperature/Humidity join this array when they ship, with no
// other change to the sidebar, tabs or the mobile "More" page (all of them read this one list).
export const workspaces: Workspace[] = [
  { key: 'dashboard', label: 'ภาพรวม', icon: House, tabs: [
    { href: '/', label: 'ภาพรวม', icon: House },
    { href: '/attention', label: 'รายการที่ต้องติดตาม', icon: ShieldCheck },
  ] },
  { key: 'inventory', label: 'คลังสินค้า', icon: Boxes, tabs: [
    { href: '/stock', label: 'คงคลัง', icon: ClipboardList },
    { href: '/products', label: 'สินค้า', icon: Boxes },
    // Every role that can open a warehouse can read its locations; creating and editing them is gated inside the pages.
    { href: '/locations', label: 'ตำแหน่งจัดเก็บ', icon: MapPin },
    { href: '/reorder', label: 'ROP / สั่งซื้อ', icon: SlidersHorizontal },
    { href: '/vendors', label: 'ผู้ขาย', icon: Users },
  ] },
  { key: 'operations', label: 'ปฏิบัติงาน', icon: Wrench, tabs: [
    { href: '/receive', label: 'รับเข้า', icon: PackagePlus },
    { href: '/issue', label: 'เบิกใช้', icon: ArrowUpFromLine, need: 'work' },
    { href: '/transfer', label: 'ย้ายที่เก็บ', icon: ArrowLeftRight, need: 'work' },
    { href: '/counts', label: 'ตรวจนับ', icon: ClipboardCheck, need: 'work' },
    { href: '/adjust', label: 'ปรับยอด', icon: ListChecks, need: 'supervise' },
    { href: '/dispose', label: 'กำจัดหมดอายุ', icon: Trash2, need: 'supervise' },
  ] },
  { key: 'reports', label: 'รายงาน', icon: NotebookTabs, tabs: [
    { href: '/reports/monthly', label: 'รายงานรายเดือน', icon: NotebookTabs },
    { href: '/movements', label: 'ประวัติเคลื่อนไหว', icon: History },
    { href: '/audit', label: 'บันทึกการตรวจสอบ', icon: ScrollText, need: 'supervise' },
  ] },
  { key: 'admin', label: 'จัดการระบบ', icon: UserCog, tabs: [
    { href: '/scan/review', label: 'คิวอนุมัติ Barcode', icon: QrCode, need: 'supervise' },
    { href: '/import', label: 'นำเข้าสินค้า', icon: FileUp, need: 'adminBoth' },
    { href: '/admin/users', label: 'ผู้ใช้', icon: UserCog, need: 'adminBoth' },
  ] },
];

/** Scan stays a prominent quick action instead of a tab, so it is reachable in one tap from any workspace. */
export const scanItem: NavItem = { href: '/scan', label: 'สแกน Barcode', icon: ScanLine };

export function navPermissions(access: AccessContext): NavPermissions {
  const has = (code: string) => access.warehouses.some(w => w.code === code && w.role === 'admin');
  return {
    work: access.warehouses.some(w => w.role !== 'viewer'),
    supervise: access.warehouses.some(w => w.role === 'admin' || w.role === 'supervisor'),
    adminBoth: has('CHE') && has('IMM'),
  };
}

/** Workspaces with only the tabs this user may see; a workspace with no visible tab is dropped. */
export function visibleWorkspaces(permissions: NavPermissions, source: readonly Workspace[] = workspaces): Workspace[] {
  return source
    .map(workspace => ({ ...workspace, tabs: workspace.tabs.filter(tab => !tab.need || permissions[tab.need]) }))
    .filter(workspace => workspace.tabs.length > 0);
}

/** A workspace's landing page is its first visible tab, so a role that lacks the first tab still gets a working link. */
export function workspaceHref(workspace: Workspace) { return workspace.tabs[0]?.href ?? '/'; }

export function isActivePath(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** How well a path matches a tab: the length of the longest matching prefix, or -1. `/` matches only itself. */
function matchLength(pathname: string, tab: WorkspaceTab) {
  let best = -1;
  for (const prefix of [tab.href, ...(tab.match ?? [])]) if (isActivePath(pathname, prefix)) best = Math.max(best, prefix.length);
  return best;
}

/**
 * The tab a path belongs to, over ALL tabs (not only the visible ones) so a page opened by direct link still shows its own
 * workspace. The longest matching prefix wins, so `/scan/review` belongs to Admin and never to the `/scan` quick action.
 */
export function activeTab(pathname: string, source: readonly Workspace[] = workspaces): { workspace: Workspace; tab: WorkspaceTab } | null {
  let best: { workspace: Workspace; tab: WorkspaceTab; length: number } | null = null;
  for (const workspace of source) for (const tab of workspace.tabs) {
    const length = matchLength(pathname, tab);
    if (length > (best?.length ?? -1)) best = { workspace, tab, length };
  }
  return best ? { workspace: best.workspace, tab: best.tab } : null;
}
export function activeWorkspace(pathname: string, source: readonly Workspace[] = workspaces) { return activeTab(pathname, source)?.workspace ?? null; }

/** Tabs keep the selected warehouse and drop every other query parameter, so a stale search or filter never follows the user. */
export function tabHref(href: string, warehouse: string | null | undefined) {
  return warehouse === 'CHE' || warehouse === 'IMM' ? `${href}?warehouse=${warehouse}` : href;
}

// ---------------------------------------------------------------------------
// Desktop sidebar accordion. Pure helpers over the same workspace list, so the sidebar, the mobile tab strip and /more can
// never disagree about which pages exist, which the user may see, or which one is current.
// ---------------------------------------------------------------------------
export type SidebarSection = {
  workspace: Workspace;
  /** The workspace the current page belongs to. */
  active: boolean;
  /** The workspace's list is fully open (one workspace at a time). */
  expanded: boolean;
  /** Links to render: every visible tab when expanded; only the current page when collapsed but active; otherwise none. */
  tabs: WorkspaceTab[];
  /** href of the tab that is the current page, if it is among the visible tabs. */
  activeHref: string | null;
};

/** The workspace that should be open for a path (null for /scan, /account, /more and other pages outside the workspaces). */
export function openWorkspaceFor(pathname: string, source: readonly Workspace[] = workspaces): WorkspaceKey | null {
  return activeWorkspace(pathname, source)?.key ?? null;
}

/** Clicking a workspace opens it; clicking the open one closes it. Only one is ever open. */
export function toggleWorkspace(open: WorkspaceKey | null, key: WorkspaceKey): WorkspaceKey | null {
  return open === key ? null : key;
}

/**
 * What the desktop sidebar shows. The active page is never hidden: collapsing the active workspace leaves just its current
 * page visible, so the user can always see where they are.
 */
export function sidebarSections(permissions: NavPermissions, pathname: string, open: WorkspaceKey | null, source: readonly Workspace[] = workspaces): SidebarSection[] {
  const current = activeTab(pathname, source);
  return visibleWorkspaces(permissions, source).map(workspace => {
    const active = current?.workspace.key === workspace.key;
    const expanded = open === workspace.key;
    const currentTab = active ? workspace.tabs.find(tab => tab.href === current.tab.href) : undefined;
    return { workspace, active, expanded, tabs: expanded ? workspace.tabs : currentTab ? [currentTab] : [], activeHref: currentTab?.href ?? null };
  });
}
