-- Vendor evaluation port from LABCBH-Stock, phase 3: versioned evaluation policy (8 weighted criteria).
-- As in LABCBH the seeded V1 policy is a proposal with NULL numbers: it cannot produce an official score until an admin records and approves the numbers.
set local search_path = '';

create table public.ci_vendor_evaluation_policies (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  effective_from_fiscal_year integer not null check (effective_from_fiscal_year between 2500 and 3000),
  effective_to_fiscal_year integer check (effective_to_fiscal_year between 2500 and 3000 and effective_to_fiscal_year >= effective_from_fiscal_year),
  pass_threshold numeric(5,2) check (pass_threshold between 0 and 100),
  minimum_coverage_percent numeric(5,2) check (minimum_coverage_percent between 0 and 100),
  coverage_start_date date not null,
  note text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_by_name_snapshot text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint ci_vendor_evaluation_policies_version_key unique (version),
  constraint ci_vendor_evaluation_policies_version_not_blank check (nullif(btrim(version), '') is not null),
  constraint ci_vendor_evaluation_policies_approval_check check (
    (status = 'approved' and pass_threshold is not null and minimum_coverage_percent is not null and approved_at is not null and approved_by is not null
      and nullif(btrim(coalesce(approved_by_name_snapshot, '')), '') is not null)
    or (status = 'proposed' and approved_at is null and approved_by is null and approved_by_name_snapshot is null)
    or (status = 'retired' and approved_at is not null and approved_by is not null and nullif(btrim(coalesce(approved_by_name_snapshot, '')), '') is not null)
  )
);
create index ci_vendor_evaluation_policies_effective_idx on public.ci_vendor_evaluation_policies (status, effective_from_fiscal_year, effective_to_fiscal_year);

create table public.ci_vendor_evaluation_policy_criteria (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.ci_vendor_evaluation_policies(id),
  criterion_code text not null check (criterion_code in ('delivery_completeness','shelf_life','product_packaging','documentation','item_correctness','cold_chain','complaint_performance','corrective_action')),
  display_order integer not null check (display_order between 1 and 8),
  label text not null check (nullif(btrim(label), '') is not null),
  weight numeric(5,2) check (weight > 0 and weight <= 100),
  evidence_definition text not null check (nullif(btrim(evidence_definition), '') is not null),
  calculation_definition text not null check (nullif(btrim(calculation_definition), '') is not null),
  na_definition text not null check (nullif(btrim(na_definition), '') is not null),
  constraint ci_vendor_evaluation_policy_criteria_code_key unique (policy_id, criterion_code),
  constraint ci_vendor_evaluation_policy_criteria_order_key unique (policy_id, display_order)
);

-- Any signed-in user with an active warehouse assignment may read policies; writes go through the RPCs below.
create function ci_private.has_any_access() returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id = p.user_id where p.user_id = auth.uid() and p.active and a.active)
$$;
revoke all on function ci_private.has_any_access() from public, anon;
grant execute on function ci_private.has_any_access() to authenticated;

alter table public.ci_vendor_evaluation_policies enable row level security;
alter table public.ci_vendor_evaluation_policy_criteria enable row level security;
create policy ci_vendor_eval_policies_read on public.ci_vendor_evaluation_policies for select to authenticated using (ci_private.has_any_access());
create policy ci_vendor_eval_policy_criteria_read on public.ci_vendor_evaluation_policy_criteria for select to authenticated using (ci_private.has_any_access());
grant select on public.ci_vendor_evaluation_policies, public.ci_vendor_evaluation_policy_criteria to authenticated;

-- Approved or retired policies, and their criteria, are frozen.
create function ci_private.guard_vendor_evaluation_policy() returns trigger language plpgsql set search_path = '' as $$
begin
  -- The one change an approved policy allows: its last fiscal year moves earlier when a newer policy takes over (see approval below).
  if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'approved' and new.effective_to_fiscal_year is not null
     and (old.effective_to_fiscal_year is null or new.effective_to_fiscal_year < old.effective_to_fiscal_year)
     and (to_jsonb(new) - 'effective_to_fiscal_year' - 'updated_at' - 'updated_by') = (to_jsonb(old) - 'effective_to_fiscal_year' - 'updated_at' - 'updated_by') then
    return new;
  end if;
  if old.status <> 'proposed' then raise exception 'CI_POLICY_FROZEN' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger ci_vendor_evaluation_policies_guard before update or delete on public.ci_vendor_evaluation_policies for each row execute function ci_private.guard_vendor_evaluation_policy();

