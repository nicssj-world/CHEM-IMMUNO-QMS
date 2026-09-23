-- Read-only reporting from the signed, immutable stock movement ledger.
create function public.ci_monthly_inventory_report(p_warehouse_id smallint, p_month date)
returns table(product_id uuid, product_code text, display_name text, product_type text,
 opening numeric, received numeric, issued numeric, adjustments numeric,
 expired_disposal numeric, reversals numeric, closing numeric)
language plpgsql stable security invoker set search_path='' as $$
declare v_start timestamptz; v_end timestamptz;
begin
 if p_month is null or p_month <> date_trunc('month',p_month)::date then raise exception 'CI_REPORT_MONTH_INVALID'; end if;
 if not ci_private.can_read(p_warehouse_id) then raise exception 'CI_ACCESS_DENIED'; end if;
 v_start := p_month::timestamp at time zone 'Asia/Bangkok';
 v_end := (p_month + interval '1 month')::timestamp at time zone 'Asia/Bangkok';
 return query
 select p.id,p.product_code,p.display_name,p.product_type,
  coalesce(sum(m.quantity_delta) filter(where tx.created_at < v_start),0)::numeric as opening,
  coalesce(sum(m.quantity_delta) filter(where tx.kind='receive' and tx.created_at >= v_start and tx.created_at < v_end),0)::numeric as received,
  coalesce(-sum(m.quantity_delta) filter(where tx.kind='issue' and tx.created_at >= v_start and tx.created_at < v_end),0)::numeric as issued,
  coalesce(sum(m.quantity_delta) filter(where tx.kind='adjustment' and tx.created_at >= v_start and tx.created_at < v_end),0)::numeric as adjustments,
  coalesce(-sum(m.quantity_delta) filter(where tx.kind='expired_disposal' and tx.created_at >= v_start and tx.created_at < v_end),0)::numeric as expired_disposal,
  coalesce(sum(m.quantity_delta) filter(where tx.kind='reversal' and tx.created_at >= v_start and tx.created_at < v_end),0)::numeric as reversals,
  coalesce(sum(m.quantity_delta) filter(where tx.created_at < v_end),0)::numeric as closing
 from public.ci_products p
 left join public.ci_stock_lots l on l.product_id=p.id
 left join public.ci_stock_movement_lines m on m.lot_id=l.id
 left join public.ci_stock_transactions tx on tx.id=m.transaction_id
 where p.warehouse_id=p_warehouse_id
 group by p.id,p.product_code,p.display_name,p.product_type
 order by p.product_code;
end $$;

