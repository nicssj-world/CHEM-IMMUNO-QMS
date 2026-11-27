-- Issue-group picking must use the shared physical Location mapping used by stock movements.
-- Fixes CI_ISSUE_GROUP_LINE_INVALID on CHE/IMM cross-warehouse shared locations.
-- Does not modify stock ledger, lot ownership, or FEFO logic.
do $preflight$
declare v_create text; v_complete text;
begin
  if to_regclass('public.ci_location_warehouses') is null
     or to_regprocedure('ci_private.location_available_for_warehouse(smallint,uuid,boolean)') is null
  then raise exception 'CI_ISSUE_SHARED_LOCATION_PREREQUISITE_MISSING'; end if;

  select pg_get_functiondef('ci_private.ci_create_issue_group(jsonb)'::regprocedure) into v_create;
  select pg_get_functiondef('ci_private.ci_complete_issue_group(uuid)'::regprocedure) into v_complete;
  if strpos(v_create, 'or not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active)') = 0
     or strpos(v_complete, 'if not exists(select 1 from public.ci_locations where id=r.location_id and warehouse_id=r.warehouse_id and active)') = 0
  then raise exception 'CI_ISSUE_SHARED_LOCATION_FUNCTION_DRIFT'; end if;

  if not exists(
    select 1 from pg_constraint
    where conrelid='public.ci_issue_group_lines'::regclass
      and conname='ci_issue_group_lines_location_id_warehouse_id_fkey'
  ) then raise exception 'CI_ISSUE_SHARED_LOCATION_FK_DRIFT'; end if;

  if exists(
    select 1 from public.ci_issue_group_lines l
    left join public.ci_location_warehouses link
      on link.location_id=l.location_id and link.warehouse_id=l.warehouse_id
    where link.location_id is null
  ) then raise exception 'CI_ISSUE_SHARED_LOCATION_INVALID_EXISTING_LINES'; end if;
end $preflight$;

-- Match the composite Location FK already used by stock movement lines.
alter table public.ci_issue_group_lines
  drop constraint ci_issue_group_lines_location_id_warehouse_id_fkey;
alter table public.ci_issue_group_lines
  add constraint ci_issue_group_lines_shared_location_fk
  foreign key (location_id, warehouse_id)
  references public.ci_location_warehouses(location_id, warehouse_id);

