import assert from 'node:assert/strict';
import test from 'node:test';
import { clearReceiveDraft, readReceiveDraft, saveReceiveDraft } from '../../src/lib/receive-draft';

test('scanned invoice handoff remains available until receipt succeeds', () => {
  const storage = new Map<string,string>();
  const old = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem: (k:string,v:string) => storage.set(k,v), getItem:(k:string) => storage.get(k) ?? null,
    removeItem:(k:string) => storage.delete(k),
  }});
  try {
    const lines = [{productId:'p1',quantity:'2',lot:'LOT-1',expiry:'2027-12-31'}];
    saveReceiveDraft('invoice-a',lines);
    assert.deepEqual(readReceiveDraft('invoice-a'),lines);
    assert.deepEqual(readReceiveDraft('invoice-a'),lines,'refresh / re-mount keeps the draft');
    assert.deepEqual(readReceiveDraft('invoice-b'),[],'separate invoices are isolated');
    clearReceiveDraft('invoice-a');
    assert.deepEqual(readReceiveDraft('invoice-a'),[],'successful receipt clears the draft');
  } finally {
    if (old === undefined) Reflect.deleteProperty(globalThis,'sessionStorage');
    else Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:old});
  }
});
