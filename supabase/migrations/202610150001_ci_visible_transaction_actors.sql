-- Expose only the display name attached to a transaction the caller can read.
-- Do not broaden profile table RLS, and do not expose this RPC to anonymous clients.
create or replace function public.ci_visible_transaction_actors(p_transaction_ids uuid[])
returns table(transaction_id uuid, actor_name text)
language sql stable security definer
set search_path = ''
as $$
  select t.id, p.display_name
  from public.ci_stock_transactions t
  join public.ci_user_profiles p on p.user_id = t.actor_id
  where cardinality(coalesce(p_transaction_ids, '{}'::uuid[])) <= 200
    and t.id = any(p_transaction_ids)
    and ci_private.can_read(t.warehouse_id);
$$;
revoke all on function public.ci_visible_transaction_actors(uuid[]) from public, anon;
grant execute on function public.ci_visible_transaction_actors(uuid[]) to authenticated;