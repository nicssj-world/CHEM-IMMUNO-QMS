import assert from 'node:assert/strict';
import test from 'node:test';
import { photoScanRegions } from '../../src/lib/photo-scan-regions';

const contains = (r: {x:number;y:number;side:number}, b: {x:number;y:number;width:number;height:number}) =>
  r.x <= b.x && r.y <= b.y && r.x + r.side >= b.x + b.width && r.y + r.side >= b.y + b.height;

test('off-center Roche-style Data Matrix region is covered by a focused crop', () => {
  // Geometry of a small symbol to the right of the center of a 1536px label photo.
  const r = photoScanRegions(1536, 1536);
  const symbol = {x:875,y:753,width:291,height:279};
  assert.ok(r.some(region => region.side <= 768 && contains(region, symbol)),
    'a half-size tile contains the entire right-of-center symbol, not just a center crop');
});

test('photo crop search handles all corners, portrait photos and tiny images safely', () => {
  for (const [w,h] of [[1536,1536],[1200,1800],[1800,1200],[1,1]]) {
    const r = photoScanRegions(w,h);
    assert.ok(r.length >= 1 && r.length <= 10);
    for (const region of r) {
      assert.ok(region.side >= 1 && region.side <= Math.min(w,h));
      assert.ok(region.x >= 0 && region.y >= 0);
      assert.ok(region.x + region.side <= w && region.y + region.side <= h);
    }
  }
  assert.deepEqual(photoScanRegions(0, 800), []);
  assert.deepEqual(photoScanRegions(NaN, 800), []);
});

test('region search spans more than the middle of the photograph', () => {
  const regions = photoScanRegions(1536,1536);
  assert.ok(regions.some(r => contains(r, {x:40,y:40,width:150,height:150})));
  assert.ok(regions.some(r => contains(r, {x:1320,y:1290,width:150,height:150})));
});
