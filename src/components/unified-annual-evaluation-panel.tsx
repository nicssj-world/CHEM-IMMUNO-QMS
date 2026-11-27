'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createUnifiedAnnualEvaluationDraft } from '@/app/actions/evaluation';
import type { Frozen } from '@/lib/vendor-evaluation';

type Report={id:string;fiscal_year:number;revision_number:number;status:'draft'|'final';report_number:string|null;frozen_snapshot:Frozen|null;};
export function UnifiedAnnualEvaluationPanel({vendorId,fiscalYear,revisions,canManage}:{vendorId:string;fiscalYear:number;revisions:Report[];canManage:boolean}) {
  const router=useRouter();
  const [pending,start]=useTransition();
  const [error,setError]=useState<string|null>(null);
  const draft=revisions.find(r=>r.fiscal_year===fiscalYear && r.status==='draft');
  function create() {
    setError(null);
    start(async()=>{
      const result=await createUnifiedAnnualEvaluationDraft(vendorId,fiscalYear);
      if(!result.ok) {setError(result.message);return;}
      router.push(`/vendors/${vendorId}/unified-evaluations/${result.data}`);
    });
  }
  return <section className="surface p-5 grid gap-4" aria-labelledby="unified-annual-title">
    <div><h2 id="unified-annual-title" className="font-bold text-lg">รายงานประเมินผู้ขายประจำปี · CHEM-IMMUNO</h2>
      <p className="muted text-sm mt-1">ใช้หลักฐานและคะแนนจากน้ำยาทุกกลุ่มร่วมกัน · ตรึงข้อมูลเมื่อรับรอง · เอกสารเดิมคงแยกตามหลักฐาน ณ วันที่จัดทำ</p></div>
    {canManage && <div><button className="button" type="button" disabled={pending} onClick={create}>{pending?'กำลังเปิดรายงาน…':draft?`แก้ไขฉบับร่าง ปี ${fiscalYear}`:`สร้างรายงานปี ${fiscalYear}`}</button></div>}
    {error && <p role="alert" className="error">{error}</p>}
    {revisions.length===0 ? <p className="muted text-sm">ยังไม่มีรายงานประเมินประจำปีของคลังรวม</p>:
      <div className="grid gap-2">{revisions.map(revision=><Link href={`/vendors/${vendorId}/unified-evaluations/${revision.id}`} key={revision.id} className="rounded-lg border border-line p-3 no-underline text-[var(--ink)] flex gap-3 justify-between">
        <span><strong>ปี {revision.fiscal_year} · ฉบับที่ {revision.revision_number}</strong><span className="muted text-xs block">{revision.report_number??'ฉบับร่าง'}</span></span>
        <span className="text-sm">{revision.status==='final'&&revision.frozen_snapshot?`${revision.frozen_snapshot.score}/100`:'ร่าง'}</span>
      </Link>)}</div>}
  </section>;
}
