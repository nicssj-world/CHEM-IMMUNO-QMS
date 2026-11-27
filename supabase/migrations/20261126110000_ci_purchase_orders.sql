-- Purchase orders (ใบสั่งซื้อ): templates, drafts and confirmed orders with saved snapshots.
-- An order is a planning document only. Nothing here writes the stock ledger; stock still
-- changes only through receiving. No price, VAT or payment data is stored.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.ci_purchase_order_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create unique index ci_purchase_order_templates_name on public.ci_purchase_order_templates(lower(btrim(name)));

create table public.ci_purchase_order_template_lines (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.ci_purchase_order_templates(id) on delete cascade,
  warehouse_id smallint not null,
  product_id uuid not null,
  display_order integer not null check (display_order >= 0),
  unique (template_id, product_id),
  foreign key (product_id, warehouse_id) references public.ci_products(id, warehouse_id)
);
create index ci_purchase_order_template_lines_template on public.ci_purchase_order_template_lines(template_id, display_order);

create table public.ci_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text unique,
  status text not null default 'draft' check (status in ('draft','ordered','cancelled')),
  template_id uuid references public.ci_purchase_order_templates(id) on delete set null,
  template_name_snapshot text,
  client_key uuid not null,
  created_by uuid not null references auth.users(id),
  -- Names are copied so history and reprinted PDFs never need to read other users' profiles.
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  usage_period_start timestamptz,
  usage_period_end timestamptz,
  unique (created_by, client_key),
  constraint ci_purchase_orders_number_when_ordered check (
    (status='draft' and po_number is null and confirmed_at is null)
    or (status in ('ordered','cancelled') and po_number is not null and confirmed_at is not null
        and usage_period_start is not null and usage_period_end is not null))
);
create index ci_purchase_orders_history on public.ci_purchase_orders(status, confirmed_at desc, created_at desc);
create index ci_purchase_orders_owner on public.ci_purchase_orders(created_by, updated_at desc);

create table public.ci_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.ci_purchase_orders(id) on delete cascade,
  warehouse_id smallint not null,
  product_id uuid not null,
  display_order integer not null check (display_order >= 0),
  order_quantity numeric(18,3) not null check (order_quantity >= 0 and order_quantity = trunc(order_quantity)),
  -- Snapshot taken at confirmation; a printed order never follows later product, ROP or stock changes.
  product_code_snapshot text,
  product_name_snapshot text,
  packing_snapshot text,
  unit_snapshot text,
  issued_30d_snapshot numeric(18,3) check (issued_30d_snapshot >= 0),
  stock_balance_snapshot numeric(18,3),
  rop_snapshot numeric(18,3),
  unique (purchase_order_id, product_id),
  foreign key (product_id, warehouse_id) references public.ci_products(id, warehouse_id)
);
create index ci_purchase_order_lines_order on public.ci_purchase_order_lines(purchase_order_id, display_order);

create table ci_private.purchase_order_counters (
  year_be integer primary key check (year_be between 2500 and 3000),
  last_number integer not null check (last_number > 0)
);
revoke all on ci_private.purchase_order_counters from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security: read only what the user's groups allow; all writes go through RPCs.
-- ---------------------------------------------------------------------------
alter table public.ci_purchase_order_templates enable row level security;
alter table public.ci_purchase_order_template_lines enable row level security;
alter table public.ci_purchase_orders enable row level security;
alter table public.ci_purchase_order_lines enable row level security;
revoke all on public.ci_purchase_order_templates, public.ci_purchase_order_template_lines,
  public.ci_purchase_orders, public.ci_purchase_order_lines from public, anon, authenticated;
grant select on public.ci_purchase_order_templates, public.ci_purchase_order_template_lines,
  public.ci_purchase_orders, public.ci_purchase_order_lines to authenticated;

