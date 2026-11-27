import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { listEvaluationPolicies } from '@/lib/vendor-evaluation';
import { logUserMessage } from '@/lib/messages';
import { navPermissions } from '@/lib/nav';
import { VendorPolicyPanel } from '@/components/vendor-policy-panel';

// One QP for the whole work group: every signed-in user can read the policy, only an admin of both warehouses can change it.
export default async function EvaluationPolicyPage() {
  const access = await requireAccess();
  const client = await createClient();
  const { policies, error } = client ? await listEvaluationPolicies(client) : { policies: [], error: null };
  return <main className="grid gap-6 max-w-[1000px]">
    <div><Link href="/vendors" className="text-sm">← ผู้ขาย</Link><h1 className="page-title mt-2">นโยบายประเมินผู้ขาย</h1><p className="muted mt-2 text-sm">เวอร์ชัน น้ำหนักเกณฑ์ เกณฑ์ผ่าน และความครอบคลุมที่ใช้คำนวณรายงานประจำปี · ใช้ร่วมกันทั้งสองคลัง</p></div>
    {error && <p className="error" role="alert">อ่านนโยบายไม่สำเร็จ: {logUserMessage('policy', error)}</p>}
    <VendorPolicyPanel policies={policies} canManage={navPermissions(access).adminBoth} />
  </main>;
}
