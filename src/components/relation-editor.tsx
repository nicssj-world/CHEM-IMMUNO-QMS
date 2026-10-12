'use client';

import { useState } from 'react';
import { saveRelation } from '@/app/actions/products';
import { label, relationTypeLabels } from '@/lib/labels';
import { SubmitButton } from './submit-button';
import { InvoiceReagentPicker } from './invoice-reagent-picker';

type ProductOption = { id: string; product_code: string; display_name: string; product_type: string };
type Relation = { id: string; source_product_id: string; target_product_id: string; relation_type: string; note: string | null };

const relationTypes = ['uses_calibrator','uses_control','uses_consumable','compatible_with','replacement_for','other'] as const;
const targetType: Record<string,string | undefined> = { uses_calibrator: 'calibrator', uses_control: 'control', uses_consumable: 'consumable' };

export function RelationEditor({ sourceId, options, relation }: { sourceId: string; options: ProductOption[]; relation?: Relation }) {
  const [kind,setKind] = useState(relation?.relation_type ?? 'uses_calibrator');
  const [targetId,setTargetId] = useState(relation?.target_product_id ?? '');
  const eligible = options.filter(p => p.id !== sourceId && (!targetType[kind] || p.product_type === targetType[kind]));
  return <form action={saveRelation} className="grid gap-3 rounded-xl border border-line p-4">
    <input type="hidden" name="source_product_id" value={sourceId}/>{relation && <input type="hidden" name="id" value={relation.id}/>}
    <label className="field">ความสัมพันธ์จากน้ำยานี้
      <select name="relation_type" className="input" value={kind} onChange={e => {
        const nextKind=e.target.value;setKind(nextKind);
        if(!options.some(p=>p.id===targetId&&(!targetType[nextKind]||p.product_type===targetType[nextKind])))setTargetId('');
      }}>{relationTypes.map(t => <option key={t} value={t}>{label(relationTypeLabels,t)}</option>)}</select>
    </label>
    <input type="hidden" name="target_product_id" value={targetId}/>
    <InvoiceReagentPicker products={eligible} value={targetId} onChange={setTargetId}
      label="น้ำยาเป้าหมาย" hint="ค้นหาตามรหัสหรือชื่อ โดยแสดงเฉพาะน้ำยาประเภทที่สัมพันธ์กัน"/>
    <label className="field">หมายเหตุ<input className="input" name="note" defaultValue={relation?.note ?? ''} placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)"/></label>
    <p className="muted text-xs">แสดงเฉพาะน้ำยาในคลังเดียวกันและชนิดเป้าหมายที่เข้ากัน ฐานข้อมูลตรวจซ้ำเมื่อบันทึก</p>
    <div><SubmitButton className="button" disabled={!targetId} label={relation ? 'บันทึกความสัมพันธ์' : 'เพิ่มความสัมพันธ์'}/></div>
  </form>;
}
