-- Receipt assessment aligned with LABCBH-Stock: five criteria (product condition, documentation,
-- item correctness, cold chain, complaint). Any failed answer makes the receipt "accepted with
-- justification", which requires at least one reason code and a note. Shelf life is no longer
-- assessed on new rows; history keeps the values it was recorded with.
set local search_path = '';

alter table public.ci_receipt_assessments
  add column has_complaint boolean,
  add column reason_codes text[] not null default '{}',
  add column other_reason_detail text;

alter table public.ci_receipt_assessments drop constraint ci_receipt_assessments_check;
alter table public.ci_receipt_assessments
  add constraint ci_receipt_assessments_answers_check check (
    correct_product is not null and correct_quantity is not null and packaging_ok is not null
    and temperature_required is not null and (temperature_required = false or temperature_ok is not null)
    and documentation_complete is not null and delivery_discrepancy is not null
  ),
  add constraint ci_receipt_assessments_reason_codes_check check (
    reason_codes <@ array['urgent_need','no_alternative','usable_condition','vendor_will_correct','documentation_pending','consume_before_expiry','approved_exception','other']::text[]
  );

-- Replaces the body in place (same signature), so grants and the public dispatcher stay as they are.
create or replace function ci_private.ci_save_receipt_assessment(p_receipt_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_wh smallint;
  v_id uuid;
  v_packaging boolean := (p_data->>'packaging_ok')::boolean;
  v_documentation boolean := (p_data->>'documentation_complete')::boolean;
  v_product boolean := (p_data->>'correct_product')::boolean;
  v_quantity boolean := (p_data->>'correct_quantity')::boolean;
  v_temperature_required boolean := (p_data->>'temperature_required')::boolean;
  v_temperature_ok boolean := (p_data->>'temperature_ok')::boolean;
  v_complaint boolean := coalesce((p_data->>'has_complaint')::boolean, false);
  v_notes text := nullif(btrim(coalesce(p_data->>'notes', '')), '');
  v_other text := nullif(btrim(coalesce(p_data->>'other_reason_detail', '')), '');
  v_reasons text[];
  v_problem boolean;
begin
  select warehouse_id into v_wh from public.ci_receipts where id = p_receipt_id;
  perform ci_private.require_role(v_wh, array['admin','supervisor','staff']);

  if jsonb_typeof(coalesce(p_data->'reason_codes', '[]'::jsonb)) <> 'array' then raise exception 'CI_RECEIPT_REASON_INVALID'; end if;
  select coalesce(array_agg(distinct value), '{}') into v_reasons from jsonb_array_elements_text(coalesce(p_data->'reason_codes', '[]'::jsonb));
  if not v_reasons <@ array['urgent_need','no_alternative','usable_condition','vendor_will_correct','documentation_pending','consume_before_expiry','approved_exception','other']::text[] then
    raise exception 'CI_RECEIPT_REASON_INVALID';
  end if;
  if not coalesce(v_temperature_required, false) then v_temperature_ok := null; end if;

  -- The discrepancy flag that feeds vendor metrics is derived here, never trusted from the client.
  v_problem := not v_packaging or not v_documentation or not v_product or not v_quantity
    or (v_temperature_required and not v_temperature_ok) or v_complaint;
  if v_problem then
    if cardinality(v_reasons) = 0 then raise exception 'CI_RECEIPT_REASON_REQUIRED'; end if;
    if v_notes is null then raise exception 'CI_RECEIPT_NOTE_REQUIRED'; end if;
  elsif cardinality(v_reasons) > 0 then
    raise exception 'CI_RECEIPT_REASON_NOT_ALLOWED';
  end if;
  if 'other' = any(v_reasons) and v_other is null then raise exception 'CI_RECEIPT_OTHER_REASON_REQUIRED'; end if;

  insert into public.ci_receipt_assessments(receipt_id, warehouse_id, correct_product, correct_quantity, packaging_ok, temperature_required, temperature_ok,
    shelf_life_ok, documentation_complete, delivery_discrepancy, notes, has_complaint, reason_codes, other_reason_detail, assessed_by)
  values (p_receipt_id, v_wh, v_product, v_quantity, v_packaging, v_temperature_required, v_temperature_ok,
    (p_data->>'shelf_life_ok')::boolean, v_documentation, coalesce(v_problem, false), v_notes, v_complaint, v_reasons,
    case when 'other' = any(v_reasons) then v_other end, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

notify pgrst, 'reload schema';
