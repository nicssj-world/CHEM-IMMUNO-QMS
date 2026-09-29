-- Vendor evaluation port from LABCBH-Stock, phase 4: signer positions and signatures, annual evaluation revisions
-- with frozen snapshots, and the LABCBH scoring rules. One evaluation per vendor, warehouse and fiscal year (พ.ศ.).
set local search_path = '';

-- ---------------------------------------------------------------------------
-- Signers: position title on the profile, drawn or uploaded PNG signature per user.
-- ---------------------------------------------------------------------------
alter table public.ci_user_profiles add column position_title text check (position_title is null or length(btrim(position_title)) between 1 and 200);

create table public.ci_user_signatures (
  user_id uuid primary key references auth.users(id),
  signature_png text not null check (signature_png ~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$' and length(signature_png) <= 400000),
  updated_at timestamptz not null default now()
);
alter table public.ci_user_signatures enable row level security;
-- A signature is a personal credential: only its owner reads it directly; finalize copies it into the report inside a definer function.
create policy ci_user_signatures_own_read on public.ci_user_signatures for select to authenticated using (user_id = auth.uid());
grant select on public.ci_user_signatures to authenticated;

create function ci_private.ci_save_my_signature(p_png text) returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (select 1 from public.ci_user_profiles where user_id = v_actor and active) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_png is null or p_png !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$' or length(p_png) > 400000 then raise exception 'CI_SIGNATURE_INVALID'; end if;
  insert into public.ci_user_signatures (user_id, signature_png, updated_at) values (v_actor, p_png, now())
  on conflict (user_id) do update set signature_png = excluded.signature_png, updated_at = now();
  perform ci_private.audit(null, 'SIGNATURE_SAVED', 'ci_user_signatures', v_actor::text);
end $$;

create function ci_private.ci_clear_my_signature() returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  delete from public.ci_user_signatures where user_id = auth.uid();
end $$;

-- People set their own position; an admin of every warehouse may set anyone's.
create function ci_private.ci_set_user_position(p_user_id uuid, p_position text) returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_position text := nullif(btrim(coalesce(p_position, '')), '');
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_user_id <> v_actor then perform ci_private.require_policy_admin(); end if;
  if not exists (select 1 from public.ci_user_profiles where user_id = p_user_id) then raise exception 'CI_USER_NOT_FOUND'; end if;
  if v_position is not null and length(v_position) > 200 then raise exception 'CI_POSITION_INVALID'; end if;
  update public.ci_user_profiles set position_title = v_position where user_id = p_user_id;
  perform ci_private.audit(null, 'POSITION_SET', 'ci_user_profiles', p_user_id::text, v_position);
end $$;

create function ci_private.signatory_snapshot(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v public.ci_user_profiles%rowtype;
begin
  select * into v from public.ci_user_profiles where user_id = p_user_id;
  if not found or not v.active then raise exception 'CI_SIGNER_INACTIVE'; end if;
  if v.position_title is null then raise exception 'CI_SIGNER_POSITION_REQUIRED'; end if;
  return jsonb_build_object('id', v.user_id, 'name', v.display_name, 'position', v.position_title, 'ephisId', v.ephis_id);
end $$;
revoke all on function ci_private.signatory_snapshot(uuid) from public, anon, authenticated;

-- Candidates for the three signature slots: active users with a position. Only admins and supervisors can list them.
create function ci_private.ci_list_evaluation_signers() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ci_private.require_any_role(array['admin','supervisor']);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.user_id, 'name', p.display_name, 'position', p.position_title, 'hasSignature', s.user_id is not null) order by p.display_name)
    from public.ci_user_profiles p left join public.ci_user_signatures s on s.user_id = p.user_id
    where p.active and p.position_title is not null), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Annual evaluation tables.
