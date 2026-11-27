import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/auth';
import { canMutateRole, canSuperviseRole } from '@/lib/auth-identity';
import { roundDeletable, roundEditable, roundState, scopeLabel, type ChecklistLine, type CountProgress, type RoundState } from '@/lib/stock-count';

type DbError = { message: string; code?: string };
type Result<T> = { data: T; error: null } | { data: null; error: DbError };
const PAGE = 1000;
const CHUNK = 150; // keeps `id=in.(…)` URLs well below proxy limits

/** Reads every row of a query page by page and refuses to return a silently truncated list. */
export async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbError | null; count?: number | null }>): Promise<Result<T[]>> {
  const rows: T[] = [];
  let expected: number | null = null;
  for (let from = 0; from < 200_000; from += PAGE) {
    const response = await page(from, from + PAGE - 1);
    if (response.error) return { data: null, error: response.error };
    if (expected === null && typeof response.count === 'number') expected = response.count;
    rows.push(...(response.data ?? []));
    if ((response.data ?? []).length < PAGE) break;
  }
  if (expected !== null && rows.length !== expected) return { data: null, error: { message: 'CI_COUNT_LINES_INCOMPLETE' } };
  return { data: rows, error: null };
}

/** One query per 150 ids (never one per row). */
export async function readByIds<T>(ids: readonly string[], query: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: DbError | null }>): Promise<Result<T[]>> {
  const unique = [...new Set(ids)];
  const rows: T[] = [];
  for (let index = 0; index < unique.length; index += CHUNK) {
    const response = await query(unique.slice(index, index + CHUNK));
    if (response.error) return { data: null, error: response.error };
    rows.push(...(response.data ?? []));
  }
  return { data: rows, error: null };
}

type CountRow = { id: string; warehouse_id: number; status: string; created_at: string; created_by: string; approved_at: string | null; note: string | null };
type BatchRow = { id: string; created_at: string; created_by: string; note: string | null; che_count_id: string | null; imm_count_id: string | null; scope_type: string | null; scope: Record<string, unknown> | null };
type ProgressRow = { count_id: string; total_lines: number; counted_lines: number; variance_lines: number; recount_lines: number };

export type RoundSummary = {
  id: string; kind: 'unified' | 'legacy'; createdAt: string; createdBy: string; note: string | null;
  scopeLabel: string; state: RoundState; progress: CountProgress; memberIds: string[]; warehouseIds: number[];
  deletable: boolean; canDelete: boolean; editable: boolean; canEdit: boolean; canFinalize: boolean;
};

function permissions(access: AccessContext, members: CountRow[], createdBy: string) {
  const roleOf = (warehouseId: number) => access.warehouses.find(w => Number(w.id) === warehouseId)?.role;
  const every = (test: (role: string | undefined) => boolean) => members.length > 0 && members.every(member => test(roleOf(Number(member.warehouse_id))));
  const statuses = members.map(member => member.status);
  return {
    deletable: roundDeletable(statuses),
    canDelete: every(role => role === 'admin') || (createdBy === access.userId && every(role => Boolean(role) && canMutateRole(role as never))),
    editable: roundEditable(statuses),
    canEdit: every(role => Boolean(role) && canMutateRole(role as never)),
    canFinalize: every(role => Boolean(role) && canSuperviseRole(role as never)),
  };
}

function summary(kind: 'unified' | 'legacy', id: string, createdAt: string, createdBy: string, note: string | null, label: string,
  memberIds: string[], counts: Map<string, CountRow>, progress: Map<string, ProgressRow>, access: AccessContext): RoundSummary {
  const members = memberIds.map(memberId => counts.get(memberId));
  const known = members.filter((member): member is CountRow => Boolean(member));
  const total = memberIds.reduce((sum, memberId) => {
    const row = progress.get(memberId);
    return { total: sum.total + (row?.total_lines ?? 0), counted: sum.counted + (row?.counted_lines ?? 0),
      variance: sum.variance + (row?.variance_lines ?? 0), recount: sum.recount + (row?.recount_lines ?? 0) };
  }, { total: 0, counted: 0, variance: 0, recount: 0 });
  return { id, kind, createdAt, createdBy, note, scopeLabel: label,
    state: roundState(members.map(member => member?.status), total), progress: total, memberIds,
    warehouseIds: known.map(member => Number(member.warehouse_id)), ...permissions(access, known.length === memberIds.length ? known : [], createdBy) };
}