create policy ci_po_template_lines_read on public.ci_purchase_order_template_lines
  for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_po_templates_read on public.ci_purchase_order_templates
  for select to authenticated using (
    (ci_private.can_read(1::smallint) or ci_private.can_read(2::smallint))
    and (created_by=(select auth.uid()) or exists(
      select 1 from public.ci_purchase_order_template_lines l
      where l.template_id=ci_purchase_order_templates.id and ci_private.can_read(l.warehouse_id))));
create policy ci_po_lines_read on public.ci_purchase_order_lines
  for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_po_read on public.ci_purchase_orders
  for select to authenticated using (
    (ci_private.can_read(1::smallint) or ci_private.can_read(2::smallint))
    and (created_by=(select auth.uid()) or (status<>'draft' and exists(
      select 1 from public.ci_purchase_order_lines l
      where l.purchase_order_id=ci_purchase_orders.id and ci_private.can_read(l.warehouse_id)))));

-- ---------------------------------------------------------------------------
-- Current numbers for an order: 30-day issues, on-hand stock and effective ROP.
-- Security invoker: a user only ever sees products of groups they can read.
-- ---------------------------------------------------------------------------
create function public.ci_purchase_order_metrics(p_product_ids uuid[])
returns table(product_id uuid, warehouse_id smallint, issued_30d numeric, stock_balance numeric,
  rop numeric, stock_requirement text, usage_start timestamptz, usage_end timestamptz)
language sql stable set search_path = '' as $$
  with bounds as (select now() as usage_end, now() - interval '30 days' as usage_start),
  chosen as (select p.id, p.warehouse_id, p.stock_requirement from public.ci_products p where p.id = any(p_product_ids)),
  -- Issues that cut stock inside the rolling window, all purposes, all LOTs and locations.
  issued as (
    select l.product_id, sum(-m.quantity_delta) as qty
    from public.ci_stock_transactions tx cross join bounds b
    join public.ci_stock_movement_lines m on m.transaction_id=tx.id
    join public.ci_stock_lots l on l.id=m.lot_id
    where tx.kind='issue' and tx.created_at >= b.usage_start and tx.created_at < b.usage_end
      and l.product_id = any(p_product_ids)
    group by l.product_id),
  -- A cancelled (reversed) issue is removed by its source date, so it is never double counted
  -- and a reversal of an older issue cannot reduce this window.
  reversed as (
    select l.product_id, sum(m.quantity_delta) as qty
    from public.ci_stock_transactions rv cross join bounds b
    join public.ci_stock_transactions src on src.id=rv.source_transaction_id
    join public.ci_stock_movement_lines m on m.transaction_id=rv.id
    join public.ci_stock_lots l on l.id=m.lot_id
    where rv.kind='reversal' and src.kind='issue'
      and src.created_at >= b.usage_start and src.created_at < b.usage_end
      and l.product_id = any(p_product_ids)
    group by l.product_id),
  stock as (
    select s.product_id, sum(s.balance) as qty from public.ci_stock_balances s
    where s.product_id = any(p_product_ids) group by s.product_id)
  select c.id, c.warehouse_id,
    greatest(coalesce(i.qty,0)-coalesce(r.qty,0),0)::numeric(18,3),
    coalesce(s.qty,0)::numeric(18,3),
    rs.rop::numeric(18,3), c.stock_requirement, b.usage_start, b.usage_end
  from chosen c cross join bounds b
  left join issued i on i.product_id=c.id
  left join reversed r on r.product_id=c.id
  left join stock s on s.product_id=c.id
  left join public.ci_reorder_status rs on rs.product_id=c.id
