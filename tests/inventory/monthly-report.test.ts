import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileMonthlyRows, reportMonth, type MonthlyRow } from '@/lib/monthly-report';

test('monthly report validates month and reconciles signed components',()=>{
  assert.equal(reportMonth(undefined,'2026-09-24'),'2026-09');
  assert.equal(reportMonth('2026-10','2026-09-24'),'2026-10');
  assert.throws(()=>reportMonth('2026-13','2026-09-24'),/INVALID/);
  const row:MonthlyRow={product_id:'p',product_code:'CHE-0001',display_name:'Synthetic',product_type:'reagent',opening:5,received:4,issued:2,adjustments:1,expired_disposal:1,reversals:2,closing:9};
  assert.deepEqual(reconcileMonthlyRows([row]).invalidProductCodes,[]);
  assert.deepEqual(reconcileMonthlyRows([{...row,closing:8}]).invalidProductCodes,['CHE-0001']);
});
