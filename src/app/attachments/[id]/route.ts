import { NextResponse } from 'next/server';
import { getAccessContext } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

export async function GET(_request: Request, {params}:{params:Promise<{id:string}>}) {
  if (!await getAccessContext()) return new Response('Unauthorized',{status:401,headers:{'Cache-Control':'no-store'}});
  const client=await createClient();
  if (!client) return new Response('Unavailable',{status:503});
  const {data:attachment,error}=await client.from('ci_attachments').select('object_key').eq('id',(await params).id).maybeSingle();
  if(error||!attachment)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
  const {data:signed,error:signError}=await client.storage.from('ci-invoice-evidence').createSignedUrl(attachment.object_key,60);
  if(signError||!signed)return new Response('Unavailable',{status:503,headers:{'Cache-Control':'no-store'}});
  const response=NextResponse.redirect(signed.signedUrl);
  response.headers.set('Cache-Control','no-store');
  return response;
}
