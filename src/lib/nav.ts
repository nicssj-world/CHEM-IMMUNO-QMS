import { ArrowLeftRight, ArrowUpFromLine, Boxes, ClipboardCheck, ClipboardList, FileUp, History, House, ListChecks, MapPin, NotebookTabs, PackagePlus, QrCode, ScanLine, ScrollText, ShieldCheck, SlidersHorizontal, Trash2, UserCog, Users, type LucideIcon } from 'lucide-react';
import type { AccessContext } from '@/lib/auth';

export type NavNeed = 'work' | 'supervise' | 'adminBoth';
export type NavItem = { href: string; label: string; icon: LucideIcon; need?: NavNeed };
export type NavGroup = { title: string; items: NavItem[] };
export type NavPermissions = Record<NavNeed, boolean>;

// One menu for the desktop sidebar and the mobile "More" page, so a page reachable on one is reachable on the other.
export const navGroups: NavGroup[] = [
  { title: 'ภาพรวม', items: [
    { href: '/', label: 'ภาพรวม', icon: House },
    { href: '/attention', label: 'รายการที่ต้องติดตาม', icon: ShieldCheck },
  ] },
  { title: 'งานประจำวัน', items: [
    { href: '/receive', label: 'รับเข้า', icon: PackagePlus },
    { href: '/issue', label: 'เบิกใช้', icon: ArrowUpFromLine, need: 'work' },
    { href: '/transfer', label: 'ย้ายที่เก็บ', icon: ArrowLeftRight, need: 'work' },
  ] },
  { title: 'ตรวจสอบและปรับปรุง', items: [
    { href: '/counts', label: 'ตรวจนับ', icon: ClipboardCheck, need: 'work' },
    { href: '/adjust', label: 'ปรับยอด', icon: ListChecks, need: 'supervise' },
    { href: '/dispose', label: 'กำจัดหมดอายุ', icon: Trash2, need: 'supervise' },
  ] },
  { title: 'ข้อมูลและรายงาน', items: [
    { href: '/products', label: 'สินค้า', icon: Boxes },
    { href: '/stock', label: 'คงคลัง', icon: ClipboardList },
    { href: '/reorder', label: 'ROP / สั่งซื้อ', icon: SlidersHorizontal },
    { href: '/vendors', label: 'ผู้ขาย', icon: Users },
    { href: '/reports/monthly', label: 'รายงานรายเดือน', icon: NotebookTabs },
    { href: '/movements', label: 'ประวัติ', icon: History },
  ] },
  { title: 'ผู้ดูแลระบบ', items: [
    { href: '/scan/review', label: 'คิวอนุมัติ Barcode', icon: QrCode, need: 'supervise' },
    { href: '/locations', label: 'ตำแหน่งจัดเก็บ', icon: MapPin, need: 'supervise' },
    { href: '/import', label: 'นำเข้าสินค้า', icon: FileUp, need: 'adminBoth' },
    { href: '/audit', label: 'บันทึกการตรวจสอบ', icon: ScrollText, need: 'supervise' },
    { href: '/admin/users', label: 'ผู้ใช้', icon: UserCog, need: 'adminBoth' },
  ] },
];

export const scanItem: NavItem = { href: '/scan', label: 'สแกน Barcode', icon: ScanLine };

export function navPermissions(access: AccessContext): NavPermissions {
  const has = (code: string) => access.warehouses.some(w => w.code === code && w.role === 'admin');
  return {
    work: access.warehouses.some(w => w.role !== 'viewer'),
    supervise: access.warehouses.some(w => w.role === 'admin' || w.role === 'supervisor'),
    adminBoth: has('CHE') && has('IMM'),
  };
}

export function visibleNavGroups(permissions: NavPermissions) {
  return navGroups
    .map(group => ({ ...group, items: group.items.filter(item => !item.need || permissions[item.need]) }))
    .filter(group => group.items.length > 0);
}

export function isActivePath(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
