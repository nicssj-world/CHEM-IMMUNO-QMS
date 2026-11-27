import { requireAccess, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadRoundSummaries, readAll, readByIds, type RoundSummary } from '@/lib/stock-count-data';
import { logUserMessage } from '@/lib/messages';
import { formatThaiDateTime } from '@/lib/format';
import { CountRoundList, type RoundListItem } from '@/components/count-round-list';
import { CountCreateForm, type CreateLocation, type CreateProduct } from '@/components/count-create-form';
import type { ScopeBalance } from '@/lib/stock-count';

const item = (round: RoundSummary): RoundListItem => ({
  id: round.id, createdAtText: formatThaiDateTime(round.createdAt), note: round.note, scopeLabel: round.scopeLabel,
  state: round.state, counted: round.progress.counted, total: round.progress.total, removable: round.deletable && round.canDelete,
});

export default async function CountsPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const writable = access.warehouses.filter(w => canMutate(w.role));
  const client = await createClient();
  if (!client) return <p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  const writableIds = writable.map(w => Number(w.id));
  const [summaries, balances, locations] = await Promise.all([
    loadRoundSummaries(client, access),
    writableIds.length ? readAll<ScopeBalance>((from, to) => client.from('ci_stock_balances')
      .select('warehouse_id,product_id,lot_id,location_id', { count: 'exact' }).in('warehouse_id', writableIds).gt('balance', 0)
      .order('lot_id').order('location_id').range(from, to)) : Promise.resolve({ data: [] as ScopeBalance[], error: null }),
    readAll<CreateLocation>((from, to) => client.from('ci_locations').select('id,code,name,parent_location_id', { count: 'exact' }).order('code').range(from, to)),
  ]);
  const productResult = balances.data
    ? await readByIds<CreateProduct>(balances.data.map(b => b.product_id), chunk => client.from('ci_products').select('id,product_code,display_name,warehouse_id').in('id', chunk))
    : { data: null, error: null };
  const error = summaries.error ?? balances.error ?? locations.error ?? productResult.error;
  const rounds = summaries.data?.rounds ?? [];
  const legacy = summaries.data?.legacy ?? [];
  const open = rounds.filter(r => r.state === 'counting' || r.state === 'recheck');
  const groups = writable.map(w => ({ id: Number(w.id), label: w.code === 'CHE' ? 'CHEM' : w.code === 'IMM' ? 'IMMUNO' : w.name }));
  return <main className="grid gap-5 max-w-[1000px]">
    <div>
      <h1 className="page-title">ตรวจนับคลังน้ำยา</h1>
      <p className="muted mt-2 text-sm">เลือกขอบเขต เดินตรวจตามตำแหน่ง แล้วกด “ตรวจแล้ว” ทีละรายการ · ผลบันทึกทันทีและกลับมาตรวจต่อได้</p>
    </div>
    {params.deleted && <p className="notice" role="status">ลบรอบตรวจนับแล้ว · ยอดคงเหลือในคลังไม่เปลี่ยน</p>}
    {error && <p className="error" role="alert">โหลดข้อมูลรอบตรวจนับไม่สำเร็จ: {logUserMessage('counts', error)} · โหลดหน้าใหม่อีกครั้ง</p>}
    {!error && writable.length > 0 && <CountCreateForm balances={balances.data ?? []} locations={locations.data ?? []}
      products={(productResult.data ?? []).sort((a, b) => a.product_code.localeCompare(b.product_code))} groups={groups}
      openRounds={open.map(r => ({ id: r.id, createdAtText: formatThaiDateTime(r.createdAt), scopeLabel: r.scopeLabel, counted: r.progress.counted, total: r.progress.total }))} />}
    {!error && <CountRoundList title="รอบตรวจนับ" items={rounds.map(item)} emptyText="ยังไม่มีรอบตรวจนับ" />}
    {!error && legacy.length > 0 && <CountRoundList title="รอบตรวจนับเดิม" items={legacy.map(item)} emptyText="" />}
  </main>;
}
