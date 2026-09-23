'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function signIn(formData: FormData) {
  const client = await createClient();
  if (!client) redirect('/login?error=configuration');
  const ephisId = String(formData.get('ephisId') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(ephisId) || !password) redirect('/login?error=credentials');
  // Provisioning must explicitly bind Ephis IDs to Supabase Auth addresses in this domain.
  // Until an administrator selects a domain, authentication fails closed.
  const domain = process.env.EPHIS_AUTH_DOMAIN;
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) redirect('/login?error=configuration');
  const email = `${ephisId}@${domain}`;
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) redirect('/login?error=credentials');
  redirect('/');
}

export async function signOut() {
  const client = await createClient();
  if (client) await client.auth.signOut();
  redirect('/login');
}