-- Keep all authorization, idempotency, quantity, FEFO and ledger behavior unchanged.
CREATE OR REPLACE FUNCTION ci_private.ci_create_issue_group(p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_actor uuid:=auth.uid(); v_key uuid; v_id uuid; v_hash text:=md5(p_data::text);
 v_existing public.ci_issue_groups%rowtype;
 v_line jsonb; v_product uuid; v_lot uuid; v_location uuid; v_wh smallint;
 v_qty numeric; v_purpose text:=p_data->>'purpose';
begin
 if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501';end if;
 if p_data is null or jsonb_typeof(p_data->'lines')<>'array'
  or jsonb_array_length(p_data->'lines') not between 1 and 100
  or length(p_data::text)>100000
 then raise exception 'CI_ISSUE_GROUP_LINES_INVALID'; end if;
 v_key:=(p_data->>'client_key')::uuid;
 if v_key is null then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED';end if;
 if v_purpose is null or v_purpose not in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other')
 then raise exception 'CI_ISSUE_PURPOSE_INVALID';end if;
 perform pg_advisory_xact_lock(hashtext(v_actor::text),hashtext(v_key::text));
 select * into v_existing from public.ci_issue_groups where created_by=v_actor and client_key=v_key for update;
 if found then
   if v_existing.request_hash<>v_hash then raise exception 'CI_IDEMPOTENCY_PAYLOAD_CONFLICT';end if;
   return v_existing.id;
 end if;
 -- Validate every item before inserting anything, and reject duplicate LOT/location.
 if (select count(distinct (x.value->>'lot_id',x.value->>'location_id'))
     from jsonb_array_elements(p_data->'lines') x) <> jsonb_array_length(p_data->'lines')
 then raise exception 'CI_ISSUE_DUPLICATE_LOT_LOCATION';end if;
 for v_line in select value from jsonb_array_elements(p_data->'lines') loop
   v_product:=(v_line->>'product_id')::uuid;
   v_lot:=(v_line->>'lot_id')::uuid;
   v_location:=(v_line->>'location_id')::uuid;
   v_qty:=(v_line->>'quantity')::numeric;
   select warehouse_id into v_wh from public.ci_products where id=v_product and active;
   if v_wh is null then raise exception 'CI_ISSUE_PRODUCT_INVALID';end if;
   perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
   if v_qty is null or v_qty<=0 or v_qty<>trunc(v_qty) or v_qty>1000000
     or not exists(select 1 from public.ci_stock_lots where id=v_lot and product_id=v_product and warehouse_id=v_wh)
     or not ci_private.location_available_for_warehouse(v_wh,v_location)
   then raise exception 'CI_ISSUE_GROUP_LINE_INVALID';end if;
 end loop;
 insert into public.ci_issue_groups(created_by,client_key,request_hash,purpose)
 values(v_actor,v_key,v_hash,v_purpose) returning id into v_id;
 for v_line in select value from jsonb_array_elements(p_data->'lines') loop
   v_product:=(v_line->>'product_id')::uuid;
   select warehouse_id into v_wh from public.ci_products where id=v_product;
   insert into public.ci_issue_group_lines(group_id,warehouse_id,product_id,lot_id,location_id,quantity,override_reason)
   values(v_id,v_wh,v_product,(v_line->>'lot_id')::uuid,(v_line->>'location_id')::uuid,
      (v_line->>'quantity')::numeric,nullif(btrim(v_line->>'override_reason'),''));
 end loop;
 return v_id;
end $function$;

CREATE OR REPLACE FUNCTION ci_private.ci_complete_issue_group(p_group uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 g public.ci_issue_groups%rowtype; v_wh smallint; v_tx uuid; r record;
 v_first uuid; v_expiry date; v_balance numeric; v_hash text;
begin
 select * into g from public.ci_issue_groups where id=p_group and created_by=auth.uid() for update;
 if not found then raise exception 'CI_ISSUE_GROUP_NOT_FOUND' using errcode='42501';end if;
 if g.status='closed' then return g.id;end if;
 if g.status not in ('pending','picking') then raise exception 'CI_ISSUE_GROUP_FINAL';end if;
 if not exists(select 1 from public.ci_issue_group_lines where group_id=p_group)
  or exists(select 1 from public.ci_issue_group_lines where group_id=p_group and not picked)
 then raise exception 'CI_ISSUE_PICKING_INCOMPLETE';end if;
 perform ci_private.lock_products(array(select distinct product_id
    from public.ci_issue_group_lines where group_id=p_group order by product_id));
 -- Validate all quantities against current balances under the product locks.
 for r in select l.*,p.active from public.ci_issue_group_lines l
  join public.ci_products p on p.id=l.product_id
  where l.group_id=p_group order by l.product_id,l.lot_id,l.location_id loop
   perform ci_private.require_role(r.warehouse_id,array['admin','supervisor','staff']);
   if not r.active then raise exception 'CI_ISSUE_PRODUCT_INACTIVE';end if;
   select expiry_date into v_expiry from public.ci_stock_lots
     where id=r.lot_id and product_id=r.product_id and warehouse_id=r.warehouse_id;
   if v_expiry is null or v_expiry<current_date then raise exception 'CI_EXPIRED_OR_INVALID_LOT';end if;
   if not ci_private.location_available_for_warehouse(r.warehouse_id,r.location_id)
   then raise exception 'CI_LOCATION_INVALID';end if;
   select coalesce(sum(quantity_delta),0) into v_balance from public.ci_stock_movement_lines
     where lot_id=r.lot_id and location_id=r.location_id;
   if v_balance<r.quantity then raise exception 'CI_ISSUE_STOCK_CHANGED';end if;
   select lot_id into v_first from public.ci_fefo_candidates
     where warehouse_id=r.warehouse_id and product_id=r.product_id
     order by expiry_date,lot_number,lot_id limit 1;
   if v_first is distinct from r.lot_id and nullif(btrim(r.override_reason),'') is null
   then raise exception 'CI_FEFO_OVERRIDE_REASON_REQUIRED';end if;
 end loop;
 -- All warehouses are written within the same SQL transaction: no partial stock deduction.
 for v_wh in select distinct warehouse_id from public.ci_issue_group_lines
   where group_id=p_group order by warehouse_id loop
   v_hash:=md5(p_group::text||':'||v_wh::text);
   insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,purpose,reason)
     values(v_wh,'issue',p_group::text,v_hash,auth.uid(),g.purpose,'Issue group '||p_group::text)
     returning id into v_tx;
   for r in select * from public.ci_issue_group_lines where group_id=p_group and warehouse_id=v_wh
     order by product_id,lot_id,location_id loop
     perform ci_private.add_movement(v_tx,v_wh,r.lot_id,r.location_id,-r.quantity);
   end loop;
   insert into public.ci_issue_group_transactions(group_id,warehouse_id,transaction_id)
     values(p_group,v_wh,v_tx);
   perform ci_private.audit(v_wh,'ISSUE_GROUP','ci_stock_transactions',v_tx::text);
 end loop;
 update public.ci_issue_groups set status='closed',closed_at=now(),updated_at=now() where id=p_group;
 return p_group;
end $function$;
