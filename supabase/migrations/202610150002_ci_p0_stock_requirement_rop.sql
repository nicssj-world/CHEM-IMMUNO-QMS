-- P0: classify stocked vs on-demand reagents without guessing from zero balance.
-- Existing 166 products start "unclassified"; clinical stock policy must be set by a supervisor.
alter table public.ci_products
  add column if not exists stock_requirement text not null default 'unclassified';
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.ci_products'::regclass and conname='ci_products_stock_requirement_check') then
    alter table public.ci_products add constraint ci_products_stock_requirement_check
      check (stock_requirement in ('unclassified','required','on_demand'));
  end if;
end $$;
comment on column public.ci_products.stock_requirement is 'unclassified=needs policy decision; required=keep stock; on_demand=do not count as stockout/ROP alert';

-- Legacy column manual_rop_packs stores the MANUAL ROP IN BASE STOCK UNITS; it is not a multiplier.\ncomment on column public.ci_reorder_settings.manual_rop_packs is 'Manual ROP in product base-stock units (legacy column name); do not multiply by order_pack_quantity';\n\n-- Reuse existing supervisor-only RPC. The classification update and settings upsert are atomic.
create or replace function ci_private.ci_save_reorder_settings(p_product_id uuid, p_data jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_wh smallint; v_requirement text;
begin
  select warehouse_id into v_wh from public.ci_products where id=p_product_id;
  if v_wh is null then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'stock_requirement' then
    v_requirement := p_data->>'stock_requirement';
    if v_requirement is null or v_requirement not in ('unclassified','required','on_demand') then
      raise exception 'CI_STOCK_REQUIREMENT_INVALID';
    end if;
    -- Product audit trigger preserves who changed the stocking policy.
    update public.ci_products set stock_requirement=v_requirement where id=p_product_id
      and stock_requirement is distinct from v_requirement;
  end if;
  if p_data ? 'mode' then
    insert into public.ci_reorder_settings
      (product_id,warehouse_id,mode,manual_rop_packs,lead_time_days,safety_stock,target_coverage_days,order_pack_quantity,updated_by)
    values(p_product_id,v_wh,p_data->>'mode',(p_data->>'manual_rop_packs')::numeric,
      (p_data->>'lead_time_days')::integer,(p_data->>'safety_stock')::numeric,
      (p_data->>'target_coverage_days')::integer,(p_data->>'order_pack_quantity')::numeric,auth.uid())
    on conflict(product_id) do update set
      mode=excluded.mode,manual_rop_packs=excluded.manual_rop_packs,
      lead_time_days=excluded.lead_time_days,safety_stock=excluded.safety_stock,
      target_coverage_days=excluded.target_coverage_days,
      order_pack_quantity=excluded.order_pack_quantity,updated_by=auth.uid(),updated_at=now();
  end if;
end $$;

-- Manual ROP is entered in BASE STOCK UNITS. Order pack quantity is a purchasing
-- multiple and must never multiply the ROP threshold. Automatic forecast unchanged.
create or replace view public.ci_reorder_status with (security_invoker=true) as
with consumption as (
 select l.product_id, min(tx.created_at) filter(where tx.kind='issue' and tx.purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Other')) first_issue,
  sum(case when tx.created_at >= now()-interval '90 days' and tx.kind='issue' and tx.purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Other') then -m.quantity_delta
           when tx.created_at >= now()-interval '90 days' and source.created_at >= now()-interval '90 days' and tx.kind='reversal' and source.kind='issue' and source.purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Other') then -m.quantity_delta else 0 end) net_issue
 from public.ci_stock_movement_lines m join public.ci_stock_transactions tx on tx.id=m.transaction_id
 left join public.ci_stock_transactions source on source.id=tx.source_transaction_id
 join public.ci_stock_lots l on l.id=m.lot_id group by l.product_id
), usable as (
 select product_id,sum(balance) usable_stock from public.ci_stock_balances
 where expiry_date >= (now() at time zone 'Asia/Bangkok')::date and balance>0 group by product_id
)
select p.id product_id,p.warehouse_id,s.mode,s.manual_rop_packs,s.lead_time_days,s.safety_stock,s.target_coverage_days,s.order_pack_quantity,
 coalesce(u.usable_stock,0)::numeric(18,3) usable_stock,
 case when c.first_issue <= now()-interval '90 days' then greatest(c.net_issue,0)/90 else null end average_daily_issue,
 case when s.mode='manual' and s.manual_rop_packs is not null then s.manual_rop_packs
      when s.mode='automatic' and s.lead_time_days is not null and s.safety_stock is not null and c.first_issue <= now()-interval '90 days' then greatest(c.net_issue,0)/90*s.lead_time_days+s.safety_stock end rop,
 case when s.mode='automatic' and (c.first_issue is null or c.first_issue > now()-interval '90 days') then 'ต้องมีประวัติการเบิกใช้ครบ 90 วัน'
      when s.mode='automatic' and (s.lead_time_days is null or s.safety_stock is null) then 'ต้องตั้งค่า lead time และ safety stock'
      when s.mode='manual' and s.manual_rop_packs is null then 'ต้องกำหนดจุดสั่งซื้อขั้นต่ำ (ROP)'
      when s.mode is null then 'ต้องตั้งค่า'
      when s.target_coverage_days is null or s.order_pack_quantity is null then 'ต้องตั้งค่า target coverage และ order pack เพื่อคำนวณ Suggested Order' end missing_reason,
 case when s.target_coverage_days is not null and s.order_pack_quantity is not null and c.first_issue <= now()-interval '90 days'
      then ceil(greatest(0,greatest(c.net_issue,0)/90*s.target_coverage_days-coalesce(u.usable_stock,0))/s.order_pack_quantity)*s.order_pack_quantity end suggested_order
from public.ci_products p left join public.ci_reorder_settings s on s.product_id=p.id
left join consumption c on c.product_id=p.id left join usable u on u.product_id=p.id;

-- Product master stockout and below-ROP filters must obey the SAME requirement rules
-- as Dashboard, Attention Center, Reorder and monthly report.
create or replace function public.ci_search_inventory(p_warehouse_id smallint, p_query text default '', p_type text default null,
 p_platform_id uuid default null, p_stock_status text default null, p_expiry text default null,
 p_limit integer default 50, p_offset integer default 0)
returns table(id uuid,product_code text,display_name text,product_type text,packing_size_raw text,
 active boolean,usable_stock numeric,rop numeric,stock_status text)
language plpgsql stable security invoker set search_path='' as $$
begin
 if not ci_private.can_read(p_warehouse_id) then raise exception 'CI_ACCESS_DENIED'; end if;
 if p_limit < 1 or p_limit > 100 or p_offset < 0 then raise exception 'CI_SEARCH_PAGE_INVALID'; end if;
 if p_type is not null and p_type not in ('reagent','calibrator','control','consumable') then raise exception 'CI_SEARCH_TYPE_INVALID'; end if;
 if p_stock_status is not null and p_stock_status not in ('stockout','below') then raise exception 'CI_SEARCH_STOCK_INVALID'; end if;
 if p_expiry is not null and p_expiry not in ('EXPIRED','≤30','31–60','61–90','>90') then raise exception 'CI_SEARCH_EXPIRY_INVALID'; end if;
 return query
 select p.id,p.product_code,p.display_name,p.product_type,p.packing_size_raw,p.active,
  coalesce(r.usable_stock,0)::numeric,r.rop,
  case when p.stock_requirement='unclassified' then 'ต้องจัดประเภท'
       when p.stock_requirement='on_demand' then 'ตามความต้องการ'
       when coalesce(r.usable_stock,0)<=0 then 'stockout'
       when r.rop is null then 'ต้องตั้งค่า'
       when r.usable_stock<=r.rop then 'below ROP' else 'adequate' end
 from public.ci_products p
 left join public.ci_reorder_status r on r.product_id=p.id
 where p.warehouse_id=p_warehouse_id
  and (nullif(btrim(p_query),'') is null or position(lower(btrim(p_query)) in lower(p.product_code))>0
   or position(lower(btrim(p_query)) in lower(p.display_name))>0
   or position(lower(btrim(p_query)) in lower(p.source_name))>0
   or exists(select 1 from public.ci_product_identifiers i where i.product_id=p.id and position(lower(btrim(p_query)) in lower(i.value))>0))
  and (p_type is null or p.product_type=p_type)
  and (p_platform_id is null or exists(select 1 from public.ci_product_platforms pp where pp.product_id=p.id and pp.platform_id=p_platform_id))
  and (p_stock_status is null or (p.stock_requirement='required' and p_stock_status='stockout' and coalesce(r.usable_stock,0)<=0)
       or (p.stock_requirement='required' and p_stock_status='below' and r.usable_stock>0 and r.rop is not null and r.usable_stock<=r.rop))
  and (p_expiry is null or exists(select 1 from public.ci_stock_balances b where b.product_id=p.id and b.balance>0
       and case when b.expiry_date < (now() at time zone 'Asia/Bangkok')::date then 'EXPIRED'
                when b.expiry_date <= (now() at time zone 'Asia/Bangkok')::date+30 then '≤30'
                when b.expiry_date <= (now() at time zone 'Asia/Bangkok')::date+60 then '31–60'
                when b.expiry_date <= (now() at time zone 'Asia/Bangkok')::date+90 then '61–90' else '>90' end=p_expiry))
 order by p.product_code limit p_limit offset p_offset;
end $$;