-- Bounded server-side Product lookup across names, codes, identifiers, and filters.
create function public.ci_search_inventory(p_warehouse_id smallint, p_query text default '', p_type text default null,
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
  case when coalesce(r.usable_stock,0)<=0 then 'stockout' when r.rop is null then 'ต้องตั้งค่า'
       when r.usable_stock<r.rop then 'below ROP' else 'adequate' end
 from public.ci_products p
 left join public.ci_reorder_status r on r.product_id=p.id
 where p.warehouse_id=p_warehouse_id
  and (nullif(btrim(p_query),'') is null or position(lower(btrim(p_query)) in lower(p.product_code))>0
   or position(lower(btrim(p_query)) in lower(p.display_name))>0
   or position(lower(btrim(p_query)) in lower(p.source_name))>0
   or exists(select 1 from public.ci_product_identifiers i where i.product_id=p.id and position(lower(btrim(p_query)) in lower(i.value))>0))
  and (p_type is null or p.product_type=p_type)
  and (p_platform_id is null or exists(select 1 from public.ci_product_platforms pp where pp.product_id=p.id and pp.platform_id=p_platform_id))
  and (p_stock_status is null or (p_stock_status='stockout' and coalesce(r.usable_stock,0)<=0)
       or (p_stock_status='below' and r.usable_stock>0 and r.rop is not null and r.usable_stock<r.rop))
  and (p_expiry is null or exists(select 1 from public.ci_stock_balances b where b.product_id=p.id and b.balance>0
       and case when b.expiry_date < (now() at time zone 'Asia/Bangkok')::date then 'EXPIRED'
                when b.expiry_date <= (now() at time zone 'Asia/Bangkok')::date+30 then '≤30'
                when b.expiry_date <= (now() at time zone 'Asia/Bangkok')::date+60 then '31–60'
                when b.expiry_date <= (now() at time zone 'Asia/Bangkok')::date+90 then '61–90' else '>90' end=p_expiry))
 order by p.product_code limit p_limit offset p_offset;
end $$;

revoke all on function public.ci_monthly_inventory_report(smallint,date),public.ci_search_inventory(smallint,text,text,uuid,text,text,integer,integer) from public,anon;
grant execute on function public.ci_monthly_inventory_report(smallint,date),public.ci_search_inventory(smallint,text,text,uuid,text,text,integer,integer) to authenticated;

-- Explain a missing Suggested Order configuration even when ROP itself is available.
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
 case when s.mode='manual' and s.manual_rop_packs is not null and s.order_pack_quantity is not null then s.manual_rop_packs*s.order_pack_quantity
      when s.mode='automatic' and s.lead_time_days is not null and s.safety_stock is not null and c.first_issue <= now()-interval '90 days' then greatest(c.net_issue,0)/90*s.lead_time_days+s.safety_stock end rop,
 case when s.mode='automatic' and (c.first_issue is null or c.first_issue > now()-interval '90 days') then 'ต้องมีประวัติการเบิกใช้ครบ 90 วัน'
      when s.mode='automatic' and (s.lead_time_days is null or s.safety_stock is null) then 'ต้องตั้งค่า lead time และ safety stock'
      when s.mode='manual' and (s.manual_rop_packs is null or s.order_pack_quantity is null) then 'ต้องตั้งค่า ROP และ order pack'
      when s.mode is null then 'ต้องตั้งค่า'
      when s.target_coverage_days is null or s.order_pack_quantity is null then 'ต้องตั้งค่า target coverage และ order pack' end missing_reason,
 case when s.target_coverage_days is not null and s.order_pack_quantity is not null and c.first_issue <= now()-interval '90 days'
      then ceil(greatest(0,greatest(c.net_issue,0)/90*s.target_coverage_days-coalesce(u.usable_stock,0))/s.order_pack_quantity)*s.order_pack_quantity end suggested_order
from public.ci_products p left join public.ci_reorder_settings s on s.product_id=p.id
left join consumption c on c.product_id=p.id left join usable u on u.product_id=p.id;

create function public.ci_search_stock(p_warehouse_id smallint,p_query text default '',p_limit integer default 50,p_offset integer default 0)
returns table(product_id uuid,product_code text,display_name text,lot_id uuid,lot_number text,
 expiry_date date,location_id uuid,location_code text,balance numeric)
language plpgsql stable security invoker set search_path='' as $$
begin
 if not ci_private.can_read(p_warehouse_id) then raise exception 'CI_ACCESS_DENIED'; end if;
 if p_limit<1 or p_limit>100 or p_offset<0 then raise exception 'CI_SEARCH_PAGE_INVALID'; end if;
 return query
 select p.id,p.product_code,p.display_name,b.lot_id,b.lot_number,b.expiry_date,b.location_id,l.code,b.balance
 from public.ci_stock_balances b join public.ci_products p on p.id=b.product_id
 join public.ci_locations l on l.id=b.location_id
 where b.warehouse_id=p_warehouse_id and b.balance>0
  and (nullif(btrim(p_query),'') is null or position(lower(btrim(p_query)) in lower(p.product_code))>0
       or position(lower(btrim(p_query)) in lower(p.display_name))>0
       or position(lower(btrim(p_query)) in lower(p.source_name))>0
       or position(lower(btrim(p_query)) in lower(b.lot_number))>0
       or exists(select 1 from public.ci_product_identifiers i where i.product_id=p.id and position(lower(btrim(p_query)) in lower(i.value))>0))
 order by b.expiry_date,p.product_code,b.lot_number,l.code limit p_limit offset p_offset;
end $$;
revoke all on function public.ci_search_stock(smallint,text,integer,integer) from public,anon;
grant execute on function public.ci_search_stock(smallint,text,integer,integer) to authenticated;
