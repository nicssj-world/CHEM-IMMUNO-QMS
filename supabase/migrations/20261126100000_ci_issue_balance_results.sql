-- Balance before/after for every issue movement, captured inside the same transaction that
-- cuts the stock. Every issue path (single issue, scanned batch, picking list) locks the
-- product rows before writing movements, so the balances read here are exact for that
-- moment and never depend on later transactions or on browser state.
--
-- Additive: no issue function, FEFO rule, permission or ledger row changes. The table is
-- evidence only; balances are still derived from the signed ledger.

create table public.ci_issue_balance_results (
  movement_line_id uuid primary key,
  sequence bigint generated always as identity,
  transaction_id uuid not null references public.ci_stock_transactions(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  product_id uuid not null,
  lot_id uuid not null,
  location_id uuid not null,
  quantity numeric(18,3) not null check (quantity > 0),
  lot_location_before numeric(18,3) not null,
  lot_location_after numeric(18,3) not null,
  product_after numeric(18,3) not null,
  created_at timestamptz not null default now()
);
create index ci_issue_balance_results_tx on public.ci_issue_balance_results(transaction_id);
alter table public.ci_issue_balance_results enable row level security;
revoke all on public.ci_issue_balance_results from public, anon, authenticated;
grant select on public.ci_issue_balance_results to authenticated;
create policy ci_issue_balance_results_read on public.ci_issue_balance_results
  for select to authenticated using (ci_private.can_read(warehouse_id));

create function ci_private.record_issue_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_product uuid; v_after numeric; v_product_after numeric;
begin
  select kind into v_kind from public.ci_stock_transactions where id=new.transaction_id;
  if v_kind is distinct from 'issue' or new.quantity_delta>=0 then return null; end if;
  select product_id into v_product from public.ci_stock_lots where id=new.lot_id;
  -- AFTER INSERT: the sums already include this movement line.
  select coalesce(sum(quantity_delta),0) into v_after from public.ci_stock_movement_lines
  where lot_id=new.lot_id and location_id=new.location_id;
  select coalesce(sum(m.quantity_delta),0) into v_product_after
  from public.ci_stock_movement_lines m join public.ci_stock_lots l on l.id=m.lot_id
  where l.warehouse_id=new.warehouse_id and l.product_id=v_product;
  insert into public.ci_issue_balance_results(movement_line_id,transaction_id,warehouse_id,product_id,lot_id,location_id,
    quantity,lot_location_before,lot_location_after,product_after)
  values(new.id,new.transaction_id,new.warehouse_id,v_product,new.lot_id,new.location_id,
    -new.quantity_delta,v_after-new.quantity_delta,v_after,v_product_after);
  return null;
end $$;
revoke all on function ci_private.record_issue_balance() from public,anon,authenticated;

create trigger ci_movement_issue_balance after insert on public.ci_stock_movement_lines
  for each row execute function ci_private.record_issue_balance();
