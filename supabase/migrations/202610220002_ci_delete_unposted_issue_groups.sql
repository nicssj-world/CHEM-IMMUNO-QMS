-- Delete only unposted planned issue lists. Posted issue transactions and their ledger are immutable.
create function ci_private.ci_delete_issue_group(p_group uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_status text; v_owner uuid;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  select g.status,g.created_by into v_status,v_owner
    from public.ci_issue_groups g where g.id=p_group for update;
  if v_status is null or v_owner<>auth.uid() then
    raise exception 'CI_ISSUE_GROUP_NOT_FOUND' using errcode='42501';
  end if;
  if v_status not in ('pending','picking','cancelled') then
    raise exception 'CI_ISSUE_GROUP_ALREADY_POSTED';
  end if;
  if exists(select 1 from public.ci_issue_group_transactions where group_id=p_group) then
    raise exception 'CI_ISSUE_GROUP_ALREADY_POSTED';
  end if;
  delete from public.ci_issue_group_lines where group_id=p_group;
  delete from public.ci_issue_groups where id=p_group;
end $$;

create function public.ci_delete_issue_group(p_group uuid)
returns void language sql security invoker set search_path='' as $$
  select ci_private.ci_delete_issue_group($1)
$$;
revoke all on function ci_private.ci_delete_issue_group(uuid)
 from public,anon,authenticated;
revoke all on function public.ci_delete_issue_group(uuid)
 from public,anon,authenticated;
grant execute on function public.ci_delete_issue_group(uuid)
 to authenticated;