/** The round list: unified rounds first, older single-group counts kept readable underneath. */
export async function loadRoundSummaries(client: SupabaseClient, access: AccessContext): Promise<Result<{ rounds: RoundSummary[]; legacy: RoundSummary[] }>> {
  const [batchResult, countResult] = await Promise.all([
    client.from('ci_unified_stock_counts').select('id,created_at,created_by,note,che_count_id,imm_count_id,scope_type,scope')
      .order('created_at', { ascending: false }).limit(200),
    client.from('ci_stock_counts').select('id,warehouse_id,status,created_at,created_by,approved_at,note')
      .order('created_at', { ascending: false }).limit(400),
  ]);
  if (batchResult.error) return { data: null, error: batchResult.error };
  if (countResult.error) return { data: null, error: countResult.error };
  const batches = (batchResult.data ?? []) as BatchRow[];
  const counts = new Map(((countResult.data ?? []) as CountRow[]).map(row => [row.id, row]));
  const grouped = new Set(batches.flatMap(batch => [batch.che_count_id, batch.imm_count_id]).filter((id): id is string => Boolean(id)));
  const progressResult = await readByIds<ProgressRow>([...counts.keys()], chunk =>
    client.from('ci_stock_count_progress').select('count_id,total_lines,counted_lines,variance_lines,recount_lines').in('count_id', chunk));
  if (progressResult.error) return { data: null, error: progressResult.error };
  const progress = new Map(progressResult.data.map(row => [row.count_id, row]));
  const rounds = batches.map(batch => summary('unified', batch.id, batch.created_at, batch.created_by, batch.note,
    scopeLabel(batch.scope_type, batch.scope as never), [batch.che_count_id, batch.imm_count_id].filter((id): id is string => Boolean(id)), counts, progress, access));
  const legacy = [...counts.values()].filter(count => !grouped.has(count.id)).map(count => summary('legacy', count.id, count.created_at,
    count.created_by, count.note, `รอบเดิม · ${access.warehouses.find(w => Number(w.id) === Number(count.warehouse_id))?.name ?? ''}`.trim(), [count.id], counts, progress, access));
  return { data: { rounds, legacy }, error: null };
}

type LineRow = { id: string; count_id: string; warehouse_id: number; lot_id: string; location_id: string; snapshot_quantity: number | string; physical_quantity: number | string | null; counted_at: string | null; needs_recount: boolean };
type LotRow = { id: string; lot_number: string; expiry_date: string | null; product_id: string };
type ProductRow = { id: string; product_code: string; display_name: string; base_stock_unit: string };
type LocationRow = { id: string; code: string; name: string | null };

export type RoundDetail = { round: RoundSummary; lines: ChecklistLine[] };

/**
 * Loads a round and all its lines. Location codes are looked up in ci_locations directly: count lines
 * reference the shared location mapping (ci_location_warehouses), which PostgREST cannot embed.
 */
