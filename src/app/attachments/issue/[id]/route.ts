import { NextResponse } from 'next/server';
import { getAccessContext } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { VENDOR_ISSUE_BUCKET } from '@/lib/vendor-issues';

// Vendor-issue evidence lives in a private bucket; RLS on the attachment row decides who may read it, then a 60-second signed URL is issued.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAccessContext()) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const client = await createClient();
  if (!client) return new Response('Unavailable', { status: 503 });
  const { data: attachment, error } = await client.from('ci_vendor_issue_attachments').select('object_key,file_name').eq('id', (await params).id).maybeSingle();
  if (error || !attachment) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const { data: signed, error: signError } = await client.storage.from(VENDOR_ISSUE_BUCKET).createSignedUrl(attachment.object_key, 60);
  if (signError || !signed) return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const response = NextResponse.redirect(signed.signedUrl);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