-- ---------------------------------------------------------------------------
create table public.ci_vendor_annual_evaluations (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.ci_vendors(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  fiscal_year integer not null check (fiscal_year between 2500 and 3000),
  current_final_revision_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (vendor_id, warehouse_id, fiscal_year)
);

create table public.ci_vendor_annual_evaluation_revisions (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.ci_vendor_annual_evaluations(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  revision_number integer not null check (revision_number > 0),
  supersedes_revision_id uuid references public.ci_vendor_annual_evaluation_revisions(id),
  policy_id uuid not null references public.ci_vendor_evaluation_policies(id),
  status text not null default 'draft' check (status in ('draft', 'final')),
  evidence_snapshot jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{32}$'),
  frozen_snapshot jsonb,
  report_fiscal_year integer,
  report_sequence integer check (report_sequence > 0),
  report_number text unique,
  judgment_summary text, strengths text, risks_concerns text, recommendations text,
  evaluator_id uuid references auth.users(id), evaluator_name_snapshot text, evaluator_position_snapshot text, evaluator_signature text,
  reviewer_id uuid references auth.users(id), reviewer_name_snapshot text, reviewer_position_snapshot text, reviewer_signature text,
  approver_id uuid references auth.users(id), approver_name_snapshot text, approver_position_snapshot text, approver_signature text,
  finalized_at timestamptz, finalized_by uuid references auth.users(id),
  created_at timestamptz not null default now(), created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(), updated_by uuid references auth.users(id),
  unique (evaluation_id, revision_number),
  unique (report_fiscal_year, report_sequence),
  constraint ci_annual_revision_state_check check (
    (status = 'draft' and frozen_snapshot is null and report_fiscal_year is null and report_sequence is null and report_number is null and finalized_at is null and finalized_by is null
      and evaluator_signature is null and reviewer_signature is null and approver_signature is null)
    or (status = 'final' and frozen_snapshot is not null and report_fiscal_year is not null and report_sequence is not null and report_number is not null and finalized_at is not null and finalized_by is not null
      and length(btrim(coalesce(judgment_summary, ''))) > 0 and length(btrim(coalesce(strengths, ''))) > 0 and length(btrim(coalesce(risks_concerns, ''))) > 0 and length(btrim(coalesce(recommendations, ''))) > 0
      and evaluator_id is not null and evaluator_name_snapshot is not null and evaluator_position_snapshot is not null and evaluator_signature like 'data:image/png;base64,%'
      and reviewer_id is not null and reviewer_name_snapshot is not null and reviewer_position_snapshot is not null and reviewer_signature like 'data:image/png;base64,%'
      and approver_id is not null and approver_name_snapshot is not null and approver_position_snapshot is not null and approver_signature like 'data:image/png;base64,%')
  )
);
create unique index ci_annual_revision_one_draft_key on public.ci_vendor_annual_evaluation_revisions (evaluation_id) where status = 'draft';
alter table public.ci_vendor_annual_evaluations add constraint ci_annual_evaluation_final_fk foreign key (current_final_revision_id) references public.ci_vendor_annual_evaluation_revisions(id);

alter table public.ci_vendor_annual_evaluations enable row level security;
alter table public.ci_vendor_annual_evaluation_revisions enable row level security;
create policy ci_annual_evaluations_read on public.ci_vendor_annual_evaluations for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_annual_revisions_read on public.ci_vendor_annual_evaluation_revisions for select to authenticated using (ci_private.can_read(warehouse_id));
grant select on public.ci_vendor_annual_evaluations, public.ci_vendor_annual_evaluation_revisions to authenticated;

-- A finalized report is a record: it cannot be edited or deleted; a change is a new revision.
create function ci_private.guard_annual_revision() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE' using errcode = '55000'; end if;
  if old.status = 'final' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE' using errcode = '55000'; end if;
  return new;
end $$;
create trigger ci_annual_revisions_guard before update or delete on public.ci_vendor_annual_evaluation_revisions for each row execute function ci_private.guard_annual_revision();

-- ---------------------------------------------------------------------------
-- Evidence: receipts, assessments and issues of one vendor in one warehouse and fiscal year.
-- ---------------------------------------------------------------------------
-- Receipts that were later reversed did not happen, so they are left out everywhere.
create function ci_private.vendor_evaluation_events(p_vendor uuid, p_warehouse smallint, p_fy integer)
returns table (receipt_id uuid, event_number text, invoice_id uuid, invoice_number text, po_number text, received_at timestamptz, received_date date, required boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, e.event_number, i.id, i.invoice_number, i.po_number, r.received_at, (r.received_at at time zone 'Asia/Bangkok')::date,
         (r.received_at at time zone 'Asia/Bangkok')::date >= (select assessment_required_from from public.ci_vendor_evaluation_settings)
  from public.ci_receipts r
  join public.ci_invoices i on i.id = r.invoice_id
  left join public.ci_receipt_event_numbers e on e.receipt_id = r.id
  where r.warehouse_id = p_warehouse and i.vendor_id = p_vendor
    and ci_private.fiscal_year_be((r.received_at at time zone 'Asia/Bangkok')::date) = p_fy
    and not exists (
      select 1 from public.ci_stock_transactions tx join public.ci_stock_transactions rev on rev.source_transaction_id = tx.id and rev.kind = 'reversal'
      where tx.receipt_id = r.id and tx.kind = 'receive')
$$;
revoke all on function ci_private.vendor_evaluation_events(uuid, smallint, integer) from public, anon, authenticated;

-- Non-cancelled issues of the vendor in this warehouse whose fiscal year is the year of their receipt (or of their opening when they have none).
create function ci_private.vendor_evaluation_issues(p_vendor uuid, p_warehouse smallint, p_fy integer) returns setof public.ci_vendor_issues language sql stable security definer set search_path = '' as $$
  select iss.* from public.ci_vendor_issues iss
  where iss.vendor_id = p_vendor and iss.warehouse_id = p_warehouse and iss.status <> 'cancelled'
    and coalesce((select ci_private.fiscal_year_be((r.received_at at time zone 'Asia/Bangkok')::date) from public.ci_receipts r where r.id = iss.receipt_id),
                 ci_private.fiscal_year_be((iss.created_at at time zone 'Asia/Bangkok')::date)) = p_fy
$$;
revoke all on function ci_private.vendor_evaluation_issues(uuid, smallint, integer) from public, anon, authenticated;

create function ci_private.vendor_evaluation_live_snapshot(p_vendor uuid, p_warehouse smallint, p_fy integer) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := make_date(p_fy - 544, 10, 1);
  v_to date := make_date(p_fy - 543, 9, 30);
  v_required date;
  v_vendor jsonb; v_wh jsonb;
  v_completed integer; v_pending integer; v_events integer;
  n_pack integer; n_doc integer; n_item integer; n_cold integer; d_cold integer; n_comp integer; d_comp integer;
  n_ship integer; d_ship integer; n_life integer; d_life integer; n_fix integer; d_fix integer; supplementary integer;
  v_criteria jsonb; v_issues jsonb; v_receipts jsonb; v_assessments jsonb;
  v_invoices integer; v_open integer; v_resolved integer;
begin
  select assessment_required_from into v_required from public.ci_vendor_evaluation_settings;
  select jsonb_build_object('id', id, 'vendorCode', vendor_code, 'name', name, 'legalName', legal_name, 'taxId', tax_id, 'taxBranchCode', tax_branch_code, 'address', address)
    into v_vendor from public.ci_vendors where id = p_vendor;
  if v_vendor is null then raise exception 'CI_VENDOR_NOT_FOUND'; end if;
  select jsonb_build_object('id', id, 'code', code, 'name', name) into v_wh from public.ci_warehouses where id = p_warehouse;
  if v_wh is null then raise exception 'CI_WAREHOUSE_INVALID'; end if;

  select count(*) into v_events from ci_private.vendor_evaluation_events(p_vendor, p_warehouse, p_fy);
  select count(a.id), count(*) filter (where a.id is null) into v_completed, v_pending
    from ci_private.vendor_evaluation_events(p_vendor, p_warehouse, p_fy) e left join public.ci_receipt_assessments a on a.receipt_id = e.receipt_id where e.required;
  select count(*) filter (where a.packaging_ok), count(*) filter (where a.documentation_complete), count(*) filter (where a.correct_product and a.correct_quantity),
         count(*) filter (where a.temperature_required and a.temperature_ok), count(*) filter (where a.temperature_required), count(*) filter (where not coalesce(a.has_complaint, false))
    into n_pack, n_doc, n_item, n_cold, d_cold, n_comp
    from ci_private.vendor_evaluation_events(p_vendor, p_warehouse, p_fy) e join public.ci_receipt_assessments a on a.receipt_id = e.receipt_id where e.required;
  d_comp := v_completed;

  -- 1: invoice lines of this warehouse on invoices that reached an end state in the fiscal year.
  with ended as (
    select i.id, case when i.status = 'closed_short' then ci_private.fiscal_year_be((i.closed_short_at at time zone 'Asia/Bangkok')::date)
                      else (select ci_private.fiscal_year_be((max(r.received_at) at time zone 'Asia/Bangkok')::date) from public.ci_receipts r where r.invoice_id = i.id) end as fy
    from public.ci_invoices i where i.vendor_id = p_vendor and i.status in ('closed', 'closed_short')
  )
  select count(*) filter (where pr.remaining_quantity <= 0), count(*) into n_ship, d_ship
    from ended join public.ci_invoice_line_progress pr on pr.invoice_id = ended.id and pr.warehouse_id = p_warehouse where ended.fy = p_fy;
  -- 2: received lines whose LOT was not expired on the receipt date.
  select count(*) filter (where lot.expiry_date >= e.received_date), count(*) into n_life, d_life
    from ci_private.vendor_evaluation_events(p_vendor, p_warehouse, p_fy) e join public.ci_receipt_lines rl on rl.receipt_id = e.receipt_id join public.ci_stock_lots lot on lot.id = rl.lot_id;

  select count(*) filter (where status = 'resolved'), count(*), count(*) filter (where status = 'open'), count(*) filter (where status = 'resolved'),
         count(*) filter (where source_kind = 'manual' and issue_type in ('complaint', 'other'))
    into n_fix, d_fix, v_open, v_resolved, supplementary from ci_private.vendor_evaluation_issues(p_vendor, p_warehouse, p_fy);
  select count(distinct i.id) into v_invoices from public.ci_invoices i join public.ci_invoice_lines l on l.invoice_id = i.id
    where i.vendor_id = p_vendor and l.warehouse_id = p_warehouse and ci_private.fiscal_year_be((i.invoice_date)::date) = p_fy;

  v_criteria := jsonb_build_array(
    jsonb_build_object('criterionCode', 'delivery_completeness', 'displayOrder', 1, 'numerator', n_ship, 'denominator', d_ship),
    jsonb_build_object('criterionCode', 'shelf_life', 'displayOrder', 2, 'numerator', n_life, 'denominator', d_life),
    jsonb_build_object('criterionCode', 'product_packaging', 'displayOrder', 3, 'numerator', n_pack, 'denominator', v_completed),
    jsonb_build_object('criterionCode', 'documentation', 'displayOrder', 4, 'numerator', n_doc, 'denominator', v_completed),
    jsonb_build_object('criterionCode', 'item_correctness', 'displayOrder', 5, 'numerator', n_item, 'denominator', v_completed),
    jsonb_build_object('criterionCode', 'cold_chain', 'displayOrder', 6, 'numerator', n_cold, 'denominator', d_cold),
    jsonb_build_object('criterionCode', 'complaint_performance', 'displayOrder', 7, 'numerator', n_comp, 'denominator', d_comp, 'supplementaryCount', supplementary),
    jsonb_build_object('criterionCode', 'corrective_action', 'displayOrder', 8, 'numerator', n_fix, 'denominator', d_fix));
  select jsonb_agg(c || jsonb_build_object('applicable', (c ->> 'denominator')::integer > 0,
      'percentage', case when (c ->> 'denominator')::integer > 0 then round((c ->> 'numerator')::numeric * 100 / (c ->> 'denominator')::numeric, 2) end)
      order by (c ->> 'displayOrder')::integer) into v_criteria from jsonb_array_elements(v_criteria) c;

  select coalesce(jsonb_agg(jsonb_build_object('id', iss.id, 'issueType', iss.issue_type, 'sourceKind', iss.source_kind, 'status', iss.status, 'openedAt', iss.created_at,
      'description', iss.description, 'resolutionAction', iss.resolution_action, 'resolutionNote', iss.resolution_note, 'resolvedAt', iss.resolved_at,
      'invoiceNumber', (select invoice_number from public.ci_invoices where id = iss.invoice_id), 'eventNumber', (select event_number from public.ci_receipt_event_numbers where receipt_id = iss.receipt_id))
      order by iss.created_at, iss.id), '[]'::jsonb) into v_issues from ci_private.vendor_evaluation_issues(p_vendor, p_warehouse, p_fy) iss;
  select coalesce(jsonb_agg(jsonb_build_object('eventNumber', e.event_number, 'receivedDate', e.received_date, 'invoiceNumber', e.invoice_number, 'poNumber', e.po_number,
      'assessmentState', case when not e.required then 'not_required' when a.id is null then 'pending' else 'completed' end) order by e.received_date, e.event_number), '[]'::jsonb)
    into v_receipts from ci_private.vendor_evaluation_events(p_vendor, p_warehouse, p_fy) e left join public.ci_receipt_assessments a on a.receipt_id = e.receipt_id;
  select coalesce(jsonb_agg(jsonb_build_object('eventNumber', e.event_number, 'receivedDate', e.received_date, 'invoiceNumber', e.invoice_number,
      'productCondition', case when a.packaging_ok then 'normal' else 'abnormal' end, 'documentation', case when a.documentation_complete then 'complete' else 'incomplete' end,
      'itemCorrectness', case when a.correct_product and a.correct_quantity then 'correct' else 'problem' end, 'coldChainApplicable', a.temperature_required,
      'coldChainCondition', case when a.temperature_required then case when a.temperature_ok then 'appropriate' else 'inappropriate' end end,
      'hasComplaint', coalesce(a.has_complaint, false), 'acceptanceDecision', case when a.delivery_discrepancy then 'accepted_with_justification' else 'accepted' end,
      'note', a.notes, 'reasons', to_jsonb(a.reason_codes), 'otherReasonDetail', a.other_reason_detail) order by e.received_date, e.event_number), '[]'::jsonb)
    into v_assessments from ci_private.vendor_evaluation_events(p_vendor, p_warehouse, p_fy) e join public.ci_receipt_assessments a on a.receipt_id = e.receipt_id where e.required;

  return jsonb_build_object('vendor', v_vendor, 'warehouse', v_wh, 'fiscalYear', p_fy,
    'coverage', jsonb_build_object('startDate', greatest(v_from, v_required), 'endDate', v_to, 'assessmentRequiredFrom', v_required, 'completed', v_completed, 'pending', v_pending,
      'percentage', case when v_completed + v_pending = 0 then null else round(v_completed * 100.0 / (v_completed + v_pending), 2) end),
    'activity', jsonb_build_object('invoices', v_invoices, 'receipts', v_events, 'completedAssessments', v_completed, 'pendingAssessments', v_pending, 'openIssues', v_open, 'resolvedIssues', v_resolved),
    'criteria', v_criteria, 'issues', v_issues, 'receipts', v_receipts, 'assessments', v_assessments, 'capturedAt', now());
end $$;
revoke all on function ci_private.vendor_evaluation_live_snapshot(uuid, smallint, integer) from public, anon, authenticated;

-- The hash ignores capturedAt only, so it changes exactly when the evidence changes.
create function ci_private.evidence_hash(p_snapshot jsonb) returns text language sql immutable set search_path = '' as $$ select md5((p_snapshot - 'capturedAt')::text) $$;
revoke all on function ci_private.evidence_hash(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Draft, save, refresh, finalize.
-- ---------------------------------------------------------------------------
-- The policy that applies to a fiscal year: an approved one if there is one, otherwise the newest proposal.
create function ci_private.policy_for_fiscal_year(p_fy integer) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.ci_vendor_evaluation_policies
   where status in ('proposed', 'approved') and effective_from_fiscal_year <= p_fy and coalesce(effective_to_fiscal_year, 3000) >= p_fy
   order by (status = 'approved') desc, created_at desc limit 1
$$;
revoke all on function ci_private.policy_for_fiscal_year(integer) from public, anon, authenticated;

create function ci_private.ci_create_vendor_annual_evaluation_draft(p_vendor_id uuid, p_warehouse_id smallint, p_fiscal_year integer) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := ci_private.require_role(p_warehouse_id, array['admin','supervisor']);
  v_eval public.ci_vendor_annual_evaluations%rowtype;
  v_draft uuid; v_prev public.ci_vendor_annual_evaluation_revisions%rowtype;
  v_policy uuid; v_snapshot jsonb; v_rev integer; v_id uuid;
begin
  if p_fiscal_year is null or p_fiscal_year not between 2500 and 3000 then raise exception 'CI_FISCAL_YEAR_INVALID'; end if;
  if not exists (select 1 from public.ci_vendors where id = p_vendor_id) then raise exception 'CI_VENDOR_NOT_FOUND'; end if;
  v_policy := ci_private.policy_for_fiscal_year(p_fiscal_year);
  if v_policy is null then raise exception 'CI_POLICY_NOT_FOUND'; end if;
  insert into public.ci_vendor_annual_evaluations (vendor_id, warehouse_id, fiscal_year, created_by) values (p_vendor_id, p_warehouse_id, p_fiscal_year, v_actor)
  on conflict (vendor_id, warehouse_id, fiscal_year) do nothing;
  select * into v_eval from public.ci_vendor_annual_evaluations where vendor_id = p_vendor_id and warehouse_id = p_warehouse_id and fiscal_year = p_fiscal_year for update;
  select id into v_draft from public.ci_vendor_annual_evaluation_revisions where evaluation_id = v_eval.id and status = 'draft';
  if v_draft is not null then return v_draft; end if;
  v_snapshot := ci_private.vendor_evaluation_live_snapshot(p_vendor_id, p_warehouse_id, p_fiscal_year);
  select coalesce(max(revision_number), 0) + 1 into v_rev from public.ci_vendor_annual_evaluation_revisions where evaluation_id = v_eval.id;
  if v_eval.current_final_revision_id is not null then select * into v_prev from public.ci_vendor_annual_evaluation_revisions where id = v_eval.current_final_revision_id; end if;
  insert into public.ci_vendor_annual_evaluation_revisions (evaluation_id, warehouse_id, revision_number, supersedes_revision_id, policy_id, evidence_snapshot, evidence_hash,
      judgment_summary, strengths, risks_concerns, recommendations, evaluator_id, evaluator_name_snapshot, evaluator_position_snapshot, reviewer_id, reviewer_name_snapshot, reviewer_position_snapshot,
      approver_id, approver_name_snapshot, approver_position_snapshot, created_by, updated_by)
  values (v_eval.id, p_warehouse_id, v_rev, v_prev.id, v_policy, v_snapshot, ci_private.evidence_hash(v_snapshot),
      v_prev.judgment_summary, v_prev.strengths, v_prev.risks_concerns, v_prev.recommendations, v_prev.evaluator_id, v_prev.evaluator_name_snapshot, v_prev.evaluator_position_snapshot,
      v_prev.reviewer_id, v_prev.reviewer_name_snapshot, v_prev.reviewer_position_snapshot, v_prev.approver_id, v_prev.approver_name_snapshot, v_prev.approver_position_snapshot, v_actor, v_actor)
  returning id into v_id;
  perform ci_private.audit(p_warehouse_id, 'ANNUAL_DRAFT_CREATED', 'ci_vendor_annual_evaluations', v_eval.id::text, p_fiscal_year::text);
  return v_id;
end $$;

create function ci_private.ci_save_vendor_annual_evaluation_draft(p_revision_id uuid, p_data jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_rev public.ci_vendor_annual_evaluation_revisions%rowtype;
  v_actor uuid;
  e jsonb; r jsonb; a jsonb;
begin
  select * into v_rev from public.ci_vendor_annual_evaluation_revisions where id = p_revision_id for update;
  if not found then raise exception 'CI_ANNUAL_REVISION_NOT_FOUND'; end if;
  v_actor := ci_private.require_role(v_rev.warehouse_id, array['admin','supervisor']);
  if v_rev.status <> 'draft' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE' using errcode = '55000'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or exists (select 1 from jsonb_object_keys(p_data) k where k not in ('summary','strengths','risksConcerns','recommendations','evaluatorId','reviewerId','approverId')) then
    raise exception 'CI_ANNUAL_INPUT_INVALID';
  end if;
  if length(coalesce(p_data ->> 'summary', '')) > 4000 or length(coalesce(p_data ->> 'strengths', '')) > 4000 or length(coalesce(p_data ->> 'risksConcerns', '')) > 4000 or length(coalesce(p_data ->> 'recommendations', '')) > 4000 then
    raise exception 'CI_ANNUAL_INPUT_INVALID';
  end if;
  e := case when nullif(p_data ->> 'evaluatorId', '') is null then null else ci_private.signatory_snapshot((p_data ->> 'evaluatorId')::uuid) end;
  r := case when nullif(p_data ->> 'reviewerId', '') is null then null else ci_private.signatory_snapshot((p_data ->> 'reviewerId')::uuid) end;
  a := case when nullif(p_data ->> 'approverId', '') is null then null else ci_private.signatory_snapshot((p_data ->> 'approverId')::uuid) end;
  update public.ci_vendor_annual_evaluation_revisions set
    judgment_summary = nullif(btrim(coalesce(p_data ->> 'summary', '')), ''), strengths = nullif(btrim(coalesce(p_data ->> 'strengths', '')), ''),
    risks_concerns = nullif(btrim(coalesce(p_data ->> 'risksConcerns', '')), ''), recommendations = nullif(btrim(coalesce(p_data ->> 'recommendations', '')), ''),
    evaluator_id = (e ->> 'id')::uuid, evaluator_name_snapshot = e ->> 'name', evaluator_position_snapshot = e ->> 'position',
    reviewer_id = (r ->> 'id')::uuid, reviewer_name_snapshot = r ->> 'name', reviewer_position_snapshot = r ->> 'position',
    approver_id = (a ->> 'id')::uuid, approver_name_snapshot = a ->> 'name', approver_position_snapshot = a ->> 'position',
    updated_at = now(), updated_by = v_actor
  where id = p_revision_id;
end $$;

create function ci_private.ci_refresh_vendor_annual_evaluation_draft(p_revision_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_rev public.ci_vendor_annual_evaluation_revisions%rowtype; v_eval public.ci_vendor_annual_evaluations%rowtype; v_snapshot jsonb; v_actor uuid;
begin
  select * into v_rev from public.ci_vendor_annual_evaluation_revisions where id = p_revision_id for update;
  if not found then raise exception 'CI_ANNUAL_REVISION_NOT_FOUND'; end if;
  v_actor := ci_private.require_role(v_rev.warehouse_id, array['admin','supervisor']);
  if v_rev.status <> 'draft' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE' using errcode = '55000'; end if;
  select * into v_eval from public.ci_vendor_annual_evaluations where id = v_rev.evaluation_id;
  v_snapshot := ci_private.vendor_evaluation_live_snapshot(v_eval.vendor_id, v_eval.warehouse_id, v_eval.fiscal_year);
  -- Refreshing also moves the draft to the policy that applies now, so a draft opened while the policy was only a proposal is not stuck.
  update public.ci_vendor_annual_evaluation_revisions set evidence_snapshot = v_snapshot, evidence_hash = ci_private.evidence_hash(v_snapshot),
    policy_id = coalesce(ci_private.policy_for_fiscal_year(v_eval.fiscal_year), policy_id), updated_at = now(), updated_by = v_actor where id = p_revision_id;
end $$;

create function ci_private.ci_finalize_vendor_annual_evaluation(p_revision_id uuid) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_rev public.ci_vendor_annual_evaluation_revisions%rowtype;
  v_eval public.ci_vendor_annual_evaluations%rowtype;
  v_policy public.ci_vendor_evaluation_policies%rowtype;
  v_actor uuid;
  v_live jsonb; v_coverage numeric;
  v_sig_e text; v_sig_r text; v_sig_a text;
  v_applicable_weight numeric; v_score numeric; v_seq integer; v_number text;
  v_criteria jsonb; v_signers jsonb;
begin
  select * into v_rev from public.ci_vendor_annual_evaluation_revisions where id = p_revision_id for update;
  if not found then raise exception 'CI_ANNUAL_REVISION_NOT_FOUND'; end if;
  v_actor := ci_private.require_role(v_rev.warehouse_id, array['admin','supervisor']);
  if v_rev.status <> 'draft' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE' using errcode = '55000'; end if;
  select * into v_eval from public.ci_vendor_annual_evaluations where id = v_rev.evaluation_id for update;
  select * into v_policy from public.ci_vendor_evaluation_policies where id = v_rev.policy_id for share;
  if v_policy.status <> 'approved' then raise exception 'CI_POLICY_NOT_APPROVED'; end if;

  v_live := ci_private.vendor_evaluation_live_snapshot(v_eval.vendor_id, v_eval.warehouse_id, v_eval.fiscal_year);
  if ci_private.evidence_hash(v_live) <> v_rev.evidence_hash then raise exception 'CI_ANNUAL_EVIDENCE_STALE' using errcode = '40001'; end if;
  v_coverage := nullif(v_live #>> '{coverage,percentage}', '')::numeric;
  if v_coverage is not null and v_coverage < v_policy.minimum_coverage_percent then raise exception 'CI_ANNUAL_COVERAGE_LOW'; end if;

  if v_rev.judgment_summary is null or v_rev.strengths is null or v_rev.risks_concerns is null or v_rev.recommendations is null then raise exception 'CI_ANNUAL_TEXT_REQUIRED'; end if;
  if v_rev.evaluator_id is null or v_rev.reviewer_id is null or v_rev.approver_id is null then raise exception 'CI_ANNUAL_SIGNERS_REQUIRED'; end if;
  -- Names and positions are re-read now, so the report shows what they are at signing time; signatures are copied from each signer's own record.
  v_signers := jsonb_build_object('evaluator', ci_private.signatory_snapshot(v_rev.evaluator_id), 'reviewer', ci_private.signatory_snapshot(v_rev.reviewer_id), 'approver', ci_private.signatory_snapshot(v_rev.approver_id));
  select signature_png into v_sig_e from public.ci_user_signatures where user_id = v_rev.evaluator_id;
  select signature_png into v_sig_r from public.ci_user_signatures where user_id = v_rev.reviewer_id;
  select signature_png into v_sig_a from public.ci_user_signatures where user_id = v_rev.approver_id;
  if v_sig_e is null or v_sig_r is null or v_sig_a is null then raise exception 'CI_ANNUAL_SIGNATURE_MISSING'; end if;

  -- Score: weighted share of the criteria that have data; a criterion with no denominator drops out and its weight is spread over the rest.
  select sum(c.weight) into v_applicable_weight
    from public.ci_vendor_evaluation_policy_criteria c join jsonb_array_elements(v_live -> 'criteria') s on s ->> 'criterionCode' = c.criterion_code
   where c.policy_id = v_policy.id and (s ->> 'denominator')::integer > 0;
  if v_applicable_weight is null or v_applicable_weight <= 0 then raise exception 'CI_ANNUAL_NO_APPLICABLE_CRITERIA'; end if;
  select jsonb_agg(jsonb_build_object('criterionCode', c.criterion_code, 'label', c.label, 'displayOrder', c.display_order, 'numerator', (s ->> 'numerator')::integer, 'denominator', (s ->> 'denominator')::integer,
      'applicable', (s ->> 'denominator')::integer > 0, 'percentage', s -> 'percentage', 'weight', c.weight,
      'effectiveWeight', case when (s ->> 'denominator')::integer > 0 then round(c.weight * 100 / v_applicable_weight, 2) end,
      'weightedScore', case when (s ->> 'denominator')::integer > 0 then round((s ->> 'numerator')::numeric / (s ->> 'denominator')::numeric * c.weight / v_applicable_weight * 100, 2) end,
      'supplementaryCount', s -> 'supplementaryCount', 'evidenceDefinition', c.evidence_definition, 'calculationDefinition', c.calculation_definition, 'naDefinition', c.na_definition) order by c.display_order),
    round(sum(case when (s ->> 'denominator')::integer > 0 then (s ->> 'numerator')::numeric / (s ->> 'denominator')::numeric * c.weight / v_applicable_weight * 100 else 0 end), 2)
    into v_criteria, v_score
    from public.ci_vendor_evaluation_policy_criteria c join jsonb_array_elements(v_live -> 'criteria') s on s ->> 'criterionCode' = c.criterion_code where c.policy_id = v_policy.id;

  perform pg_advisory_xact_lock(86421, v_eval.fiscal_year);
  select coalesce(max(report_sequence), 0) + 1 into v_seq from public.ci_vendor_annual_evaluation_revisions where report_fiscal_year = v_eval.fiscal_year;
  v_number := 'VE-' || v_eval.fiscal_year || '-' || lpad(v_seq::text, 4, '0');

  update public.ci_vendor_annual_evaluation_revisions set
    status = 'final', evidence_snapshot = v_live,
    frozen_snapshot = jsonb_build_object('evidence', v_live, 'criteria', v_criteria, 'score', v_score, 'result', case when v_score >= v_policy.pass_threshold then 'pass' else 'fail' end,
      'policy', jsonb_build_object('id', v_policy.id, 'version', v_policy.version, 'passThreshold', v_policy.pass_threshold, 'minimumCoveragePercent', v_policy.minimum_coverage_percent,
        'approvedAt', v_policy.approved_at, 'approvedByName', v_policy.approved_by_name_snapshot),
      'judgment', jsonb_build_object('summary', v_rev.judgment_summary, 'strengths', v_rev.strengths, 'risksConcerns', v_rev.risks_concerns, 'recommendations', v_rev.recommendations),
      'signatories', v_signers, 'reportNumber', v_number, 'revision', v_rev.revision_number, 'finalizedAt', now()),
    report_fiscal_year = v_eval.fiscal_year, report_sequence = v_seq, report_number = v_number,
    evaluator_name_snapshot = v_signers -> 'evaluator' ->> 'name', evaluator_position_snapshot = v_signers -> 'evaluator' ->> 'position', evaluator_signature = v_sig_e,
    reviewer_name_snapshot = v_signers -> 'reviewer' ->> 'name', reviewer_position_snapshot = v_signers -> 'reviewer' ->> 'position', reviewer_signature = v_sig_r,
    approver_name_snapshot = v_signers -> 'approver' ->> 'name', approver_position_snapshot = v_signers -> 'approver' ->> 'position', approver_signature = v_sig_a,
    finalized_at = now(), finalized_by = v_actor, updated_at = now(), updated_by = v_actor
  where id = p_revision_id;
  update public.ci_vendor_annual_evaluations set current_final_revision_id = p_revision_id where id = v_eval.id;
  perform ci_private.audit(v_eval.warehouse_id, 'ANNUAL_FINALIZED', 'ci_vendor_annual_evaluations', v_eval.id::text, v_number);
  return v_number;
end $$;

-- The old draft → reviewed → approved evaluation had no score or policy behind it; the LABCBH flow above replaces it.
-- Its table stays, read-only history.
drop function public.ci_save_vendor_evaluation(uuid, smallint, integer, jsonb);
drop function ci_private.ci_save_vendor_evaluation(uuid, smallint, integer, jsonb);
drop function public.ci_advance_vendor_evaluation(uuid, text);
drop function ci_private.ci_advance_vendor_evaluation(uuid, text);

select ci_private.publish_rpc('ci_private.ci_save_my_signature(text)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_clear_my_signature()'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_set_user_position(uuid, text)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_list_evaluation_signers()'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_create_vendor_annual_evaluation_draft(uuid, smallint, integer)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_save_vendor_annual_evaluation_draft(uuid, jsonb)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_refresh_vendor_annual_evaluation_draft(uuid)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_finalize_vendor_annual_evaluation(uuid)'::regprocedure);

notify pgrst, 'reload schema';
