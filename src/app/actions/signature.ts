'use server';

import sharp from 'sharp';
import { revalidatePath } from 'next/cache';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';

export type SignatureResult = { ok: true } | { ok: false; message: string };

const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 300_000;
const SIGNATURE_SIZE = { width: 900, height: 260 };

async function client() {
  await requireAccess();
  const supabase = await createClient();
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  return supabase;
}

/**
 * The browser sends whatever the user drew or picked; the server re-encodes it as a PNG that fits the report's signature box
 * (transparent background), so a stored signature is always a small, valid image regardless of what was uploaded.
 */
export async function saveMySignature(dataUrl: string): Promise<SignatureResult> {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl ?? '');
  if (!match) return { ok: false, message: 'รองรับเฉพาะไฟล์ภาพ PNG, JPG หรือ WebP' };
  const input = Buffer.from(match[2], 'base64');
  if (input.length < 100 || input.length > MAX_INPUT_BYTES) return { ok: false, message: 'ไฟล์ลายเซ็นต้องมีขนาดไม่เกิน 3 MB' };
  let png: Buffer;
  try {
    // Photographed or scanned signatures have a white page behind the ink; make near-white transparent so it prints cleanly on the report.
    const { data, info } = await sharp(input, { limitInputPixels: 25_000_000 }).rotate().resize({ ...SIGNATURE_SIZE, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) data[i + 3] = 0;
    }
    png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return { ok: false, message: 'อ่านไฟล์ภาพไม่สำเร็จ กรุณาใช้ไฟล์ภาพลายเซ็นอื่น' };
  }
  const encoded = `data:image/png;base64,${png.toString('base64')}`;
  if (encoded.length > MAX_OUTPUT_CHARS) return { ok: false, message: 'ลายเซ็นมีรายละเอียดมากเกินไป กรุณาเซ็นให้เรียบง่ายขึ้น' };
  const supabase = await client();
  const { error } = await supabase.rpc('ci_save_my_signature', { p_png: encoded });
  if (error) return { ok: false, message: logUserMessage('saveMySignature', error, 'บันทึกลายเซ็นไม่สำเร็จ') };
  revalidatePath('/account');
  return { ok: true };
}

export async function clearMySignature(): Promise<SignatureResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_clear_my_signature');
  if (error) return { ok: false, message: logUserMessage('clearMySignature', error) };
  revalidatePath('/account');
  return { ok: true };
}

export async function setUserPosition(userId: string, position: string): Promise<SignatureResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_set_user_position', { p_user_id: userId, p_position: position.trim() || null });
  if (error) return { ok: false, message: logUserMessage('setUserPosition', error, 'บันทึกตำแหน่งไม่สำเร็จ') };
  revalidatePath('/account');
  revalidatePath('/admin/users');
  return { ok: true };
}
