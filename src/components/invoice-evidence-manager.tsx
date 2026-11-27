'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {createClient} from '@supabase/supabase-js';
import {registerInvoiceAttachment} from '@/app/actions/scanner';
import {userMessage} from '@/lib/messages';

type Attachment={id:string;attachment_type:string;uploaded_at:string};
export function InvoiceEvidenceManager({invoiceId,warehouseId,canUpload,initialAttachments}:{
  invoiceId:string;warehouseId:number|null;canUpload:boolean;initialAttachments:Attachment[];
}){
  const router=useRouter();
  const [file,setFile]=useState<File|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [pending,start]=useTransition();
  function upload(){
    if(!file || !warehouseId || !canUpload)return;
    if(file.size>10*1024*1024 || !(file.type.startsWith('image/')||file.type==='application/pdf')){
      setError('เลือกภาพหรือ PDF ขนาดไม่เกิน 10 MB');return;
    }
    setError('');setNotice('');
    start(async()=>{
      try{
        const authorization=await registerInvoiceAttachment(invoiceId,warehouseId,{type:file.type,size:file.size});
        const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
        if(!url||!key)throw new Error('ระบบจัดเก็บไฟล์ยังไม่พร้อม');
        const storage=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
        const {error:uploadError}=await storage.storage.from('ci-invoice-evidence')
          .uploadToSignedUrl(authorization.object_key,authorization.token,file,{contentType:file.type});
        if(uploadError)throw uploadError;
        setFile(null);setNotice('แนบเอกสารสำเร็จ');router.refresh();
      }catch(cause){setError(userMessage(cause instanceof Error?cause.message:null,'แนบเอกสารไม่สำเร็จ'))}
    });
  }
  return <section className="surface p-4 sm:p-5 grid gap-3" aria-label="เอกสารแนบ Invoice">
    <h3 className="font-bold">เอกสารแนบ Invoice</h3>
    <div className="grid gap-2">{initialAttachments.map(item=>
      <a key={item.id} className="button secondary justify-self-start" href={'/attachments/'+item.id} target="_blank" rel="noopener noreferrer">
        ดูเอกสาร · {new Date(item.uploaded_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}
      </a>)}
      {!initialAttachments.length&&<p className="muted text-sm">ยังไม่มีเอกสารแนบ</p>}
    </div>
    {canUpload && warehouseId!==null && <div className="grid gap-2">
      <label className="field">เพิ่มภาพหรือ PDF ของ Invoice (ไม่เกิน 10 MB)
        <input type="file" className="input" accept="image/*,application/pdf"
          onChange={event=>{setFile(event.target.files?.[0]??null);setError('');}}/>
      </label>
      <button className="button justify-self-start" type="button" disabled={!file || pending} onClick={upload}>
        {pending?'กำลังอัปโหลด…':'แนบเอกสาร'}
      </button>
    </div>}
    {error&&<p className="error" role="alert">{error}</p>}
    {notice&&<p className="notice" role="status">{notice}</p>}
  </section>;
}
