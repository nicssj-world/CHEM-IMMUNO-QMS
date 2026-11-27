import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { canManageTalk, isOpenStatus, type TalkRow } from '@/lib/morning-talk';
import { TALK_COLUMNS, attachChildren, loadManageableScopes, loadNames, loadScopeMembers, userIdsOf } from '@/lib/morning-talk-data';
import { TalkForm } from '@/components/morning-talk/talk-form';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditMorningTalkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireAccess();
  const client = await createClient();
  if (!client || !uuid.test(id)) notFound();
  const { data } = await client.from('ci_morning_talks').select(TALK_COLUMNS).eq('id', id).maybeSingle();
  if (!data) notFound();
  const talkRow = data as TalkRow;
  const manageable = await loadManageableScopes(client);
  if (!canManageTalk(manageable, talkRow.scope) || talkRow.status !== 'active') redirect(`/morning-talk/${id}`);
  const detail = await attachChildren(client, [talkRow]);
  if (detail.error) return <main className="grid gap-4"><h1 className="page-title">แก้ไข Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-edit', detail.error)}</p></main>;
  const talk = detail.data[0];
  const warehouseId = talk.scope === 'ALL' ? null : Number(access.warehouses.find(item => item.code === talk.scope)?.id);
  const [members, names] = await Promise.all([loadScopeMembers(client, warehouseId), loadNames(client, userIdsOf(detail.data))]);
  if (members.error) return <main className="grid gap-4"><h1 className="page-title">แก้ไข Morning Talk</h1><p className="error" role="alert">อ่านรายชื่อไม่สำเร็จ: {logUserMessage('morning-talk-members', members.error)}</p></main>;
  return <main className="grid gap-5 max-w-[980px]"><div className="print-hide"><Link href={`/morning-talk/${id}`}>← กลับไปที่ Morning Talk</Link></div>
    <div><p className="eyebrow mb-2">Morning Talk</p><h1 className="page-title">แก้ไข Morning Talk</h1></div>
    <TalkForm mode="edit" scopes={[talk.scope]} talkId={talk.id} expectedUpdatedAt={talk.updated_at} cancelHref={`/morning-talk/${id}`}
      membersByScope={{ [talk.scope]: members.data }} previousByScope={{}} knownNames={Object.fromEntries(names)} lockedAttendees={talk.attendees.filter(item => item.acknowledged_at).map(item => item.user_id)}
      initial={{
        scope: talk.scope, talk_date: talk.talk_date, title: talk.title, agenda: talk.agenda ?? '', attendees: talk.attendees.map(item => item.user_id),
        checklist: talk.checklist.map(item => ({ key: `c-${item.id}`, id: item.id, title: item.title, completed: Boolean(item.completed_at) })),
        // Only open actions are editable here; done and cancelled ones stay as evidence and are left untouched by a save.
        actions: talk.actions.filter(item => isOpenStatus(item.status)).map(item => ({ key: `a-${item.id}`, id: item.id, expected_updated_at: item.updated_at, title: item.title, owner_id: item.owner_id, due_date: item.due_date ?? '', note: item.note ?? '' })),
      }} />
  </main>;
}
