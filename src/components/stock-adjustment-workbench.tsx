'use client';

import { useMemo, useRef, useState } from 'react';
import { adjustStock, getAdjustmentLotOptions } from '@/app/actions/inventory';
import { resolveAdjustmentProductScan } from '@/app/actions/scanner';
import { userMessage } from '@/lib/messages';
import { BarcodeScanner, type ScanFeedback } from './barcode-scanner';
import { ConfirmForm } from './confirm-form';
import { SubmitButton } from './submit-button';
import type { LocationOption, StockOption } from './stock-operation-form';
import type { PickerProduct } from './product-picker';

function lotRows(options: StockOption[], lotNumber: string, expiry: string) {
  return options.filter(option => option.lot_number === lotNumber && option.expiry_date === expiry);
}

export function StockAdjustmentWorkbench({
  warehouseId,
  warehouseCode,
  products,
  locations,
  initialOptions,
  initialProductId = '',
  submissionKey,
}: {
  warehouseId: number;
  warehouseCode: string;
  products: PickerProduct[];
  locations: LocationOption[];
  initialOptions: StockOption[];
  initialProductId?: string;
  submissionKey: string;
}) {
  const initial = initialOptions.length === 1 ? initialOptions[0] : undefined;
  const [productId, setProductId] = useState(initialProductId);
  const [options, setOptions] = useState(initialOptions);
  const [lotId, setLotId] = useState(initial?.lot_id ?? '');
  const [lotNumber, setLotNumber] = useState(initial?.lot_number ?? '');
  const [expiry, setExpiry] = useState(initial?.expiry_date ?? '');
  const [locationId, setLocationId] = useState(initial?.location_id ?? '');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [raw, setRaw] = useState('');
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const feedbackId = useRef(0);
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const locationById = useMemo(() => new Map(locations.map(location => [location.id, location])), [locations]);
  const product = productById.get(productId);
  const sameNumberOptions = lotNumber ? options.filter(option => option.lot_number === lotNumber) : [];
  const expiryConflict = Boolean(sameNumberOptions.length && expiry && !sameNumberOptions.some(option => option.expiry_date === expiry));
  const matchingLotRows = lotRows(options, lotNumber, expiry);
  const lotExists = matchingLotRows.length > 0;
  const selectedBalance = matchingLotRows.find(option => option.location_id === locationId)?.balance ?? 0;
  const totalLotBalance = matchingLotRows.reduce((sum, option) => sum + option.balance, 0);
  const delta = (Number(amount) || 0) * direction;
  const after = Math.round((selectedBalance + delta) * 1000) / 1000;
  const selectedLocation = locationById.get(locationId);
  const selectedSummary = product
    ? `${product.product_code} · ${product.display_name} · LOT ${lotNumber || 'ยังไม่ระบุ'} · หมดอายุ ${expiry || 'ยังไม่ระบุ'}`
    : 'สแกน Barcode หรือเลือกน้ำยาเอง';
  const canSubmit = Boolean(product && lotNumber.trim() && expiry && locationId && amount && Number(amount) > 0 && reason.trim() && !expiryConflict && locations.length && (lotId || direction > 0) && (direction > 0 || after >= 0));

  function tell(tone: ScanFeedback['tone'], title: string, detail?: string) {
    setFeedback({ id: ++feedbackId.current, tone, title, detail });
  }

  function clearLotSelection() {
    setLotId('');
    setLocationId('');
    setDirection(1);
  }

  function optionsForProduct(rows: Awaited<ReturnType<typeof getAdjustmentLotOptions>>, selectedProductId: string): StockOption[] {
    const selectedProduct = productById.get(selectedProductId);
    return rows.map(row => ({
      ...row,
      location_code: locationById.get(row.location_id)?.code ?? '—',
      product_code: selectedProduct?.product_code ?? '—',
      product_name: selectedProduct?.display_name ?? '',
    }));
  }

  function chooseExistingLot(nextOptions: StockOption[], nextLotNumber: string, nextExpiry: string) {
    const sameLot = nextOptions.filter(option => option.lot_number === nextLotNumber);
    if (!sameLot.length) { clearLotSelection(); return; }
    const savedExpiry = nextExpiry || sameLot[0].expiry_date;
    if (!nextExpiry) setExpiry(savedExpiry);
    const matching = sameLot.filter(option => option.expiry_date === savedExpiry);
    if (!matching.length) { clearLotSelection(); return; }
    setLotId(matching[0].lot_id);
    const locationIds = [...new Set(matching.map(option => option.location_id))];
    setLocationId(locationIds.length === 1 ? locationIds[0] : '');
  }

  async function loadProductOptions(nextProductId: string, preserveScannedLot: boolean) {
    setProductId(nextProductId);
    setOptions([]);
    clearLotSelection();
    setFormError('');
    setAmount('');
    setReason('');
    const keepLot = preserveScannedLot ? lotNumber : '';
    const keepExpiry = preserveScannedLot ? expiry : '';
    if (!preserveScannedLot) { setLotNumber(''); setExpiry(''); setRaw(''); }
    if (!nextProductId) return;
    setBusy(true);
    try {
      const loaded = optionsForProduct(await getAdjustmentLotOptions(warehouseId, nextProductId), nextProductId);
      setOptions(loaded);
      if (keepLot) chooseExistingLot(loaded, keepLot, keepExpiry);
    } catch (cause) {
      setFormError(userMessage(cause instanceof Error ? cause.message : null, 'โหลด LOT ไม่สำเร็จ'));
    } finally { setBusy(false); }
  }

  async function onScan(value: string, symbology: string) {
    setFormError('');
    setBusy(true);
    try {
      const result = await resolveAdjustmentProductScan(value, symbology, warehouseId);
      if (result.locationQr) { tell('warn', 'นี่คือ QR ตำแหน่งจัดเก็บ', 'ไม่ใช่ Barcode น้ำยา · ยังไม่ได้ปรับยอด'); return; }
      setRaw(value);
      setOptions([]);
      clearLotSelection();
      setDirection(1);
      setAmount('');
      setReason('');
      const trusted = result.parsed.warnings.length === 0;
      const nextLot = trusted ? result.parsed.lot ?? '' : '';
      const nextExpiry = trusted ? result.parsed.expiry ?? '' : '';
      setLotNumber(nextLot);
      setExpiry(nextExpiry);
      if (result.product) {
        setProductId(result.product.id);
        const loaded = optionsForProduct(await getAdjustmentLotOptions(warehouseId, result.product.id), result.product.id);
        setOptions(loaded);
        if (nextLot) chooseExistingLot(loaded, nextLot, nextExpiry);
        const productLabel = `${result.product.code} · ${result.product.name}`;
        if (!trusted) tell('warn', `${productLabel} · Barcode มีคำเตือน`, 'ตรวจ LOT และวันหมดอายุก่อนปรับยอด');
        else if (!nextLot || !nextExpiry) tell('warn', `${productLabel}`, 'Barcode ไม่มี LOT หรือวันหมดอายุครบ · กรอกเอง');
        else tell('ok', productLabel, `LOT ${nextLot} · หมดอายุ ${nextExpiry}`);
      } else {
        setProductId('');
        setOptions([]);
        tell('error', result.message ?? 'ไม่พบน้ำยาที่ตรงกับ Barcode', trusted && nextLot ? `อ่าน LOT ${nextLot} · เลือกน้ำยาเองเพื่อทำต่อ` : 'เลือกน้ำยาเองเพื่อทำต่อ');
      }
    } catch (cause) {
      setRaw(value);
      setProductId('');
      setOptions([]);
      clearLotSelection();
      setLotNumber('');
      setExpiry('');
      setAmount('');
      setReason('');
      tell('error', userMessage(cause instanceof Error ? cause.message : null, 'อ่าน Barcode ไม่สำเร็จ'));
    } finally { setBusy(false); }
  }

  function selectExistingLot(value: string) {
    const option = options.find(candidate => candidate.lot_id === value);
    if (!option) { clearLotSelection(); setAmount(''); setReason(''); return; }
    setDirection(1);
    setAmount('');
    setReason('');
    setLotId(option.lot_id);
    setLotNumber(option.lot_number);
    setExpiry(option.expiry_date);
    const locationsForLot = [...new Set(options.filter(candidate => candidate.lot_id === option.lot_id).map(candidate => candidate.location_id))];
    setLocationId(locationsForLot.length === 1 ? locationsForLot[0] : '');
  }

  function changeLotNumber(value: string) {
    setDirection(1);
    setAmount('');
    setReason('');
    setLotNumber(value);
    const sameLot = options.filter(option => option.lot_number === value);
    if (!sameLot.length) { clearLotSelection(); return; }
    const matching = expiry ? sameLot.filter(option => option.expiry_date === expiry) : sameLot;
    if (!expiry && new Set(sameLot.map(option => option.expiry_date)).size === 1) setExpiry(sameLot[0].expiry_date);
    if (!matching.length) { clearLotSelection(); return; }
    setLotId(matching[0].lot_id);
    const locationIds = [...new Set(matching.map(option => option.location_id))];
    setLocationId(locationIds.length === 1 ? locationIds[0] : '');
  }

  function changeExpiry(value: string) {
    setDirection(1);
    setAmount('');
    setReason('');
    setExpiry(value);
    const matching = options.filter(option => option.lot_number === lotNumber && option.expiry_date === value);
    if (!matching.length) { clearLotSelection(); return; }
    setLotId(matching[0].lot_id);
    const locationIds = [...new Set(matching.map(option => option.location_id))];
    setLocationId(locationIds.length === 1 ? locationIds[0] : '');
  }

  const uniqueLots = [...new Map(options.map(option => [option.lot_id, option])).values()];
  const summary = <p className="text-sm font-semibold" aria-live="off">{selectedSummary}{lotExists && locationId ? ` · คงเหลือ ${selectedBalance} @ ${selectedLocation?.code ?? '—'}` : ''}</p>;
  const summaryText = product ? `${product.product_code} LOT ${lotNumber} @ ${selectedLocation?.code ?? ''}` : '';

  return <div className="grid gap-4">
    <div><h2 className="font-bold text-lg mb-1">สแกนเพื่อปรับยอด</h2><p className="muted text-sm">สแกน DataMatrix เพื่อเติมน้ำยา, LOT และวันหมดอายุ · ตรวจตำแหน่งและเหตุผลก่อนยืนยัน</p></div>
    <BarcodeScanner onScan={onScan} feedback={feedback} summary={summary}/>
    {formError && <p className="error" role="alert">{formError}</p>}
    {locations.length === 0 && <p className="notice">ยังไม่มีตำแหน่งจัดเก็บในคลังนี้ · เพิ่มตำแหน่งก่อนปรับยอด</p>}
    <ConfirmForm action={adjustStock} className="surface p-5 sm:p-7 grid gap-4" message={data => `ยืนยันปรับยอด ${summaryText}\nLOT ${lotNumber} · หมดอายุ ${expiry} · ${selectedLocation?.code ?? ''}\nปรับ ${delta > 0 ? '+' : ''}${delta} · ยอดตำแหน่งนี้ ${selectedBalance} → ${after}\nเหตุผล: ${String(data.get('reason') ?? '')}\n\nบันทึกแล้วแก้ไขไม่ได้ ต้องใช้การยกเลิกรายการ`}>
      <input type="hidden" name="lot_id" value={lotId}/>
      <input type="hidden" name="product_id" value={productId}/>
      <input type="hidden" name="warehouse_id" value={warehouseId}/>
      <input type="hidden" name="warehouse" value={warehouseCode}/>
      <input type="hidden" name="product" value={productId}/>
      <input type="hidden" name="lot_number" value={lotNumber}/>
      <input type="hidden" name="expiry_date" value={expiry}/>
      <input type="hidden" name="location_id" value={locationId}/>
      <input type="hidden" name="idempotency_key" value={submissionKey}/>
      <input type="hidden" name="summary" value={summaryText}/>
      <input type="hidden" name="quantity_delta" value={delta || ''}/>

      <label className="field">น้ำยา<select className="input" value={productId} required onChange={event => void loadProductOptions(event.target.value, !productId && Boolean(raw))}>
        <option value="">สแกนหรือเลือกน้ำยา</option>
        {products.map(item => <option key={item.id} value={item.id}>{item.product_code} · {item.display_name}</option>)}
      </select></label>
      {product && <p className="notice text-sm"><strong>{product.product_code}</strong> · {product.display_name}</p>}

      {uniqueLots.length > 0 && <label className="field">เลือก LOT ที่มีอยู่ (ไม่ต้องเลือกเมื่อสแกน LOT ใหม่)<select className="input" value={lotId} onChange={event => selectExistingLot(event.target.value)}><option value="">สแกนหรือกรอก LOT</option>{uniqueLots.map(option => <option key={option.lot_id} value={option.lot_id}>LOT {option.lot_number} · หมดอายุ {option.expiry_date} · คงเหลือ {options.filter(row => row.lot_id === option.lot_id).reduce((sum,row) => sum + row.balance,0)}</option>)}</select></label>}
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="field">LOT<input className="input" value={lotNumber} onChange={event => changeLotNumber(event.target.value)} autoCapitalize="characters" autoCorrect="off" autoComplete="off" maxLength={80} required/></label>
        <label className="field">วันหมดอายุ<input className="input" type="date" value={expiry} onChange={event => changeExpiry(event.target.value)} required/>{expiry && <span className="muted text-xs">ตามฉลาก (ค.ศ.): {expiry}</span>}</label>
      </div>
      {expiryConflict && <p className="error" role="alert">LOT นี้มีวันหมดอายุในระบบไม่ตรงกับ Barcode · ตรวจฉลากและข้อมูลเดิมก่อน</p>}
      {lotNumber && expiry && !lotExists && !expiryConflict && <p className="notice text-sm">ยังไม่มี LOT นี้ในคลัง · การปรับเพิ่ม (+) จะสร้าง LOT และยอดเริ่มต้นพร้อมกัน</p>}
      {lotExists && <p className="notice text-sm">ยอดรวม LOT นี้ทุกตำแหน่ง {totalLotBalance} · เลือกตำแหน่งที่จะปรับยอด</p>}

      <label className="field">ตำแหน่งจัดเก็บ<select className="input" value={locationId} onChange={event => { setLocationId(event.target.value); setAmount(''); setReason(''); setDirection(1); }} required><option value="">เลือกตำแหน่ง</option>{locations.map(location => <option key={location.id} value={location.id}>{location.parent_code ? `${location.parent_code} › ` : ''}{location.code} · {location.name}</option>)}</select></label>
      {locationId && <p className="muted text-sm">ยอดตำแหน่งนี้ {selectedBalance} · หลังปรับ {after}</p>}

      <fieldset className="grid gap-2"><legend className="field mb-2">ทิศทางและจำนวนที่ปรับ</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="ทิศทางการปรับ">{([[1,'เพิ่มยอด (+)'],[-1,'ลดยอด (−)']] as const).map(([value,label]) => <label key={value} className={`button secondary cursor-pointer text-center ${direction === value ? '!border-[var(--blue)] !bg-[#e8f1f8]' : ''} ${value < 0 && !lotId ? 'opacity-45' : ''}`}><input type="radio" className="sr-only" name="direction" checked={direction === value} disabled={value < 0 && !lotId} onChange={() => setDirection(value)}/>{label}</label>)}</div>
        <label className="field">จำนวน<input className="input" aria-label="จำนวนที่ปรับ" type="number" inputMode="decimal" min="0.001" step="0.001" value={amount} onChange={event => setAmount(event.target.value)} required/></label>
        {direction < 0 && !lotId && <p className="muted text-xs">การปรับลดต้องเลือก LOT ที่มีอยู่ในระบบ</p>}
        {direction < 0 && lotId && after < 0 && <p className="error text-sm" role="alert">จำนวนที่ลดมากกว่ายอดคงเหลือ ณ ตำแหน่งนี้</p>}
      </fieldset>
      <label className="field">เหตุผล<textarea className="input min-h-24" name="reason" value={reason} onChange={event => setReason(event.target.value)} required maxLength={1000} placeholder="เช่น ตั้งยอดคงเหลือเริ่มต้นตามการตรวจนับ ณ วันที่…"/></label>
      {raw && <details><summary className="cursor-pointer text-sm font-semibold">ดูข้อมูล Barcode ที่สแกน</summary><p className="muted text-xs break-all mt-2">{raw}</p></details>}
      <SubmitButton label="ตรวจทานและปรับยอด" pendingLabel="กำลังบันทึก…" disabled={!canSubmit || busy}/>
    </ConfirmForm>
  </div>;
}