export async function loadRoundDetail(client: SupabaseClient, access: AccessContext, roundId: string): Promise<Result<RoundDetail | null>> {
  const batchResult = await client.from('ci_unified_stock_counts')
    .select('id,created_at,created_by,note,che_count_id,imm_count_id,scope_type,scope').eq('id', roundId).maybeSingle();
  if (batchResult.error) return { data: null, error: batchResult.error };
  const batch = batchResult.data as BatchRow | null;
  const memberIds = batch ? [batch.che_count_id, batch.imm_count_id].filter((id): id is string => Boolean(id)) : [roundId];
  const countResult = await client.from('ci_stock_counts').select('id,warehouse_id,status,created_at,created_by,approved_at,note').in('id', memberIds);
  if (countResult.error) return { data: null, error: countResult.error };
  const countRows = (countResult.data ?? []) as CountRow[];
  if (!batch && !countRows.length) return { data: null, error: null };
  if (!batch) {
    // A member of a unified round is opened through its round, never on its own.
    const parent = await client.from('ci_unified_stock_counts').select('id').or(`che_count_id.eq.${roundId},imm_count_id.eq.${roundId}`).maybeSingle();
    if (parent.error) return { data: null, error: parent.error };
    if (parent.data) return { data: null, error: { message: `REDIRECT:${parent.data.id}` } };
  }
  const counts = new Map(countRows.map(row => [row.id, row]));
  const lineResult = await readAll<LineRow>((from, to) => client.from('ci_stock_count_lines')
    .select('id,count_id,warehouse_id,lot_id,location_id,snapshot_quantity,physical_quantity,counted_at,needs_recount', { count: 'exact' })
    .in('count_id', memberIds).order('id').range(from, to));
  if (lineResult.error) return { data: null, error: lineResult.error };
  const rows = lineResult.data;
  const lotResult = await readByIds<LotRow>(rows.map(row => row.lot_id), chunk => client.from('ci_stock_lots').select('id,lot_number,expiry_date,product_id').in('id', chunk));
  if (lotResult.error) return { data: null, error: lotResult.error };
  const lots = new Map(lotResult.data.map(row => [row.id, row]));
  const [productResult, locationResult] = await Promise.all([
    readByIds<ProductRow>(lotResult.data.map(row => row.product_id), chunk => client.from('ci_products').select('id,product_code,display_name,base_stock_unit').in('id', chunk)),
    readByIds<LocationRow>(rows.map(row => row.location_id), chunk => client.from('ci_locations').select('id,code,name').in('id', chunk)),
  ]);
  if (productResult.error) return { data: null, error: productResult.error };
  if (locationResult.error) return { data: null, error: locationResult.error };
  const products = new Map(productResult.data.map(row => [row.id, row]));
  const locations = new Map(locationResult.data.map(row => [row.id, row]));
  // Every line must resolve to a product, LOT and location; a partial list must never be approved.
  const lines: ChecklistLine[] = [];
  for (const row of rows) {
    const lot = lots.get(row.lot_id); const product = lot ? products.get(lot.product_id) : undefined; const location = locations.get(row.location_id);
    if (!lot || !product || !location) return { data: null, error: { message: 'CI_COUNT_LINES_INCOMPLETE' } };
    lines.push({ id: row.id, countId: row.count_id, warehouseId: Number(row.warehouse_id),
      productCode: product.product_code, productName: product.display_name, unit: product.base_stock_unit,
      lotNumber: lot.lot_number, expiryDate: lot.expiry_date, locationCode: location.code, locationName: location.name ?? '',
      snapshot: Number(row.snapshot_quantity), physical: row.physical_quantity === null ? null : Number(row.physical_quantity),
      counted: row.counted_at !== null, needsRecount: row.needs_recount });
  }
  const progress = new Map(memberIds.map(memberId => {
    const own = lines.filter(line => line.countId === memberId);
    return [memberId, { count_id: memberId, total_lines: own.length, counted_lines: own.filter(line => line.counted).length,
      variance_lines: own.filter(line => line.counted && line.physical !== line.snapshot).length,
      recount_lines: own.filter(line => line.needsRecount).length }];
  }));
  const first = countRows[0];
  const round = batch
    ? summary('unified', batch.id, batch.created_at, batch.created_by, batch.note, scopeLabel(batch.scope_type, batch.scope as never), memberIds, counts, progress, access)
    : summary('legacy', first.id, first.created_at, first.created_by, first.note,
      `รอบเดิม · ${access.warehouses.find(w => Number(w.id) === Number(first.warehouse_id))?.name ?? ''}`.trim(), memberIds, counts, progress, access);
  return { data: { round, lines }, error: null };
}
