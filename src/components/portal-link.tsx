import { ExternalLink } from 'lucide-react';
import { validatePortalEquipmentUrl } from '@/lib/portal-link';

/**
 * Link to the equipment page in the Lab Management Portal. The stored value is re-validated on every render: a value that no
 * longer passes (for example after the Portal domain changed) becomes an unavailable-link notice, never a clickable link.
 */
export function PortalLink({ url, label, context }: { url: string | null; label?: string | null; context?: string }) {
  if (!url) return null;
  const checked = validatePortalEquipmentUrl(url);
  if (!checked.ok) {
    return <p className="notice text-sm" role="status">ลิงก์เครื่องมือใน Portal{context ? ` (${context})` : ''} ใช้งานไม่ได้ · ไม่ได้อยู่ในรายการโดเมนที่อนุญาตหรือรูปแบบไม่ถูกต้อง · ให้หัวหน้างานแก้ไขลิงก์ที่หน้าแก้ไขตำแหน่ง</p>;
  }
  const name = label?.trim();
  return <a href={checked.url} target="_blank" rel="noopener noreferrer" className="button secondary" aria-label={`เปิดเครื่องมือใน Portal${name ? `: ${name}` : ''}${context ? ` (${context})` : ''} (เปิดในหน้าต่างใหม่)`}>
    <ExternalLink size={16} aria-hidden />เปิดเครื่องมือใน Portal{name ? <span className="font-normal muted">· {name}</span> : null}
  </a>;
}
