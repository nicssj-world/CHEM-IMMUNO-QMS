'use client';

import { useState } from 'react';
import { saveRelation } from '@/app/actions/products';

type ProductOption = { id: string; product_code: string; display_name: string; product_type: string };
type Relation = { id: string; source_product_id: string; target_product_id: string; relation_type: string; note: string | null };

const relationTypes = ['uses_calibrator','uses_control','uses_consumable','compatible_with','replacement_for','other'] as const;
const targetType: Record<string,string | undefined> = { uses_calibrator: 'calibrator', uses_control: 'control', uses_consumable: 'consumable' };

export function RelationEditor({ sourceId, options, relation }: { sourceId: string; options: ProductOption[]; relation?: Relation }) {
  const [kind,setKind] = useState(relation?.relation_type ?? 'uses_calibrator');
  const [query,setQuery] = useState('');
  const eligible = options.filter(p => p.id !== sourceId && (!targetType[kind] || p.product_type === targetType[kind]));
  const filtered = eligible.filter(p => `${p.product_code} ${p.display_name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const initialTarget = relation?.target_product_id;
  return <form action={saveRelation} className="grid gap-3 rounded-xl border border-[#dce7eb] p-4">
    <input type="hidden" name="source_product_id" value={sourceId}/>{relation && <input type="hidden" name="id" value={relation.id}/>}
    <div className="grid gap-3 sm:grid-cols-2"><label className="field">ความสัมพันธ์จากสินค้านี้<select name="relation_type" className="input" value={kind} onChange={e => setKind(e.target.value)}>{relationTypes.map(t => <option key={t} value={t}>{t}</option>)}</select></label><label className="field">ค้นหาเป้าหมาย<input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Product Code / ชื่อ"/></label></div>
    <label className="field">สินค้าเป้าหมาย<select className="input" name="target_product_id" defaultValue={initialTarget ?? ''} required><option value="">เลือกสินค้า</option>{filtered.map(p => <option value={p.id} key={p.id}>{p.product_code} · {p.display_name}</option>)}</select></label>
    <label className="field">หมายเหตุ<input className="input" name="note" defaultValue={relation?.note ?? ''} placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)"/></label>
    <p className="muted text-xs">แสดงเฉพาะสินค้าในคลังเดียวกันและชนิดเป้าหมายที่เข้ากัน ฐานข้อมูลตรวจซ้ำเมื่อบันทึก</p>
    <div><button className="button" type="submit">{relation ? 'บันทึกความสัมพันธ์' : 'เพิ่มความสัมพันธ์'}</button></div>
  </form>;
}
