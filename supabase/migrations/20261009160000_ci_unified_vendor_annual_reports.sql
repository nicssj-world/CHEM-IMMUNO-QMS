-- Independent annual vendor evaluations for one logical CHEM-IMMUNO inventory.
-- Existing signed CHE/IMM reports and stock ledgers are never mutated.
create table public.ci_unified_vendor_reports (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.ci_vendors(id),
  fiscal_year integer not null check (fiscal_year between 2500 and 3000),
  revision_number integer not null check (revision_number > 0),
  policy_id uuid not null references public.ci_vendor_evaluation_policies(id),
  status text not null default 'draft' check(status in ('draft','final')),
  evidence_snapshot jsonb not null,
  evidence_hash text not null check(evidence_hash ~ '^[0-9a-f]{32}$'),
  frozen_snapshot jsonb,
  judgment_summary text,
  strengths text,
  risks_concerns text,
  recommendations text,
  evaluator_id uuid references auth.users(id),
  reviewer_id uuid references auth.users(id),
  approver_id uuid references auth.users(id),
  evaluator_name_snapshot text,
  evaluator_position_snapshot text,
  reviewer_name_snapshot text,
  reviewer_position_snapshot text,
  approver_name_snapshot text,
  approver_position_snapshot text,
  evaluator_signature text,
  reviewer_signature text,
  approver_signature text,
  report_number text unique,
  finalized_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vendor_id,fiscal_year,revision_number),
  constraint ci_unified_vendor_final_integrity check(
    (status='draft' and frozen_snapshot is null and report_number is null and finalized_at is null
       and evaluator_signature is null and reviewer_signature is null and approver_signature is null)
    or
    (status='final' and frozen_snapshot is not null and report_number is not null and finalized_at is not null
       and nullif(btrim(coalesce(judgment_summary,'')),'') is not null
       and nullif(btrim(coalesce(strengths,'')),'') is not null
       and nullif(btrim(coalesce(risks_concerns,'')),'') is not null
       and nullif(btrim(coalesce(recommendations,'')),'') is not null
       and evaluator_signature like 'data:image/png;base64,%'
       and reviewer_signature like 'data:image/png;base64,%'
       and approver_signature like 'data:image/png;base64,%')
  )
);
create unique index ci_unified_vendor_one_draft on public.ci_unified_vendor_reports(vendor_id,fiscal_year)
  where status='draft';
create index ci_unified_vendor_reports_lookup on public.ci_unified_vendor_reports(vendor_id,fiscal_year,created_at desc);
alter table public.ci_unified_vendor_reports enable row level security;
revoke all on public.ci_unified_vendor_reports from public,anon;
grant select on public.ci_unified_vendor_reports to authenticated;
create policy ci_unified_vendor_reports_read on public.ci_unified_vendor_reports
 for select to authenticated using(ci_private.can_read(1::smallint) and ci_private.can_read(2::smallint));

