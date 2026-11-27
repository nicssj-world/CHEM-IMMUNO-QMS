-- Seller confirmation is independent of the order status and never changes stock or PDF snapshots.
alter table public.ci_user_profiles add column can_confirm_purchase_orders boolean not null default false;
alter table public.ci_purchase_orders
  add column acknowledged_at timestamptz,
  add column acknowledged_by uuid references auth.users(id),
  add column acknowledged_by_name text,
  add constraint ci_po_acknowledgement_complete check (
    (acknowledged_at is null and acknowledged_by is null and acknowledged_by_name is null)
    or (acknowledged_at is not null and acknowledged_by is not null and acknowledged_by_name is not null
        and status in ('ordered','cancelled') and length(btrim(acknowledged_by_name)) > 0)
  );

-- Admins of both warehouses can grant/revoke this independent capability. Existing roles are untouched.
create function ci_private.ci_set_po_confirmation_permission(p_ephis_id text, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  perform ci_private.require_role(1::smallint,array['admin']);
  perform ci_private.require_role(2::smallint,array['admin']);
  if p_enabled is null then raise exception 'CI_PO_INPUT_INVALID'; end if;
  update public.ci_user_profiles set can_confirm_purchase_orders=p_enabled
    where ephis_id=lower(btrim(p_ephis_id)) returning user_id into v_id;
  if not found then raise exception 'CI_USER_NOT_FOUND'; end if;
end $$;

-- An actor must have the explicit permission and be able to read ALL order lines.
-- A partial warehouse view is not sufficient to confirm an entire order.
create function ci_private.po_seller_may_access(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists(select 1 from public.ci_user_profiles p
      where p.user_id=auth.uid() and p.active and p.can_confirm_purchase_orders)
    and exists(select 1 from public.ci_purchase_orders o where o.id=p_id
      and (o.status in ('ordered','cancelled') or o.created_by=auth.uid()))
    and exists(select 1 from public.ci_purchase_order_lines l where l.purchase_order_id=p_id)
    and not exists(select 1 from public.ci_purchase_order_lines l where l.purchase_order_id=p_id
      and not ci_private.can_read(l.warehouse_id))
$$;
revoke all on function ci_private.po_seller_may_access(uuid) from public,anon,authenticated;

create function ci_private.ci_can_seller_confirm_purchase_order(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select ci_private.po_seller_may_access(p_id)
    and exists(select 1 from public.ci_purchase_orders o
      where o.id=p_id and o.status='ordered' and o.acknowledged_at is null)
$$;

create function ci_private.ci_confirm_purchase_order_as_seller(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.ci_purchase_orders%rowtype; v_name text;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  select display_name into v_name from public.ci_user_profiles
    where user_id=auth.uid() and active and can_confirm_purchase_orders for share;
  if not found or not ci_private.po_seller_may_access(p_id) then
    raise exception 'CI_ACCESS_DENIED' using errcode='42501';
  end if;
  select * into v_row from public.ci_purchase_orders where id=p_id for update;
  if not found or not ci_private.po_seller_may_access(p_id) then
    raise exception 'CI_ACCESS_DENIED' using errcode='42501';
  end if;
  if v_row.status<>'ordered' then raise exception 'CI_PO_SELLER_NOT_ORDERED'; end if;
  -- Retried requests and concurrent confirmations preserve the first actor and timestamp.
  if v_row.acknowledged_at is null then
    update public.ci_purchase_orders
    set acknowledged_at=clock_timestamp(), acknowledged_by=auth.uid(), acknowledged_by_name=v_name
    where id=p_id returning * into v_row;
    perform ci_private.audit(null,'SELLER_CONFIRM','ci_purchase_orders',p_id::text,v_row.po_number);
  end if;
  return jsonb_build_object('acknowledged_at',v_row.acknowledged_at,
    'acknowledged_by',v_row.acknowledged_by,'acknowledged_by_name',v_row.acknowledged_by_name);
end $$;

create function public.ci_set_po_confirmation_permission(p_ephis_id text, p_enabled boolean)
returns void language sql set search_path = '' as $$ select ci_private.ci_set_po_confirmation_permission($1,$2) $$;
create function public.ci_can_seller_confirm_purchase_order(p_id uuid)
returns boolean language sql stable set search_path = '' as $$ select ci_private.ci_can_seller_confirm_purchase_order($1) $$;
create function public.ci_confirm_purchase_order_as_seller(p_id uuid)
returns jsonb language sql set search_path = '' as $$ select ci_private.ci_confirm_purchase_order_as_seller($1) $$;

revoke all on function ci_private.ci_set_po_confirmation_permission(text,boolean),
  ci_private.ci_can_seller_confirm_purchase_order(uuid), ci_private.ci_confirm_purchase_order_as_seller(uuid),
  public.ci_set_po_confirmation_permission(text,boolean),
  public.ci_can_seller_confirm_purchase_order(uuid), public.ci_confirm_purchase_order_as_seller(uuid)
  from public,anon,authenticated;
grant execute on function ci_private.ci_set_po_confirmation_permission(text,boolean),
  ci_private.ci_can_seller_confirm_purchase_order(uuid), ci_private.ci_confirm_purchase_order_as_seller(uuid),
  public.ci_set_po_confirmation_permission(text,boolean),
  public.ci_can_seller_confirm_purchase_order(uuid), public.ci_confirm_purchase_order_as_seller(uuid)
  to authenticated;
