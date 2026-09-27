import { appOrigin, isLocationQrToken } from './location-qr';
import { describeEnvConfig, type EnvConfigRow } from './locations';

export type EnvironmentReading = {
  id: string; warehouse_id: number; location_id: string; config_id: string;
  observed_at: string; recorded_at: string; check_date: string; round_no: number | null;
  entry_kind: 'original' | 'correction' | 'void'; corrects_reading_id: string | null;
  temperature_c: number | string | null; humidity_rh: number | string | null;
  temperature_status: string; humidity_status: string; overall_status: string;
  source: 'manual' | 'qr'; note: string | null; reason: string | null;
  entry_mode: 'live' | 'late'; excursion_id: string | null; recorded_by: string;
};
export type EnvironmentExcursion = {
  id: string; warehouse_id: number; location_id: string; opened_reading_id: string; opened_at: string;
  parameters: string[]; status: 'open' | 'acknowledged' | 'resolved'; immediate_action: string | null;
  acknowledged_by: string | null; acknowledged_at: string | null; resolution_note: string | null;
  equipment_referred: boolean; resolved_by: string | null; resolved_at: string | null;
};
export type DayRound = { location_id: string; round_no: number | null; due_time: string | null; state: 'satisfied' | 'due' | 'missed' | 'upcoming' | 'paused' | 'unscheduled' };
export type MonitorConfig = EnvConfigRow & { check_times: string[]; monitoring_state: 'active' | 'paused'; pause_reason: string | null };
export const ENV_CONFIG_COLUMNS = 'id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,rh_min_pct,rh_max_pct,check_times,monitoring_state,pause_reason';
export const ENV_READING_COLUMNS = 'id,warehouse_id,location_id,config_id,observed_at,recorded_at,check_date,round_no,entry_kind,corrects_reading_id,temperature_c,humidity_rh,temperature_status,humidity_status,overall_status,source,note,reason,entry_mode,excursion_id,recorded_by';
export const ENV_EXCURSION_COLUMNS = 'id,warehouse_id,location_id,opened_reading_id,opened_at,parameters,status,immediate_action,acknowledged_by,acknowledged_at,resolution_note,equipment_referred,resolved_by,resolved_at';

export function bangkokDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function bangkokMonth(now: Date = new Date()): string { return bangkokDate(now).slice(0, 7); }
export function environmentRange(config: MonitorConfig | null | undefined): string {
  const range = describeEnvConfig(config);
  return [range.temperature, range.humidity].filter(Boolean).join(' · ') || 'ยังไม่ตั้งช่วงเฝ้าระวัง';
}
export function readingValues(reading: Pick<EnvironmentReading, 'temperature_c' | 'humidity_rh'> | null | undefined): string {
  if (!reading) return 'ยังไม่มีค่าที่บันทึก';
  return [reading.temperature_c === null ? null : `${reading.temperature_c} °C`, reading.humidity_rh === null ? null : `${reading.humidity_rh} %RH`].filter(Boolean).join(' · ') || 'ไม่มีค่าที่ครบ';
}
export const ROUND_LABEL: Record<DayRound['state'], string> = {
  satisfied: 'ตรวจแล้ว', due: 'ถึงเวลาตรวจ', missed: 'ขาดการตรวจ', upcoming: 'ยังไม่ถึงเวลา',
  paused: 'หยุดเฝ้าระวัง', unscheduled: 'ยังไม่ตั้งเวลาตรวจ',
};
export const READING_LABEL: Record<string, string> = {
  in_range: 'อยู่ในช่วง', out_of_range: 'นอกช่วง', incomplete: 'บันทึกไม่ครบ', void: 'ยกเลิกข้อมูล',
};

/** The Environment scanner accepts only a label from this app (or its exact path form). */
export function parseEnvironmentQr(raw: string, origin: string = appOrigin()): string | null {
  const text = raw.trim();
  const path = /^\/q\/([0-9a-f]{32})\/?$/.exec(text);
  if (path) return path[1];
  try {
    const url = new URL(text);
    if (url.origin !== new URL(origin).origin || url.search || url.hash) return null;
    const token = /^\/q\/([0-9a-f]{32})\/?$/.exec(url.pathname)?.[1];
    return isLocationQrToken(token) ? token : null;
  } catch { return null; }
}

export function apparentOutOfRange(value: string, monitored: boolean, min: number | string | null, max: number | string | null): boolean {
  if (!monitored || value.trim() === '') return false;
  const number = Number(value.replace(/[−–—]/g, '-').replace(',', '.'));
  return Number.isFinite(number) && ((min !== null && number < Number(min)) || (max !== null && number > Number(max)));
}
