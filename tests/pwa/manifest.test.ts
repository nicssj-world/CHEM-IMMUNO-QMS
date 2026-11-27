import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import manifest from '@/app/manifest';

test('PWA manifest is standalone with installable icon sizes',async()=>{
  const m=manifest();
  assert.equal(m.name,'CHEM-IMMUNO CBH');
  assert.equal(m.short_name,'CHEM-IMMUNO CBH');
  assert.equal(m.display,'standalone');
  assert.equal(m.start_url,'/');
  assert.equal(m.theme_color,'#0d3857');
  for(const [file,size] of [['favicon-64.png',64],['icon-192.png',192],['icon-512.png',512],['icon-maskable-512.png',512],['apple-touch-icon.png',180]]){
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
  // The owner-supplied transparent artwork is kept byte for byte; every icon is generated from it by scripts/branding.
  const source=await readFile('assets/branding/chem-immuno-cbh-transparent-source.png');
  assert.equal(createHash('sha256').update(source).digest('hex').toUpperCase(),'4C48AA8DAE260AA34244FB153DA0137048B26350F86644998C5D5AEBE786B025');

  const ico=await readFile('public/favicon.ico');
  assert.equal(ico.readUInt16LE(0),0);
  assert.equal(ico.readUInt16LE(2),1);
  const imageCount=ico.readUInt16LE(4);
  assert.equal(imageCount,4);
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
  assert.deepEqual(faviconSizes,[16,32,48,64]);
});

async function pixels(input: string | Buffer) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  return { info, at, hasAlpha: (await sharp(input).metadata()).hasAlpha };
}

test('browser and install icons are transparent outside the rounded square, with an opaque icon body', async () => {
  const files: (string | Buffer)[] = ['assets/branding/chem-immuno-cbh-transparent-master.png', 'public/favicon-64.png', 'public/icon-192.png', 'public/icon-512.png'];
  const ico = await readFile('public/favicon.ico');
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16;
    files.push(ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8)));
  }
  for (const file of files) {
    const { info, at, hasAlpha } = await pixels(file);
    const name = typeof file === 'string' ? file : `favicon.ico ${info.width}px`;
    assert.equal(hasAlpha, true, `${name} has an alpha channel`);
    const last = info.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) assert.equal(at(x, y)[3], 0, `${name} corner (${x},${y}) is transparent`);
    assert.equal(at(info.width >> 1, info.height >> 1)[3], 255, `${name} centre is opaque`);
    // No white/light square survives around the icon: nothing visible on the outermost row or column is light. (At 16–32 px the
    // sub-pixel margin lets the icon's own blue edge touch the border, which is correct anti-aliasing.)
    for (let k = 0; k <= last; k++) for (const [x, y] of [[k, 0], [k, last], [0, k], [last, k]]) {
      const [r, g, b, a] = at(x, y);
      assert.ok(a === 0 || Math.min(r, g, b) < 200, `${name} edge (${x},${y}) is not light/white: ${[r, g, b, a]}`);
    }
  }
});

test('maskable and Apple icons are full-bleed and opaque, backed by the icon gradient rather than white', async () => {
  for (const file of ['public/icon-maskable-512.png', 'public/apple-touch-icon.png']) {
    const { info, at } = await pixels(file);
    const last = info.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      const [r, g, b, a] = at(x, y);
      assert.equal(a, 255, `${file} corner is opaque (these platforms do not honour transparency)`);
      assert.ok(Math.min(r, g, b) < 200, `${file} corner is not white: ${[r, g, b]}`);
    }
  }
});
