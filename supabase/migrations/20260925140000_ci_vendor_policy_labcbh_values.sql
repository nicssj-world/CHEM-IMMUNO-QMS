-- The work group uses LABCBH-Stock's vendor evaluation policy as its QP, so V1 starts from the numbers LABCBH-Stock approved
-- (VE-POLICY-V1, approved 23 Sep 2569): pass 80%, minimum coverage 80%, from fiscal year 2569, data from 2026-09-23.
-- It stays a proposal: an admin of both warehouses still approves it, which records who approved and freezes it.
-- Only fills a V1 that is still an untouched proposal, so re-running or a policy someone already edited is left alone.
set local search_path = '';

with v1 as (
  update public.ci_vendor_evaluation_policies set
    pass_threshold = 80, minimum_coverage_percent = 80, coverage_start_date = date '2026-09-23',
    effective_from_fiscal_year = 2569, effective_to_fiscal_year = null,
    note = 'ตัวเลขตามนโยบายที่อนุมัติแล้วของ LABCBH-Stock (VE-POLICY-V1 อนุมัติ 23 ก.ย. 2569) · รอผู้ดูแลระบบของ CHEM-IMMUNO อนุมัติ',
    updated_at = now()
  where version = 'VE-POLICY-V1' and status = 'proposed' and pass_threshold is null and minimum_coverage_percent is null
  returning id
)
update public.ci_vendor_evaluation_policy_criteria c set weight = w.weight
from v1, (values ('delivery_completeness', 20), ('shelf_life', 15), ('product_packaging', 10), ('documentation', 10),
                 ('item_correctness', 15), ('cold_chain', 15), ('complaint_performance', 10), ('corrective_action', 5)) as w(code, weight)
where c.policy_id = v1.id and c.criterion_code = w.code and c.weight is null;

notify pgrst, 'reload schema';
