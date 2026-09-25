-- Live vendor performance for readers: the same evidence calculation the annual report freezes, without freezing anything.
set local search_path = '';

create function ci_private.ci_vendor_performance(p_vendor_id uuid, p_warehouse_id smallint, p_fiscal_year integer) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not ci_private.can_read(p_warehouse_id) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_fiscal_year is null or p_fiscal_year not between 2500 and 3000 then raise exception 'CI_FISCAL_YEAR_INVALID'; end if;
  return ci_private.vendor_evaluation_live_snapshot(p_vendor_id, p_warehouse_id, p_fiscal_year) - 'issues' - 'assessments';
end $$;

select ci_private.publish_rpc('ci_private.ci_vendor_performance(uuid, smallint, integer)'::regprocedure);

notify pgrst, 'reload schema';
