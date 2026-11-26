import { notFound, redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadRoundDetail } from '@/lib/stock-count-data';
import { logUserMessage } from '@/lib/messages';
import { formatThaiDateTime } from '@/lib/format';
import { CountChecklist } from '@/components/count-checklist';
import { CountLoadError } from '@/components/count-load-error';

export default async function CountDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string; n?: string; partial?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <CountLoadError message="ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล" />;
  const result = await loadRoundDetail(client, access, id);
  if (result.error?.message.startsWith('REDIRECT:')) redirect(`/counts/${result.error.message.slice(9)}`);
  if (result.error) return <CountLoadError message={logUserMessage('count-detail', result.error, 'ระบบอ่านข้อมูลไม่สำเร็จ · กด “ลองใหม่” หรือกลับไปหน้ารอบตรวจนับ')} />;
  if (!result.data) notFound();
  const { round, lines } = result.data;
  const n = Number(query.n ?? 0).toLocaleString('th-TH');
  const notice = query.result === 'recount' ? `มี ${n} รายการที่ยอดในระบบเปลี่ยนระหว่างตรวจนับ · ระบบยังไม่ปรับยอด และเปิดรายการเหล่านั้นให้ตรวจใหม่ ส่วนรายการอื่นที่ตรวจไว้ยังบันทึกอยู่`
    : query.result === 'approved' ? `จบรอบแล้ว · ปรับยอด ${n} รายการ${query.partial ? ' · รายการที่ยังไม่ได้ตรวจคงยอดเดิม' : ''}`
    : query.result === 'already' ? 'รอบนี้จบแล้วก่อนหน้านี้ · ไม่มีการปรับยอดซ้ำ' : '';
  // Remount only when the round itself changes (finalized, reopened lines), never on a re-sent payload.
  const version = `${round.state}:${lines.filter(line => line.needsRecount).length}:${query.result ?? ''}`;
  return <CountChecklist key={version} initialNotice={notice} initialLines={lines} round={{
    id: round.id, createdAtText: formatThaiDateTime(round.createdAt), note: round.note, scopeLabel: round.scopeLabel,
    state: round.state, editable: round.editable, canEdit: round.canEdit, canFinalize: round.canFinalize,
    canDelete: round.canDelete, deletable: round.deletable,
  }} />;
}
