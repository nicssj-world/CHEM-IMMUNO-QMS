import { AlertTriangle, CheckCircle2, Clock, CalendarClock } from 'lucide-react';
import { actionUrgency, type ActionRow } from '@/lib/morning-talk';

/** Urgency is always an icon plus a word, never colour alone. */
export function UrgencyBadge({ action, today }: { action: Pick<ActionRow, 'status' | 'due_date'>; today: string }) {
  const urgency = actionUrgency(action, today);
  if (action.status === 'done') return <span className="badge"><CheckCircle2 size={13} aria-hidden className="mr-1" />เสร็จแล้ว</span>;
  if (urgency === 'overdue') return <span className="badge" style={{ background: '#fff1f2', color: '#8c2534' }}><AlertTriangle size={13} aria-hidden className="mr-1" />เกินกำหนด</span>;
  if (urgency === 'due-soon') return <span className="badge" style={{ background: '#fffaf0', color: '#8a5a00' }}><Clock size={13} aria-hidden className="mr-1" />{action.due_date === today ? 'ครบกำหนดวันนี้' : 'ใกล้ครบกำหนด'}</span>;
  if (urgency === 'scheduled') return <span className="badge" style={{ background: '#eef3f5', color: '#455e6d' }}><CalendarClock size={13} aria-hidden className="mr-1" />มีกำหนด</span>;
  return null;
}
