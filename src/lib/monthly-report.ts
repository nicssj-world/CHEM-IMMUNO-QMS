export type MonthlyRow = { product_id: string; product_code: string; display_name: string; product_type: string; opening: number | string; received: number | string; issued: number | string; adjustments: number | string; expired_disposal: number | string; reversals: number | string; closing: number | string };

export function reportMonth(value: string | undefined, today: string): string {
  if (!value) return today.slice(0,7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('CI_REPORT_MONTH_INVALID');
  return value;
}

export function reconcileMonthlyRows(rows: MonthlyRow[]) {
  const fields = ['opening','received','issued','adjustments','expired_disposal','reversals','closing'] as const;
  const totals = Object.fromEntries(fields.map(field=>[field,rows.reduce((sum,row)=>sum+Number(row[field]),0)])) as Record<typeof fields[number],number>;
  const invalid = rows.filter(row=>Math.abs(Number(row.opening)+Number(row.received)-Number(row.issued)+Number(row.adjustments)-Number(row.expired_disposal)+Number(row.reversals)-Number(row.closing))>0.0001);
  return { totals, invalidProductCodes: invalid.map(row=>row.product_code) };
}
