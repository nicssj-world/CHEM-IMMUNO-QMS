# Release 2026-11-26 — Stock count fix & checklist, issue balances, monthly report, purchase orders

Branch `feat/stock-count-issue-report-po-20261126`, based on `92a3073` (the commit Production runs).
**Status: ready for Owner review. Not merged, not pushed, not deployed. No Production data was read or changed.**

## Root cause of "อ่านรายการตรวจนับไม่สำเร็จ"

`20261009052520_ci_shared_location_master.sql` dropped the FK `ci_stock_count_lines → ci_locations` and replaced it with
`(location_id, warehouse_id) → ci_location_warehouses`. The count pages still embedded `ci_locations(code)` from
`ci_stock_count_lines`, so PostgREST had no relationship to follow. Reproduced on local Supabase:

```
GET /rest/v1/ci_stock_count_lines?select=…,ci_stock_lots(lot_number,product_id),ci_locations(code)
→ HTTP 400 PGRST200 "Could not find a relationship between 'ci_stock_count_lines' and 'ci_locations'"
  hint: "Perhaps you meant 'ci_location_warehouses'"
```

The batch row itself loaded, the lines query failed, and the page showed 0/0, so staff created new rounds.
Fix: lines, LOTs, products and locations are read in batches (150 ids per query, never per row), with paging past
the 1,000-row API limit and a row-count check that refuses a partial list. A failed load shows
"โหลดรายการตรวจนับไม่สำเร็จ" with ลองใหม่ / กลับ, never 0/0, and nothing can be finalized from it. A unit test fails
if any query embeds `ci_locations(...)` from a table that references the shared mapping again.

## Database migrations (apply in this order, then deploy the app)

| Order | File | What it does | Old app (92a3073) while only the DB is updated |
|---|---|---|---|
| 1 | `20261126090000_ci_stock_count_rounds_v2.sql` | Count lines get `counted_at/counted_by/needs_recount` (existing lines with a physical quantity are marked counted); rounds get scope, client key; `ci_stock_count_progress` view; RPCs `ci_create_stock_count_round`, `ci_set_stock_count_line_state`, `ci_finalize_stock_count_round`, `ci_delete_stock_count_rounds`; the unified read policy also allows single-group rounds. | Works. Old RPCs keep their contracts (`ci_set_stock_count_line` now also records who counted). The old detail page is still broken until the app ships, as today. |
| 2 | `20261126100000_ci_issue_balance_results.sql` | `ci_issue_balance_results` + AFTER INSERT trigger on issue movements recording before/after balances inside the issue transaction. No issue function changed. | Works; the trigger only adds evidence rows. |
| 3 | `20261126110000_ci_purchase_orders.sql` | Templates, template lines, orders, order lines, private number counter, RLS, `ci_purchase_order_metrics`, save/confirm/cancel/delete RPCs. | Works; new tables only. |

All three are additive: no ledger row, balance, receipt, issue or report is rewritten or deleted.
Deploying the new app **before** the migrations would fail (new RPCs/tables missing), so migrations go first.

### Production preflight (read-only, before applying)
```sql
select version from supabase_migrations.schema_migrations order by version desc limit 5;   -- last must be 20261029140000
select count(*) from ci_stock_count_lines where physical_quantity is not null;              -- will be marked counted
select conname from pg_constraint where conname='ci_stock_count_lines_shared_location_fk';  -- must exist
```

### Count rounds left over from the error (owner decides; nothing is deleted automatically)
```sql
select b.id, (b.created_at at time zone 'Asia/Bangkok') as created_th, b.note,
  array_agg(distinct c.status) as statuses,
  count(l.*) as lines, count(l.*) filter (where l.physical_quantity is not null) as counted,
  bool_and(c.status <> 'approved') and not exists (
    select 1 from ci_stock_transactions t where t.kind='adjustment'
      and t.idempotency_key in ('count:'||coalesce(b.che_count_id::text,''),'count:'||coalesce(b.imm_count_id::text,''))) as deletable
from ci_unified_stock_counts b
join ci_stock_counts c on c.id in (b.che_count_id,b.imm_count_id)
left join ci_stock_count_lines l on l.count_id=c.id
group by b.id order by b.created_at desc;
```
After release an admin can open ตรวจนับ → เลือกหลายรอบ → ลบรอบที่เลือก. The database refuses any round that adjusted stock.

### Post-deploy smoke test (Production, read-mostly)
1. ตรวจนับ: open one of the existing rounds → items load, count matches the SQL above, no HTTP 400 in logs.
2. Create nothing new; check one item, then press แก้ไข to undo it (no stock change), or do this on a round you will delete.
3. เบิกออก: one real issue → the result shows before / issued / after / all-LOT total.
4. รายงานรายเดือน: 6 columns; closing balance equals the previous version's figures.
5. ใบสั่งซื้อ: open the page and history (creating an order does not change stock).

### Rollback
App: redeploy `92a3073`; it runs unchanged on the new schema. Database: no rollback needed. If the issue evidence
trigger had to be switched off: `drop trigger ci_movement_issue_balance on public.ci_stock_movement_lines;`
(evidence only; the ledger is unaffected).

## Behaviour decisions to confirm
- **ยอดเบิก 30 วัน** = issues in the rolling 30 days before the moment of calculation, all purposes, net of reversals of those
  same issues (by source date). The ROP view counts 90 days and excludes `Waste`; the order screen includes `Waste`.
- **ยอดคงเหลือ** in orders = all LOTs and locations on hand (including expired, as the brief says "ทุก LOT"); the ROP/stock
  status elsewhere uses usable (non-expired) stock.
- **Default order quantity** = ROP exactly; an automatic (fractional) ROP is rounded up to a whole unit. No ROP → empty, the
  user must type a number (empty is never saved as 0).
- **Finishing a round** is admin/supervisor only (as before); staff count and save. No reason is asked; the adjustment
  transaction is recorded with reason "ตรวจนับคลังน้ำยา".
- A counted line whose stock moved after its snapshot is reopened against the current balance ("ตรวจใหม่"); nothing is
  adjusted until it is counted again. Movement on uncounted lines never blocks a partial finish.
- Order numbers: `PO-<พ.ศ.>-NNNN`, per Bangkok year, generated in the database.

## Known limits
- Visual QA used Chrome with iPhone 13 emulation (320–430 px) and desktop 1280 px; not a physical iPhone/Safari.
- The app has no dark mode, so none was tested.
- The page number "หน้า x / y" on the order PDF uses CSS page margin boxes (Chrome/Edge print).
- The existing DB suite already had 24 failing tests on `92a3073` (fixtures with past expiry dates, the shared-location
  prerequisite check, the security catalog test); the same 24 fail after this work and none are new.