$$;
revoke all on function public.ci_purchase_order_metrics(uuid[]) from public, anon;
grant execute on function public.ci_purchase_order_metrics(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function ci_private.po_can_manage_template(p_created_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_created_by=auth.uid()
    or ci_private.has_role(1::smallint,array['admin','supervisor'])
    or ci_private.has_role(2::smallint,array['admin','supervisor'])
$$;
revoke all on function ci_private.po_can_manage_template(uuid) from public, anon, authenticated;

-- Validates product ids for the actor and returns them with their warehouse, in order.
create function ci_private.po_parse_products(p_ids jsonb, p_require_active boolean, p_existing uuid[])
returns table(product_id uuid, warehouse_id smallint, ord integer)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_wh smallint; v_active boolean; v_ord integer := 0; v_seen uuid[] := '{}';
begin
  if p_ids is null or jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids)>500 then
    raise exception 'CI_PO_LINES_INVALID'; end if;
  for v_id in select (x)::uuid from jsonb_array_elements_text(p_ids) x loop
    if v_id = any(v_seen) then raise exception 'CI_PO_DUPLICATE_PRODUCT'; end if;
    v_seen := v_seen || v_id;
    select p.warehouse_id, p.active into v_wh, v_active from public.ci_products p where p.id=v_id;
    if v_wh is null then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
    perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
    if p_require_active and not v_active and not (v_id = any(coalesce(p_existing,'{}'))) then
      raise exception 'CI_PO_PRODUCT_INACTIVE'; end if;
    product_id := v_id; warehouse_id := v_wh; ord := v_ord; v_ord := v_ord+1;
    return next;
  end loop;
exception when invalid_text_representation then raise exception 'CI_PO_LINES_INVALID';
end $$;
revoke all on function ci_private.po_parse_products(jsonb,boolean,uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------
create function ci_private.ci_save_purchase_order_template(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_data->>'name',''));
  v_row public.ci_purchase_order_templates%rowtype; v_existing uuid[]; v_hidden integer;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  if not (ci_private.has_role(1::smallint,array['admin','supervisor','staff'])
       or ci_private.has_role(2::smallint,array['admin','supervisor','staff'])) then
    raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  if length(v_name) not between 1 and 120 then raise exception 'CI_PO_TEMPLATE_NAME_INVALID'; end if;
  begin v_id := nullif(p_data->>'id','')::uuid;
  exception when others then raise exception 'CI_PO_TEMPLATE_NOT_FOUND'; end;
  if v_id is not null then
    select * into v_row from public.ci_purchase_order_templates where id=v_id for update;
    if not found then raise exception 'CI_PO_TEMPLATE_NOT_FOUND'; end if;
    if not ci_private.po_can_manage_template(v_row.created_by) then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
    if p_data ? 'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from v_row.updated_at then
      raise exception 'CI_STALE_UPDATE'; end if;
    select array_agg(product_id) into v_existing from public.ci_purchase_order_template_lines where template_id=v_id;
  end if;
  if exists(select 1 from public.ci_purchase_order_templates t
            where lower(btrim(t.name))=lower(v_name) and t.id is distinct from v_id)
  then raise exception 'CI_PO_TEMPLATE_NAME_EXISTS'; end if;

  create temporary table if not exists pg_temp.ci_po_parsed(product_id uuid, warehouse_id smallint, ord integer) on commit drop;
  truncate pg_temp.ci_po_parsed;
  insert into pg_temp.ci_po_parsed select * from ci_private.po_parse_products(coalesce(p_data->'product_ids','[]'::jsonb),true,v_existing);

  if v_id is null then
    insert into public.ci_purchase_order_templates(name,created_by,updated_by)
    values(v_name,auth.uid(),auth.uid()) returning id into v_id;
  else
    update public.ci_purchase_order_templates set name=v_name,updated_by=auth.uid(),updated_at=now() where id=v_id;
  end if;
  -- Lines of groups this user cannot open are kept untouched (after the visible ones).
  select count(*) into v_hidden from public.ci_purchase_order_template_lines
  where template_id=v_id and not ci_private.has_role(warehouse_id,array['admin','supervisor','staff']);
  delete from public.ci_purchase_order_template_lines
  where template_id=v_id and ci_private.has_role(warehouse_id,array['admin','supervisor','staff']);
  update public.ci_purchase_order_template_lines set display_order=display_order+100000 where template_id=v_id;
  insert into public.ci_purchase_order_template_lines(template_id,warehouse_id,product_id,display_order)
  select v_id,warehouse_id,product_id,ord from pg_temp.ci_po_parsed
  where not exists(select 1 from public.ci_purchase_order_template_lines k where k.template_id=v_id and k.product_id=pg_temp.ci_po_parsed.product_id);
  perform ci_private.audit(null,'SAVE','ci_purchase_order_templates',v_id::text);
  return v_id;
end $$;

create function ci_private.ci_delete_purchase_order_template(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row public.ci_purchase_order_templates%rowtype;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  select * into v_row from public.ci_purchase_order_templates where id=p_id for update;
  if not found then raise exception 'CI_PO_TEMPLATE_NOT_FOUND'; end if;
  if not ci_private.po_can_manage_template(v_row.created_by) then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  -- Orders keep their template name snapshot; drafts simply lose the link.
  delete from public.ci_purchase_order_templates where id=p_id;
  perform ci_private.audit(null,'DELETE','ci_purchase_order_templates',p_id::text,v_row.name);
end $$;

-- ---------------------------------------------------------------------------
-- Save a draft or confirm an order (one transaction, idempotent per client key)
-- ---------------------------------------------------------------------------
create function ci_private.ci_save_purchase_order(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_id uuid; v_key uuid; v_template uuid; v_template_name text;
  v_confirm boolean := coalesce((p_data->>'confirm')::boolean,false);
  v_row public.ci_purchase_orders%rowtype; v_line jsonb; v_qty numeric; v_ids jsonb; v_existing uuid[];
  v_year integer; v_n integer; v_number text; v_start timestamptz; v_end timestamptz;
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  if p_data is null or jsonb_typeof(p_data->'lines')<>'array' or jsonb_array_length(p_data->'lines')>500
    or length(p_data::text)>200000 then raise exception 'CI_PO_LINES_INVALID'; end if;
  begin
    v_id := nullif(p_data->>'id','')::uuid;
    v_key := (p_data->>'client_key')::uuid;
    v_template := nullif(p_data->>'template_id','')::uuid;
  exception when others then raise exception 'CI_PO_INPUT_INVALID'; end;
  if v_key is null and v_id is null then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;

  if v_id is null then
    -- A retried "create" (lost response, double click) resumes the same order.
    perform pg_advisory_xact_lock(hashtext(v_actor::text), hashtext(v_key::text));
    select * into v_row from public.ci_purchase_orders where created_by=v_actor and client_key=v_key for update;
  else
    select * into v_row from public.ci_purchase_orders where id=v_id for update;
    if not found then raise exception 'CI_PO_NOT_FOUND'; end if;
    if v_row.created_by<>v_actor then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  end if;
  if v_row.id is not null and v_row.status<>'draft' then
    -- Confirming twice returns the same order and number; nothing is rewritten.
    if v_confirm and v_row.status='ordered' then
      return jsonb_build_object('id',v_row.id,'status',v_row.status,'po_number',v_row.po_number,'already',true);
    end if;
    raise exception 'CI_PO_NOT_EDITABLE';
  end if;

  if v_template is not null then
    select name into v_template_name from public.ci_purchase_order_templates where id=v_template;
    if v_template_name is null then v_template := null; end if;
  end if;

  -- Validate every line before writing anything.
  select coalesce(jsonb_agg(x->'product_id' order by o),'[]'::jsonb) into v_ids
  from jsonb_array_elements(p_data->'lines') with ordinality as t(x,o);
  for v_line in select value from jsonb_array_elements(p_data->'lines') loop
    begin v_qty := (v_line->>'order_quantity')::numeric;
    exception when others then raise exception 'CI_PO_QUANTITY_INVALID'; end;
    if v_qty is null or v_qty<0 or v_qty<>trunc(v_qty) or v_qty>10000000 then raise exception 'CI_PO_QUANTITY_INVALID'; end if;
  end loop;
  if v_row.id is not null then
    select array_agg(product_id) into v_existing from public.ci_purchase_order_lines where purchase_order_id=v_row.id;
  end if;
  create temporary table if not exists pg_temp.ci_po_order_parsed(product_id uuid, warehouse_id smallint, ord integer) on commit drop;
  truncate pg_temp.ci_po_order_parsed;
  insert into pg_temp.ci_po_order_parsed select * from ci_private.po_parse_products(v_ids,v_confirm,null);
  if v_confirm and not exists(
    select 1 from jsonb_array_elements(p_data->'lines') x where (x->>'order_quantity')::numeric>0)
  then raise exception 'CI_PO_EMPTY'; end if;

  if v_row.id is null then
    insert into public.ci_purchase_orders(client_key,created_by,created_by_name,template_id,template_name_snapshot)
    values(v_key,v_actor,coalesce((select display_name from public.ci_user_profiles where user_id=v_actor),'—'),
      v_template,v_template_name) returning * into v_row;
  else
    update public.ci_purchase_orders set template_id=v_template,template_name_snapshot=v_template_name,updated_at=now()
    where id=v_row.id returning * into v_row;
  end if;
  delete from public.ci_purchase_order_lines where purchase_order_id=v_row.id;
  insert into public.ci_purchase_order_lines(purchase_order_id,warehouse_id,product_id,display_order,order_quantity)
  select v_row.id,p.warehouse_id,p.product_id,p.ord,(x->>'order_quantity')::numeric
  from pg_temp.ci_po_order_parsed p
  join jsonb_array_elements(p_data->'lines') x on (x->>'product_id')::uuid=p.product_id;

  if v_confirm then
    -- Numbers come from the database under a row lock: unique under concurrent confirmations.
    v_year := extract(year from (now() at time zone 'Asia/Bangkok'))::integer + 543;
    insert into ci_private.purchase_order_counters(year_be,last_number) values(v_year,1)
    on conflict (year_be) do update set last_number=ci_private.purchase_order_counters.last_number+1
    returning last_number into v_n;
    v_number := 'PO-'||v_year::text||'-'||lpad(v_n::text,4,'0');
    update public.ci_purchase_order_lines l set
      product_code_snapshot=p.product_code, product_name_snapshot=p.display_name,
      packing_snapshot=p.packing_size_raw, unit_snapshot=p.base_stock_unit,
      issued_30d_snapshot=m.issued_30d, stock_balance_snapshot=m.stock_balance, rop_snapshot=m.rop
    from public.ci_products p, public.ci_purchase_order_metrics(array(
      select product_id from pg_temp.ci_po_order_parsed)) m
    where l.purchase_order_id=v_row.id and p.id=l.product_id and m.product_id=l.product_id;
    -- Same window the metrics used: now() is fixed for the whole transaction.
    v_end := now(); v_start := now() - interval '30 days';
    update public.ci_purchase_orders set status='ordered',po_number=v_number,confirmed_by=v_actor,
      confirmed_at=now(),usage_period_start=v_start,usage_period_end=v_end,updated_at=now()
    where id=v_row.id returning * into v_row;
    perform ci_private.audit(null,'CONFIRM','ci_purchase_orders',v_row.id::text,v_number);
  end if;
  return jsonb_build_object('id',v_row.id,'status',v_row.status,'po_number',v_row.po_number,'already',false);
end $$;

create function ci_private.ci_delete_purchase_order_draft(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row public.ci_purchase_orders%rowtype;
begin
  select * into v_row from public.ci_purchase_orders where id=p_id for update;
  if not found or v_row.created_by is distinct from auth.uid() then raise exception 'CI_PO_NOT_FOUND'; end if;
  if v_row.status<>'draft' then raise exception 'CI_PO_NOT_EDITABLE'; end if;
  delete from public.ci_purchase_orders where id=p_id;
end $$;

create function ci_private.ci_cancel_purchase_order(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row public.ci_purchase_orders%rowtype; v_wh smallint;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  select * into v_row from public.ci_purchase_orders where id=p_id for update;
  if not found then raise exception 'CI_PO_NOT_FOUND'; end if;
  if v_row.status='cancelled' then return; end if;
  if v_row.status<>'ordered' then raise exception 'CI_PO_NOT_EDITABLE'; end if;
  -- The orderer, or an admin/supervisor of every group in the order, may cancel it.
  if v_row.created_by<>auth.uid() then
    for v_wh in select distinct warehouse_id from public.ci_purchase_order_lines where purchase_order_id=p_id loop
      perform ci_private.require_role(v_wh,array['admin','supervisor']);
    end loop;
  end if;
  update public.ci_purchase_orders set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),updated_at=now()
  where id=p_id;
  perform ci_private.audit(null,'CANCEL','ci_purchase_orders',p_id::text,v_row.po_number);
end $$;

-- ---------------------------------------------------------------------------
-- Grants and invoker wrappers
-- ---------------------------------------------------------------------------
revoke all on function ci_private.ci_save_purchase_order_template(jsonb) from public,anon;
revoke all on function ci_private.ci_delete_purchase_order_template(uuid) from public,anon;
revoke all on function ci_private.ci_save_purchase_order(jsonb) from public,anon;
revoke all on function ci_private.ci_delete_purchase_order_draft(uuid) from public,anon;
revoke all on function ci_private.ci_cancel_purchase_order(uuid) from public,anon;
grant execute on function ci_private.ci_save_purchase_order_template(jsonb) to authenticated;
grant execute on function ci_private.ci_delete_purchase_order_template(uuid) to authenticated;
grant execute on function ci_private.ci_save_purchase_order(jsonb) to authenticated;
grant execute on function ci_private.ci_delete_purchase_order_draft(uuid) to authenticated;
grant execute on function ci_private.ci_cancel_purchase_order(uuid) to authenticated;

create function public.ci_save_purchase_order_template(p_data jsonb)
returns uuid language sql set search_path = '' as $$ select ci_private.ci_save_purchase_order_template($1) $$;
create function public.ci_delete_purchase_order_template(p_id uuid)
returns void language sql set search_path = '' as $$ select ci_private.ci_delete_purchase_order_template($1) $$;
create function public.ci_save_purchase_order(p_data jsonb)
returns jsonb language sql set search_path = '' as $$ select ci_private.ci_save_purchase_order($1) $$;
create function public.ci_delete_purchase_order_draft(p_id uuid)
returns void language sql set search_path = '' as $$ select ci_private.ci_delete_purchase_order_draft($1) $$;
create function public.ci_cancel_purchase_order(p_id uuid)
returns void language sql set search_path = '' as $$ select ci_private.ci_cancel_purchase_order($1) $$;
revoke all on function public.ci_save_purchase_order_template(jsonb) from public,anon;
revoke all on function public.ci_delete_purchase_order_template(uuid) from public,anon;
revoke all on function public.ci_save_purchase_order(jsonb) from public,anon;
revoke all on function public.ci_delete_purchase_order_draft(uuid) from public,anon;
revoke all on function public.ci_cancel_purchase_order(uuid) from public,anon;
grant execute on function public.ci_save_purchase_order_template(jsonb) to authenticated;
grant execute on function public.ci_delete_purchase_order_template(uuid) to authenticated;
grant execute on function public.ci_save_purchase_order(jsonb) to authenticated;
grant execute on function public.ci_delete_purchase_order_draft(uuid) to authenticated;
grant execute on function public.ci_cancel_purchase_order(uuid) to authenticated;
