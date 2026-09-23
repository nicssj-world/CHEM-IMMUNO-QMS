'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signInWithEphisId } from '@/lib/ephis-auth';

export async function signIn(formData: FormData) {
  const client = await createClient();
  if (!client) redirect('/login?error=configuration');
  const ephisId = String(formData.get('ephisId') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!await signInWithEphisId(client, ephisId, password)) redirect('/login?error=credentials');
  redirect('/');
}

export async function signOut() {
  const client = await createClient();
  if (client) await client.auth.signOut();
  redirect('/login');
}
