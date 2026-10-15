import assert from 'node:assert/strict';
import test from 'node:test';
import { searchReagents } from '../../src/lib/reagent-search';

const reagents = [
  {id: '1', product_code: 'CHE-0002', display_name: 'Glucose Reagent'},
  {id: '2', product_code: 'IMM-0021', display_name: 'TSH (Thyroid Stimulating Hormone)'},
  {id: '3', product_code: 'IMM-0142', display_name: 'Anti-HBs น้ำยาตรวจภูมิคุ้มกัน'},
  {id: '4', product_code: 'CHE-0042', display_name: 'สารควบคุมคุณภาพ'},
];

test('find by only 1–2 code digits, without needing full product code', () => {
  assert.deepEqual(searchReagents(reagents, '21').map(x=>x.id), ['2']);
  assert.deepEqual(searchReagents(reagents, '02').map(x=>x.id), ['1', '2']);
});

test('find case-insensitively by reagent name fragment and Thai text', () => {
  assert.deepEqual(searchReagents(reagents, 'tsh').map(x=>x.id), ['2']);
  assert.deepEqual(searchReagents(reagents, 'ภูมิคุ้ม').map(x=>x.id), ['3']);
  assert.deepEqual(searchReagents(reagents, 'control').map(x=>x.id), []);
});

test('support separators omitted from product codes and multi-term search', () => {
  assert.deepEqual(searchReagents(reagents, 'IMM0021').map(x=>x.id), ['2']);
  assert.deepEqual(searchReagents(reagents, 'imm 142').map(x=>x.id), ['3']);
});

test('empty search does not flood users with all results', () => {
  assert.deepEqual(searchReagents(reagents, ' '), []);
  assert.deepEqual(searchReagents(reagents, 'nothing'), []);
});

test('matching product codes are ranked before substring-only name matches', () => {
  const rows = [
    {id:'a',product_code:'CHE-0010',display_name:'IMM test'},
    {id:'b',product_code:'IMM-0010',display_name:'test'},
  ];
  assert.deepEqual(searchReagents(rows,'imm').map(x=>x.id), ['b','a']);
});