create function ci_private.guard_vendor_evaluation_policy_criterion() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.ci_vendor_evaluation_policies p where p.id = coalesce(new.policy_id, old.policy_id) and p.status = 'proposed') then
    raise exception 'CI_POLICY_FROZEN' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger ci_vendor_evaluation_policy_criteria_guard before insert or update or delete on public.ci_vendor_evaluation_policy_criteria for each row execute function ci_private.guard_vendor_evaluation_policy_criterion();

-- Canonical definitions (LABCBH wording; purchase-order terms become Invoice terms).
with seeded as (
  insert into public.ci_vendor_evaluation_policies (version, status, effective_from_fiscal_year, coverage_start_date, note)
  select 'VE-POLICY-V1', 'proposed', ci_private.fiscal_year_be(assessment_required_from), assessment_required_from,
         'ข้อเสนอ (รออนุมัติ): ยังไม่ได้กำหนดน้ำหนัก เกณฑ์ผ่าน หรือความครอบคลุมขั้นต่ำ'
  from public.ci_vendor_evaluation_settings where singleton
  returning id
)
insert into public.ci_vendor_evaluation_policy_criteria (policy_id, criterion_code, display_order, label, weight, evidence_definition, calculation_definition, na_definition)
select seeded.id, c.code, c.display_order, c.label, null, c.evidence_definition, c.calculation_definition, c.na_definition
from seeded cross join (values
  ('delivery_completeness', 1, 'การส่งมอบ / ความครบถ้วน',
    'รายการใน Invoice ที่ถึงสถานะสิ้นสุด (รับครบ หรือปิดแบบรับไม่ครบ) ในปีงบประมาณ',
    'รายการที่รับครบเป็นตัวตั้ง รายการทั้งหมดของ Invoice ที่สิ้นสุดแล้วเป็นตัวหาร',
    'ไม่มี Invoice ที่ถึงสถานะสิ้นสุดในปีงบประมาณ'),
  ('shelf_life', 2, 'อายุสินค้า ณ วันที่รับ',
    'รายการรับเข้าคลังที่มีวันหมดอายุ',
    'รายการที่ไม่หมดอายุ ณ วันที่รับเป็นตัวตั้ง รายการที่มีวันหมดอายุเป็นตัวหาร',
    'ไม่มีหลักฐานวันหมดอายุของรายการรับเข้า'),
  ('product_packaging', 3, 'สภาพสินค้า / บรรจุภัณฑ์',
    'ผลตรวจรับที่บันทึกแล้ว',
    'ผลปกติเป็นตัวตั้ง ผลตรวจรับที่บันทึกแล้วเป็นตัวหาร',
    'ไม่มีผลตรวจรับที่บันทึกแล้ว'),
  ('documentation', 4, 'เอกสารประกอบ',
    'ผลตรวจรับที่บันทึกแล้ว',
    'เอกสารครบเป็นตัวตั้ง ผลตรวจรับที่บันทึกแล้วเป็นตัวหาร',
    'ไม่มีผลตรวจรับที่บันทึกแล้ว'),
  ('item_correctness', 5, 'ความถูกต้องของรายการ',
    'ผลตรวจรับที่บันทึกแล้ว',
    'รายการถูกต้องเป็นตัวตั้ง ผลตรวจรับที่บันทึกแล้วเป็นตัวหาร',
    'ไม่มีผลตรวจรับที่บันทึกแล้ว'),
  ('cold_chain', 6, 'การควบคุมอุณหภูมิ',
    'ผลตรวจรับของสินค้าที่ต้องควบคุมอุณหภูมิ',
    'สภาพอุณหภูมิเหมาะสมเป็นตัวตั้ง ผลตรวจรับที่ต้องควบคุมอุณหภูมิเป็นตัวหาร',
    'ผู้ขายไม่มีสินค้าที่ต้องควบคุมอุณหภูมิ'),
  ('complaint_performance', 7, 'ข้อร้องเรียน / ปัญหา',
    'ผลตรวจรับที่บันทึกแล้ว และจำนวนข้อร้องเรียนที่บันทึกด้วยมือแยกต่างหาก',
    'ผลตรวจรับที่ไม่มีข้อร้องเรียนเป็นตัวตั้ง ผลตรวจรับที่บันทึกแล้วเป็นตัวหาร',
    'ไม่มีผลตรวจรับที่บันทึกแล้ว'),
  ('corrective_action', 8, 'การแก้ไขปัญหา',
    'ปัญหาทุกประเภทและทุกแหล่งที่มา ยกเว้นรายการที่ถูกยกเลิก',
    'ปัญหาที่แก้ไขแล้วเป็นตัวตั้ง ปัญหาที่ไม่ถูกยกเลิกทั้งหมดเป็นตัวหาร',
    'ผู้ขายไม่มีปัญหาที่ไม่ถูกยกเลิก')
) as c(code, display_order, label, evidence_definition, calculation_definition, na_definition);