create function ci_private.ci_unified_vendor_evidence(p_vendor uuid,p_fy integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_che jsonb; v_imm jsonb; v_vendor jsonb;
  v_completed int; v_pending int; v_invoices int; v_criteria jsonb;
begin
  perform ci_private.require_role(1::smallint,array['viewer','staff','supervisor','admin']);
  perform ci_private.require_role(2::smallint,array['viewer','staff','supervisor','admin']);
  if p_fy is null or p_fy not between 2500 and 3000 then raise exception 'CI_FISCAL_YEAR_INVALID'; end if;
  v_che:=ci_private.vendor_evaluation_live_snapshot(p_vendor,1::smallint,p_fy);
  v_imm:=ci_private.vendor_evaluation_live_snapshot(p_vendor,2::smallint,p_fy);
  v_vendor:=v_che->'vendor';
  v_completed:=coalesce((v_che#>>'{coverage,completed}')::integer,0)+coalesce((v_imm#>>'{coverage,completed}')::integer,0);
  v_pending:=coalesce((v_che#>>'{coverage,pending}')::integer,0)+coalesce((v_imm#>>'{coverage,pending}')::integer,0);
  select count(distinct i.id) into v_invoices from public.ci_invoices i
     join public.ci_invoice_lines l on l.invoice_id=i.id and l.warehouse_id in (1,2)
    where i.vendor_id=p_vendor and ci_private.fiscal_year_be(i.invoice_date::date)=p_fy;
  select coalesce(jsonb_agg(jsonb_build_object(
      'criterionCode',name,'displayOrder',ordinal,'numerator',num,'denominator',den,
      'applicable',den>0,'percentage',case when den>0 then round(num*100.0/den,2) else null end,
      'supplementaryCount',supp) order by ordinal),'[]'::jsonb)
  into v_criteria from (
    select entry->>'criterionCode' as name,
      min((entry->>'displayOrder')::integer) as ordinal,
      sum(coalesce((entry->>'numerator')::integer,0)) as num,
      sum(coalesce((entry->>'denominator')::integer,0)) as den,
      sum(coalesce((entry->>'supplementaryCount')::integer,0)) as supp
    from jsonb_array_elements((v_che->'criteria')||(v_imm->'criteria')) entry
    group by entry->>'criterionCode'
  ) s;
  return jsonb_build_object(
    'vendor',v_vendor,'warehouse',jsonb_build_object('id',0,'code','ALL','name','CHEM-IMMUNO'),
    'fiscalYear',p_fy,
    'coverage',jsonb_build_object(
       'startDate',least(v_che#>>'{coverage,startDate}',v_imm#>>'{coverage,startDate}'),
       'endDate',greatest(v_che#>>'{coverage,endDate}',v_imm#>>'{coverage,endDate}'),
       'assessmentRequiredFrom',least(v_che#>>'{coverage,assessmentRequiredFrom}',v_imm#>>'{coverage,assessmentRequiredFrom}'),
       'completed',v_completed,'pending',v_pending,
       'percentage',case when v_completed+v_pending=0 then null else round(v_completed*100.0/(v_completed+v_pending),2) end),
    'activity',jsonb_build_object('invoices',v_invoices,
       'receipts',coalesce((v_che#>>'{activity,receipts}')::integer,0)+coalesce((v_imm#>>'{activity,receipts}')::integer,0),
       'completedAssessments',v_completed,'pendingAssessments',v_pending,
       'openIssues',coalesce((v_che#>>'{activity,openIssues}')::integer,0)+coalesce((v_imm#>>'{activity,openIssues}')::integer,0),
       'resolvedIssues',coalesce((v_che#>>'{activity,resolvedIssues}')::integer,0)+coalesce((v_imm#>>'{activity,resolvedIssues}')::integer,0)),
    'criteria',v_criteria,
    'issues',coalesce(v_che->'issues','[]'::jsonb)||coalesce(v_imm->'issues','[]'::jsonb),
    'receipts',coalesce(v_che->'receipts','[]'::jsonb)||coalesce(v_imm->'receipts','[]'::jsonb),
    'assessments',coalesce(v_che->'assessments','[]'::jsonb)||coalesce(v_imm->'assessments','[]'::jsonb),
    'capturedAt',now());
end $$;
revoke all on function ci_private.ci_unified_vendor_evidence(uuid,integer) from public,anon,authenticated;

create function ci_private.ci_create_unified_vendor_report(p_vendor uuid,p_fy integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_policy uuid; v_id uuid; v_rev int; v_prior public.ci_unified_vendor_reports%rowtype; v_evidence jsonb;
begin
 v_actor:=ci_private.require_role(1::smallint,array['supervisor','admin']);
 perform ci_private.require_role(2::smallint,array['supervisor','admin']);
 if p_fy is null or p_fy not between 2500 and 3000 then raise exception 'CI_FISCAL_YEAR_INVALID'; end if;
 if not exists(select 1 from public.ci_vendors where id=p_vendor) then raise exception 'CI_VENDOR_NOT_FOUND'; end if;
 perform pg_advisory_xact_lock(hashtext(p_vendor::text),p_fy);
 select id into v_id from public.ci_unified_vendor_reports where vendor_id=p_vendor and fiscal_year=p_fy and status='draft';
 if v_id is not null then return v_id; end if;
 v_policy:=ci_private.policy_for_fiscal_year(p_fy);
 if v_policy is null then raise exception 'CI_POLICY_NOT_FOUND'; end if;
 select * into v_prior from public.ci_unified_vendor_reports where vendor_id=p_vendor and fiscal_year=p_fy and status='final' order by revision_number desc limit 1;
 select coalesce(max(revision_number),0)+1 into v_rev from public.ci_unified_vendor_reports where vendor_id=p_vendor and fiscal_year=p_fy;
 v_evidence:=ci_private.ci_unified_vendor_evidence(p_vendor,p_fy);
 insert into public.ci_unified_vendor_reports(vendor_id,fiscal_year,revision_number,policy_id,evidence_snapshot,evidence_hash,
   judgment_summary,strengths,risks_concerns,recommendations,evaluator_id,reviewer_id,approver_id,created_by,updated_by)
 values(p_vendor,p_fy,v_rev,v_policy,v_evidence,ci_private.evidence_hash(v_evidence),
   v_prior.judgment_summary,v_prior.strengths,v_prior.risks_concerns,v_prior.recommendations,
   v_prior.evaluator_id,v_prior.reviewer_id,v_prior.approver_id,v_actor,v_actor) returning id into v_id;
 return v_id;
end $$;

create function ci_private.ci_save_unified_vendor_report(p_id uuid,p_data jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_row public.ci_unified_vendor_reports%rowtype; e jsonb;r jsonb;a jsonb;
begin
 v_actor:=ci_private.require_role(1::smallint,array['supervisor','admin']);
 perform ci_private.require_role(2::smallint,array['supervisor','admin']);
 select * into v_row from public.ci_unified_vendor_reports where id=p_id for update;
 if not found then raise exception 'CI_ANNUAL_REVISION_NOT_FOUND';end if;
 if v_row.status<>'draft' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE';end if;
 if p_data is null or jsonb_typeof(p_data)<>'object'
   or exists(select 1 from jsonb_object_keys(p_data) as key where key not in
   ('summary','strengths','risksConcerns','recommendations','evaluatorId','reviewerId','approverId'))
   then raise exception 'CI_ANNUAL_INPUT_INVALID';end if;
 if length(coalesce(p_data->>'summary',''))>4000 or length(coalesce(p_data->>'strengths',''))>4000
 or length(coalesce(p_data->>'risksConcerns',''))>4000 or length(coalesce(p_data->>'recommendations',''))>4000
 then raise exception 'CI_ANNUAL_INPUT_INVALID';end if;
 e:=case when nullif(p_data->>'evaluatorId','') is null then null else ci_private.signatory_snapshot((p_data->>'evaluatorId')::uuid) end;
 r:=case when nullif(p_data->>'reviewerId','') is null then null else ci_private.signatory_snapshot((p_data->>'reviewerId')::uuid) end;
 a:=case when nullif(p_data->>'approverId','') is null then null else ci_private.signatory_snapshot((p_data->>'approverId')::uuid) end;
 update public.ci_unified_vendor_reports set
   judgment_summary=nullif(btrim(coalesce(p_data->>'summary','')),''),
   strengths=nullif(btrim(coalesce(p_data->>'strengths','')),''),
   risks_concerns=nullif(btrim(coalesce(p_data->>'risksConcerns','')),''),
   recommendations=nullif(btrim(coalesce(p_data->>'recommendations','')),''),
   evaluator_id=(e->>'id')::uuid,evaluator_name_snapshot=e->>'name',evaluator_position_snapshot=e->>'position',
   reviewer_id=(r->>'id')::uuid,reviewer_name_snapshot=r->>'name',reviewer_position_snapshot=r->>'position',
   approver_id=(a->>'id')::uuid,approver_name_snapshot=a->>'name',approver_position_snapshot=a->>'position',
   updated_at=now(),updated_by=v_actor where id=p_id;
end $$;

create function ci_private.ci_refresh_unified_vendor_report(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_row public.ci_unified_vendor_reports%rowtype; v_evidence jsonb;
begin
 v_actor:=ci_private.require_role(1::smallint,array['supervisor','admin']);
 perform ci_private.require_role(2::smallint,array['supervisor','admin']);
 select * into v_row from public.ci_unified_vendor_reports where id=p_id for update;
 if not found then raise exception 'CI_ANNUAL_REVISION_NOT_FOUND';end if;
 if v_row.status<>'draft' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE';end if;
 v_evidence:=ci_private.ci_unified_vendor_evidence(v_row.vendor_id,v_row.fiscal_year);
 update public.ci_unified_vendor_reports set evidence_snapshot=v_evidence,
  evidence_hash=ci_private.evidence_hash(v_evidence),
  policy_id=coalesce(ci_private.policy_for_fiscal_year(v_row.fiscal_year),policy_id),
  updated_at=now(),updated_by=v_actor where id=p_id;
end $$;

create function ci_private.ci_finalize_unified_vendor_report(p_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare
 v_row public.ci_unified_vendor_reports%rowtype;
 v_policy public.ci_vendor_evaluation_policies%rowtype;
 v_actor uuid; v_live jsonb; v_coverage numeric;
 v_e jsonb;v_r jsonb;v_a jsonb;
 sig_e text;sig_r text;sig_a text;
 v_weight numeric;v_score numeric;v_criteria jsonb;
 v_seq int;v_number text;
begin
 v_actor:=ci_private.require_role(1::smallint,array['supervisor','admin']);
 perform ci_private.require_role(2::smallint,array['supervisor','admin']);
 select * into v_row from public.ci_unified_vendor_reports where id=p_id for update;
 if not found then raise exception 'CI_ANNUAL_REVISION_NOT_FOUND';end if;
 if v_row.status<>'draft' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE';end if;
 select * into v_policy from public.ci_vendor_evaluation_policies where id=v_row.policy_id for share;
 if v_policy.status <> 'approved' then raise exception 'CI_POLICY_NOT_APPROVED';end if;
 v_live:=ci_private.ci_unified_vendor_evidence(v_row.vendor_id,v_row.fiscal_year);
 if ci_private.evidence_hash(v_live)<>v_row.evidence_hash then raise exception 'CI_ANNUAL_EVIDENCE_STALE' using errcode='40001';end if;
 v_coverage:=(v_live#>>'{coverage,percentage}')::numeric;
 if v_coverage is not null and v_coverage<v_policy.minimum_coverage_percent then raise exception 'CI_ANNUAL_COVERAGE_LOW';end if;
 if nullif(btrim(coalesce(v_row.judgment_summary,'')),'') is null
 or nullif(btrim(coalesce(v_row.strengths,'')),'') is null
 or nullif(btrim(coalesce(v_row.risks_concerns,'')),'') is null
 or nullif(btrim(coalesce(v_row.recommendations,'')),'') is null then raise exception 'CI_ANNUAL_TEXT_REQUIRED';end if;
 if v_row.evaluator_id is null or v_row.reviewer_id is null or v_row.approver_id is null
 then raise exception 'CI_ANNUAL_SIGNERS_REQUIRED';end if;
 v_e:=ci_private.signatory_snapshot(v_row.evaluator_id);
 v_r:=ci_private.signatory_snapshot(v_row.reviewer_id);
 v_a:=ci_private.signatory_snapshot(v_row.approver_id);
 select signature_png into sig_e from public.ci_user_signatures where user_id=v_row.evaluator_id;
 select signature_png into sig_r from public.ci_user_signatures where user_id=v_row.reviewer_id;
 select signature_png into sig_a from public.ci_user_signatures where user_id=v_row.approver_id;
 if sig_e not like 'data:image/png;base64,%' or sig_r not like 'data:image/png;base64,%'
 or sig_a not like 'data:image/png;base64,%' or sig_e is null or sig_r is null or sig_a is null
 then raise exception 'CI_ANNUAL_SIGNATURE_MISSING';end if;

 select sum(c.weight) into v_weight from public.ci_vendor_evaluation_policy_criteria c
 join jsonb_array_elements(v_live->'criteria') s on s->>'criterionCode'=c.criterion_code
 where c.policy_id=v_policy.id and (s->>'denominator')::integer>0;
 if v_weight is null or v_weight<=0 then raise exception 'CI_ANNUAL_NO_APPLICABLE_CRITERIA';end if;
 select jsonb_agg(jsonb_build_object(
  'criterionCode',c.criterion_code,'label',c.label,'displayOrder',c.display_order,
  'numerator',(s->>'numerator')::integer,'denominator',(s->>'denominator')::integer,
  'applicable',(s->>'denominator')::integer>0,'percentage',s->'percentage','weight',c.weight,
  'effectiveWeight',case when (s->>'denominator')::integer>0 then round(c.weight*100/v_weight,2) end,
  'weightedScore',case when (s->>'denominator')::integer>0 then round((s->>'numerator')::numeric/(s->>'denominator')::numeric*c.weight/v_weight*100,2) end,
  'supplementaryCount',s->'supplementaryCount',
  'evidenceDefinition',c.evidence_definition,'calculationDefinition',c.calculation_definition,'naDefinition',c.na_definition)
   order by c.display_order),
  round(sum(case when (s->>'denominator')::integer>0 then (s->>'numerator')::numeric/(s->>'denominator')::numeric*c.weight/v_weight*100 else 0 end),2)
  into v_criteria,v_score
  from public.ci_vendor_evaluation_policy_criteria c
  join jsonb_array_elements(v_live->'criteria') s on s->>'criterionCode'=c.criterion_code
  where c.policy_id=v_policy.id;
 perform pg_advisory_xact_lock(86423,v_row.fiscal_year);
 select coalesce(max((regexp_match(report_number,'^VEC-[0-9]+-([0-9]+)$'))[1]::integer),0)+1 into v_seq
 from public.ci_unified_vendor_reports where fiscal_year=v_row.fiscal_year and status='final';
 v_number:='VEC-'||v_row.fiscal_year||'-'||lpad(v_seq::text,4,'0');
 update public.ci_unified_vendor_reports set status='final',frozen_snapshot=jsonb_build_object(
  'evidence',v_live,'criteria',v_criteria,'score',v_score,
  'result',case when v_score>=v_policy.pass_threshold then 'pass' else 'fail' end,
  'policy',jsonb_build_object('id',v_policy.id,'version',v_policy.version,
    'passThreshold',v_policy.pass_threshold,'minimumCoveragePercent',v_policy.minimum_coverage_percent,
    'approvedAt',v_policy.approved_at,'approvedByName',v_policy.approved_by_name_snapshot),
  'judgment',jsonb_build_object('summary',v_row.judgment_summary,'strengths',v_row.strengths,
    'risksConcerns',v_row.risks_concerns,'recommendations',v_row.recommendations),
  'signatories',jsonb_build_object('evaluator',v_e,'reviewer',v_r,'approver',v_a),
  'reportNumber',v_number,'revision',v_row.revision_number,'finalizedAt',now()),
  evidence_snapshot=v_live,
  report_number=v_number,finalized_at=now(),
  evaluator_name_snapshot=v_e->>'name',evaluator_position_snapshot=v_e->>'position',evaluator_signature=sig_e,
  reviewer_name_snapshot=v_r->>'name',reviewer_position_snapshot=v_r->>'position',reviewer_signature=sig_r,
  approver_name_snapshot=v_a->>'name',approver_position_snapshot=v_a->>'position',approver_signature=sig_a,
  updated_at=now(),updated_by=v_actor where id=p_id;
 return v_number;
end $$;

-- Protect official reports even against accidental future internal updates.
create function ci_private.ci_unified_vendor_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status='final' then raise exception 'CI_ANNUAL_REVISION_IMMUTABLE';end if;
 return new;
end $$;
create trigger ci_unified_vendor_immutable before update or delete on public.ci_unified_vendor_reports
 for each row execute function ci_private.ci_unified_vendor_immutable();

create function public.ci_create_unified_vendor_report(p_vendor uuid,p_fy integer)
returns uuid language sql security invoker set search_path='' as $$
select ci_private.ci_create_unified_vendor_report($1,$2) $$;
create function public.ci_save_unified_vendor_report(p_id uuid,p_data jsonb)
returns void language sql security invoker set search_path='' as $$
select ci_private.ci_save_unified_vendor_report($1,$2) $$;
create function public.ci_refresh_unified_vendor_report(p_id uuid)
returns void language sql security invoker set search_path='' as $$
select ci_private.ci_refresh_unified_vendor_report($1) $$;
create function public.ci_finalize_unified_vendor_report(p_id uuid)
returns text language sql security invoker set search_path='' as $$
select ci_private.ci_finalize_unified_vendor_report($1) $$;
revoke all on function public.ci_create_unified_vendor_report(uuid,integer),
 public.ci_save_unified_vendor_report(uuid,jsonb),public.ci_refresh_unified_vendor_report(uuid),
 public.ci_finalize_unified_vendor_report(uuid) from public,anon;
grant execute on function public.ci_create_unified_vendor_report(uuid,integer),
 public.ci_save_unified_vendor_report(uuid,jsonb),public.ci_refresh_unified_vendor_report(uuid),
 public.ci_finalize_unified_vendor_report(uuid) to authenticated;
