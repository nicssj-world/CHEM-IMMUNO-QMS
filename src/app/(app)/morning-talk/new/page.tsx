import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { bangkokToday } from '@/lib/inventory-insights';
import { logUserMessage } from '@/lib/messages';
import { creatableScopes, type ScopeMember, type TalkScope } from '@/lib/morning-talk';
import { loadManageableScopes, loadPreviousTalk, loadScopeMembers } from '@/lib/morning-talk-data';
import { TalkForm, type PreviousTalk } from '@/components/morning-talk/talk-form';

export default async function NewMorningTalkPage() {
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">สร้าง Morning Talk</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  // Only the scopes this user may manage are offered, so ALL never appears for a supervisor of a single warehouse.
  const scopes = creatableScopes(await loadManageableScopes(client));
  if (scopes.length === 0) redirect('/morning-talk');
  const warehouseId = (scope: TalkScope) => (scope === 'ALL' ? null : Number(access.warehouses.find(item => item.code === scope)?.id));
  const membersByScope: Partial<Record<TalkScope, ScopeMember[]>> = {};
  const previousByScope: Partial<Record<TalkScope, PreviousTalk>> = {};
  for (const scope of scopes) {
    const [members, previous] = await Promise.all([loadScopeMembers(client, warehouseId(scope)), loadPreviousTalk(client, scope)]);
    if (members.error) return <main className="grid gap-4"><h1 className="page-title">สร้าง Morning Talk</h1><p className="error" role="alert">อ่านรายชื่อไม่สำเร็จ: {logUserMessage('morning-talk-members', members.error)}</p></main>;
    membersByScope[scope] = members.data;
    previousByScope[scope] = previous;
  }
  return <main className="grid gap-5 max-w-[980px]"><div className="print-hide"><Link href="/morning-talk">← Morning Talk วันนี้</Link></div>
    <div><p className="eyebrow mb-2">Morning Talk</p><h1 className="page-title">สร้าง Morning Talk</h1></div>
    <TalkForm mode="create" scopes={scopes} membersByScope={membersByScope} previousByScope={previousByScope} knownNames={{}} lockedAttendees={[]} cancelHref="/morning-talk"
      initial={{ scope: scopes[0], talk_date: bangkokToday(), title: '', agenda: '', attendees: [], checklist: [], actions: [] }} />
  </main>;
}
