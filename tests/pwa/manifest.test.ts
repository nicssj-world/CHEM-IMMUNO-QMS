import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import manifest from '@/app/manifest';

test('PWA manifest is standalone with installable icon sizes',async()=>{
  const m=manifest();
  assert.equal(m.name,'CHEM-IMMUNO CBH');
  assert.equal(m.short_name,'CHEM-IMMUNO');
  assert.equal(m.display,'standalone');
  assert.equal(m.start_url,'/');
  assert.equal(m.theme_color,'#0d3857');
  for(const [file,size] of [['icon-192.png',192],['icon-512.png',512],['icon-maskable-512.png',512],['apple-touch-icon.png',180]]){
    const bytes=await readFile(`public/${file}`);
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(bytes.readUInt32BE(16),size);
    assert.equal(bytes.readUInt32BE(20),size);
  }
  assert.deepEqual(m.icons?.map(({src,sizes,type,purpose})=>({src,sizes,type,purpose})),[
    {src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
    {src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},
    {src:'/icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'},
  ]);
  assert.notDeepEqual(await readFile('public/icon-512.png'),await readFile('public/icon-maskable-512.png'));

  const ico=await readFile('public/favicon.ico');
  assert.equal(ico.readUInt16LE(0),0);
  assert.equal(ico.readUInt16LE(2),1);
  const imageCount=ico.readUInt16LE(4);
  assert.equal(imageCount,3);
  const faviconSizes=[];
  for(let i=0;i<imageCount;i++){
    const entry=6+i*16;
    const size=ico.readUInt8(entry)||256;
    const payloadSize=ico.readUInt32LE(entry+8);
    const payloadOffset=ico.readUInt32LE(entry+12);
    const png=ico.subarray(payloadOffset,payloadOffset+payloadSize);
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),size);
    assert.equal(png.readUInt32BE(20),size);
    faviconSizes.push(size);
  }
  assert.deepEqual(faviconSizes,[16,32,48]);
});
