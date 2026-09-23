import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import manifest from '@/app/manifest';

test('PWA manifest is standalone with installable icon sizes',async()=>{
  const m=manifest();
  assert.equal(m.display,'standalone');
  assert.equal(m.start_url,'/');
  assert.equal(m.theme_color,'#0d3857');
  for(const [file,size] of [['icon-192.png',192],['icon-512.png',512],['icon-maskable-512.png',512],['apple-touch-icon.png',180]]){
    const bytes=await readFile(`public/${file}`);
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(bytes.readUInt32BE(16),size);
    assert.equal(bytes.readUInt32BE(20),size);
  }
  assert.ok(m.icons?.some(icon=>icon.purpose==='maskable'));
});