-- The policy is one QP for the whole work group, so only an admin of both warehouses may change it.
create function ci_private.require_policy_admin() returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_wh smallint;
begin
  for v_wh in select id from public.ci_warehouses loop
    perform ci_private.require_role(v_wh, array['admin']);
  end loop;
  return v_actor;
end $$;
revoke all on function ci_private.require_policy_admin() from public, anon, authenticated;

create function ci_private.ci_save_vendor_evaluation_policy_proposal(p_policy_id uuid, p_policy jsonb, p_criteria jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := ci_private.require_policy_admin();
  v_row public.ci_vendor_evaluation_policies%rowtype;
  v_template uuid;
  v_item jsonb;
begin
  if p_policy is null or jsonb_typeof(p_policy) <> 'object' or p_criteria is null or jsonb_typeof(p_criteria) <> 'array' then raise exception 'CI_POLICY_INPUT_INVALID'; end if;
  if exists (select 1 from jsonb_object_keys(p_policy) k where k not in ('version','effectiveFromFiscalYear','effectiveToFiscalYear','passThreshold','minimumCoveragePercent','coverageStartDate','note')) then raise exception 'CI_POLICY_INPUT_INVALID'; end if;
  if jsonb_array_length(p_criteria) <> 8 then raise exception 'CI_POLICY_CRITERIA_INCOMPLETE'; end if;
  if exists (select 1 from jsonb_array_elements(p_criteria) i where exists (select 1 from jsonb_object_keys(i) k where k not in ('criterionCode','weight'))) then raise exception 'CI_POLICY_INPUT_INVALID'; end if;
  if (select count(distinct i ->> 'criterionCode') from jsonb_array_elements(p_criteria) i) <> 8 then raise exception 'CI_POLICY_CRITERIA_INCOMPLETE'; end if;
  if (select sum((i ->> 'weight')::numeric) from jsonb_array_elements(p_criteria) i) is distinct from 100::numeric then raise exception 'CI_POLICY_WEIGHT_TOTAL'; end if;

  if p_policy_id is null then
    -- Definitions come from the first policy ever created (the seed), whatever it has since been renamed to.
    select id into v_template from public.ci_vendor_evaluation_policies order by created_at, id limit 1;
    insert into public.ci_vendor_evaluation_policies (version, status, effective_from_fiscal_year, effective_to_fiscal_year, pass_threshold, minimum_coverage_percent, coverage_start_date, note, created_by, updated_by)
    values (nullif(btrim(p_policy ->> 'version'), ''), 'proposed', (p_policy ->> 'effectiveFromFiscalYear')::integer, nullif(p_policy ->> 'effectiveToFiscalYear', '')::integer,
            (p_policy ->> 'passThreshold')::numeric, (p_policy ->> 'minimumCoveragePercent')::numeric, (p_policy ->> 'coverageStartDate')::date,
            nullif(btrim(coalesce(p_policy ->> 'note', '')), ''), v_actor, v_actor) returning * into v_row;
    insert into public.ci_vendor_evaluation_policy_criteria (policy_id, criterion_code, display_order, label, weight, evidence_definition, calculation_definition, na_definition)
    select v_row.id, base.criterion_code, base.display_order, base.label, (i ->> 'weight')::numeric, base.evidence_definition, base.calculation_definition, base.na_definition
    from jsonb_array_elements(p_criteria) i join public.ci_vendor_evaluation_policy_criteria base on base.policy_id = v_template and base.criterion_code = i ->> 'criterionCode';
    if (select count(*) from public.ci_vendor_evaluation_policy_criteria where policy_id = v_row.id) <> 8 then raise exception 'CI_POLICY_CRITERIA_INCOMPLETE'; end if;
  else
    select * into v_row from public.ci_vendor_evaluation_policies where id = p_policy_id for update;
    if not found then raise exception 'CI_POLICY_NOT_FOUND'; end if;
    if v_row.status <> 'proposed' then raise exception 'CI_POLICY_FROZEN' using errcode = '55000'; end if;
    update public.ci_vendor_evaluation_policies set version = nullif(btrim(p_policy ->> 'version'), ''), effective_from_fiscal_year = (p_policy ->> 'effectiveFromFiscalYear')::integer,
      effective_to_fiscal_year = nullif(p_policy ->> 'effectiveToFiscalYear', '')::integer, pass_threshold = (p_policy ->> 'passThreshold')::numeric,
      minimum_coverage_percent = (p_policy ->> 'minimumCoveragePercent')::numeric, coverage_start_date = (p_policy ->> 'coverageStartDate')::date,
      note = nullif(btrim(coalesce(p_policy ->> 'note', '')), ''), updated_at = now(), updated_by = v_actor
    where id = p_policy_id returning * into v_row;
    for v_item in select value from jsonb_array_elements(p_criteria) loop
      update public.ci_vendor_evaluation_policy_criteria set weight = (v_item ->> 'weight')::numeric where policy_id = v_row.id and criterion_code = v_item ->> 'criterionCode';
      if not found then raise exception 'CI_POLICY_CRITERIA_INCOMPLETE'; end if;
    end loop;
  end if;
  perform ci_private.audit(null, 'POLICY_PROPOSAL_SAVED', 'ci_vendor_evaluation_policies', v_row.id::text, v_row.version);
  return v_row.id;
end $$;

create function ci_private.ci_approve_vendor_evaluation_policy(p_policy_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := ci_private.require_policy_admin();
  v_row public.ci_vendor_evaluation_policies%rowtype;
  v_name text;
begin
  select * into v_row from public.ci_vendor_evaluation_policies where id = p_policy_id for update;
  if not found then raise exception 'CI_POLICY_NOT_FOUND'; end if;
  if v_row.status <> 'proposed' then raise exception 'CI_POLICY_NOT_PROPOSED'; end if;
  if v_row.pass_threshold is null or v_row.minimum_coverage_percent is null
     or (select count(*) from public.ci_vendor_evaluation_policy_criteria c where c.policy_id = v_row.id and c.weight is not null) <> 8
     or (select sum(c.weight) from public.ci_vendor_evaluation_policy_criteria c where c.policy_id = v_row.id) is distinct from 100::numeric then
    raise exception 'CI_POLICY_INCOMPLETE';
  end if;
  -- A newer QP takes over from its first year: the approved policy it follows ends the year before. Reports already final keep the policy they were made under.
  update public.ci_vendor_evaluation_policies o set effective_to_fiscal_year = v_row.effective_from_fiscal_year - 1, updated_at = now(), updated_by = v_actor
   where o.id <> v_row.id and o.status = 'approved' and o.effective_from_fiscal_year < v_row.effective_from_fiscal_year
     and coalesce(o.effective_to_fiscal_year, 3000) >= v_row.effective_from_fiscal_year
     and (v_row.effective_to_fiscal_year is null or (o.effective_to_fiscal_year is not null and o.effective_to_fiscal_year <= v_row.effective_to_fiscal_year));
  if exists (select 1 from public.ci_vendor_evaluation_policies o where o.id <> v_row.id and o.status = 'approved'
             and o.effective_from_fiscal_year <= coalesce(v_row.effective_to_fiscal_year, 3000) and coalesce(o.effective_to_fiscal_year, 3000) >= v_row.effective_from_fiscal_year) then
    raise exception 'CI_POLICY_OVERLAP';
  end if;
  select display_name into v_name from public.ci_user_profiles where user_id = v_actor;
  update public.ci_vendor_evaluation_policies set status = 'approved', approved_at = now(), approved_by = v_actor, approved_by_name_snapshot = coalesce(v_name, 'ผู้ดูแลระบบ'), updated_at = now(), updated_by = v_actor where id = p_policy_id;
  perform ci_private.audit(null, 'POLICY_APPROVED', 'ci_vendor_evaluation_policies', p_policy_id::text, v_row.version);
end $$;

-- Vendor, policy and signature audit rows carry no warehouse; admins and supervisors of either warehouse can read them.
drop policy ci_audit_vendor_read on public.ci_audit_logs;
create policy ci_audit_vendor_read on public.ci_audit_logs for select to authenticated using (
  warehouse_id is null and entity_table in ('ci_vendors', 'ci_vendor_evaluation_policies', 'ci_user_signatures') and exists (
    select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id = p.user_id
    where p.user_id = auth.uid() and p.active and a.active and a.role in ('admin', 'supervisor')));

select ci_private.publish_rpc('ci_private.ci_save_vendor_evaluation_policy_proposal(uuid, jsonb, jsonb)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_approve_vendor_evaluation_policy(uuid)'::regprocedure);

notify pgrst, 'reload schema';
