-- Simplify Environment excursion follow-up: one atomic completion step instead of a two-stage
-- acknowledge-then-Admin/Supervisor-resolve workflow. This is NOT CAPA; Environment Excursions remain a
-- lightweight corrective/immediate-action record, per owner decision. No table alteration: the excursion
-- table already carries every field this needs (immediate_action, resolution_note, equipment_referred,
-- resolved_by, resolved_at, status). No change to reading/excursion-opening semantics or to the prior
-- migration, which is immutable.
--
-- ci_acknowledge_environment_excursion and ci_resolve_environment_excursion are left exactly as they were:
-- still callable, still Admin/Supervisor-gated for resolve, but no longer the workflow the application UI
-- drives. Dropping them would touch an immutable prior migration's public interface for no operational
-- benefit; they simply become unused by the app.

-- One authorized actor (Staff, Supervisor or Admin of the excursion's own warehouse) records both the
-- corrective action and the resolution and the excursion becomes resolved immediately - no separate
-- approval or closure step, and no other person is required to finish it.
--
-- Legacy compatibility: an excursion already sitting in 'acknowledged' (from the old two-step flow, or from
-- data recorded before this migration) keeps its existing immediate_action as historical evidence - this
-- function never overwrites it. Completing such a row only requires and records the resolution.
create function ci_private.ci_complete_environment_excursion(p_id uuid, p_immediate_action text, p_resolution_note text, p_equipment_referred boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ci_environment_excursions;
  v_actor uuid;
  v_action text := nullif(btrim(p_immediate_action), '');
  v_note text := nullif(btrim(p_resolution_note), '');
begin
  select * into v_row from public.ci_environment_excursions where id = p_id for update;
  if v_row.id is null or not ci_private.can_read(v_row.warehouse_id) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  v_actor := ci_private.require_role(v_row.warehouse_id, array['admin','supervisor','staff']);
  if v_row.status = 'resolved' then raise exception 'CI_ENV_EXCURSION_STATE'; end if;
  if v_note is null then raise exception 'CI_REASON_REQUIRED'; end if;
  if v_row.status = 'acknowledged' then
    -- The corrective action is already on file from the legacy acknowledge step; only the resolution is new.
    update public.ci_environment_excursions set status = 'resolved', resolution_note = v_note,
      equipment_referred = coalesce(p_equipment_referred, v_row.equipment_referred), resolved_by = v_actor,
      resolved_at = now(), updated_at = now()
      where id = p_id and status = 'acknowledged';
  else
    if v_action is null then raise exception 'CI_REASON_REQUIRED'; end if;
    update public.ci_environment_excursions set status = 'resolved', immediate_action = v_action, resolution_note = v_note,
      equipment_referred = coalesce(p_equipment_referred, false), resolved_by = v_actor,
      resolved_at = now(), updated_at = now()
      where id = p_id and status = 'open';
  end if;
  if not found then raise exception 'CI_ENV_EXCURSION_STATE'; end if;
end $$;
select ci_private.publish_rpc('ci_private.ci_complete_environment_excursion(uuid, text, text, boolean)'::pg_catalog.regprocedure);
