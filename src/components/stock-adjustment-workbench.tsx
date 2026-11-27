'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { adjustStock, getAdjustmentLotOptions } from '@/app/actions/inventory';
import { resolveProductScan } from '@/app/actions/scanner';
import { userMessage } from '@/lib/messages';
import { BarcodeScanner, type ScanFeedback } from './barcode-scanner';
import { ConfirmForm } from './confirm-form';
import { IntegerQuantityInput } from './integer-quantity-input';
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
  products: (PickerProduct & { warehouse_id: number })[];
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
  const [productSearch, setProductSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focusedResult, setFocusedResult] = useState(-1);
  const [showScanner, setShowScanner] = useState(false);
  const pickerId = useId();
  const [formError, setFormError] = useState('');
  const feedbackId = useRef(0);
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const locationById = useMemo(() => new Map(locations.map(location => [location.id, location])), [locations]);
  const product = productById.get(productId);
  const pickerMatches = useMemo(() => {
    const terms = productSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return products.filter(item => {
      const searchable = (item.product_code + ' ' + item.display_name).toLocaleLowerCase();
      return terms.every(term => searchable.includes(term));
    }).slice(0, 60);
  }, [products, productSearch]);
  const activeWarehouseId = product?.warehouse_id ?? warehouseId;
  const activeWarehouseCode = product?.product_code.startsWith('IMM-') ? 'IMM' : product?.product_code.startsWith('CHE-') ? 'CHE' : warehouseCode;
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
  const canSubmit = Boolean(product && lotNumber.trim() && expiry && locationId && amount && Number(amount) > 0 && !expiryConflict && locations.length && (lotId || direction > 0) && (direction > 0 || after >= 0));

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

  function chooseProduct(nextProductId: string) {
    setPickerOpen(false);
    setFocusedResult(-1);
    setProductSearch('');
    setShowScanner(false);
    setFeedback(null);
    void loadProductOptions(nextProductId, !productId && Boolean(raw));
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
      const loaded = optionsForProduct(await getAdjustmentLotOptions(productById.get(nextProductId)?.warehouse_id ?? warehouseId, nextProductId), nextProductId);
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
      const result = await resolveProductScan(value, symbology);
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
        const loaded = optionsForProduct(await getAdjustmentLotOptions(result.product.warehouseId, result.product.id), result.product.id);
        setOptions(loaded);
        if (nextLot) chooseExistingLot(loaded, nextLot, nextExpiry);
        setPickerOpen(false);
        setProductSearch('');
        setShowScanner(false);
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
    <div><h2 className="font-bold text-lg mb-1">เลือกน้ำยาที่ต้องการปรับยอด</h2><p className="muted text-sm">ค้นหาน้ำยาจากรหัสหรือชื่อ หรือสแกน Data Matrix / Barcode เพื่อเลือกน้ำยาและอ่าน LOT กับวันหมดอายุ</p></div>
    {!showScanner && feedback && <p className={feedback.tone === 'error' ? 'error' : 'notice text-sm'} role="status"><strong>{feedback.title}</strong>{feedback.detail ? ' · ' + feedback.detail : ''}</p>}
    {formError && <p className="error" role="alert">{formError}</p>}
    {locations.length === 0 && <p className="notice">ยังไม่มีตำแหน่งจัดเก็บในคลังนี้ · เพิ่มตำแหน่งก่อนปรับยอด</p>}
    <ConfirmForm action={adjustStock} className="surface p-5 sm:p-7 grid gap-4" message={data => `ยืนยันปรับยอด ${summaryText}\nLOT ${lotNumber} · หมดอายุ ${expiry} · ${selectedLocation?.code ?? ''}\nปรับ ${delta > 0 ? '+' : ''}${delta} · ยอดตำแหน่งนี้ ${selectedBalance} → ${after}\nเหตุผล: ${String(data.get('reason') ?? '')}\n\nบันทึกแล้วแก้ไขไม่ได้ ต้องใช้การยกเลิกรายการ`}>
      <input type="hidden" name="lot_id" value={lotId}/>
      <input type="hidden" name="product_id" value={productId}/>
      <input type="hidden" name="warehouse_id" value={activeWarehouseId}/>
      <input type="hidden" name="warehouse" value={activeWarehouseCode}/>
      <input type="hidden" name="product" value={productId}/>
      <input type="hidden" name="lot_number" value={lotNumber}/>
      <input type="hidden" name="expiry_date" value={expiry}/>
      <input type="hidden" name="location_id" value={locationId}/>
      <input type="hidden" name="idempotency_key" value={submissionKey}/>
      <input type="hidden" name="summary" value={summaryText}/>
      <input type="hidden" name="quantity_delta" value={delta || ''}/>

      <div className="field">
        <label htmlFor={pickerId}>น้ำยา <span className="text-rose-600" aria-hidden>*</span></label>
        <div className="flex items-start gap-2">
          <div className="relative min-w-0 flex-1" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false);
          }}>
            <input
              id={pickerId}
              type="text"
              className="input w-full"
              role="combobox"
              aria-label="ค้นหาและเลือกน้ำยา"
              aria-autocomplete="list"
              aria-expanded={pickerOpen}
              aria-controls={pickerId + '-results'}
              aria-activedescendant={pickerOpen && focusedResult >= 0 && pickerMatches[focusedResult] ? pickerId + '-option-' + focusedResult : undefined}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ค้นหารหัสหรือชื่อน้ำยา"
              value={pickerOpen ? productSearch : product ? product.product_code + ' · ' + product.display_name : ''}
              disabled={busy}
              onFocus={() => { setPickerOpen(true); setProductSearch(''); setFocusedResult(-1); }}
              onChange={event => { setProductSearch(event.target.value); setPickerOpen(true); setFocusedResult(-1); }}
              onKeyDown={event => {
                if (event.key === 'Escape') { setPickerOpen(false); return; }
                if (event.key === 'ArrowDown') {
                  event.preventDefault(); setPickerOpen(true);
                  setFocusedResult(index => Math.min(index + 1, pickerMatches.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setFocusedResult(index => Math.max(index - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const match = focusedResult >= 0 ? pickerMatches[focusedResult] : pickerMatches.length === 1 ? pickerMatches[0] : undefined;
                  if (match) chooseProduct(match.id);
                  else if (productSearch.trim() && pickerMatches.length === 0) {
                    setPickerOpen(false);
                    void onScan(productSearch.trim(), 'manual');
                  }
                }
              }}
            />
            {pickerOpen && <div id={pickerId + '-results'} role="listbox" aria-label="ผลการค้นหาน้ำยา" className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
              {pickerMatches.map((item, index) => <button
                key={item.id}
                id={pickerId + '-option-' + index}
                type="button"
                role="option"
                aria-selected={productId === item.id}
                className={'block w-full border-b border-slate-100 px-3 py-3 text-left text-sm last:border-0 hover:bg-sky-50 focus:bg-sky-50 ' + (focusedResult === index ? 'bg-sky-50' : '')}
                onMouseDown={event => event.preventDefault()}
                onClick={() => chooseProduct(item.id)}
              ><span className="font-semibold">{item.product_code}</span><span className="ml-1">· {item.display_name}</span></button>)}
              {!pickerMatches.length && <p className="p-3 text-sm text-slate-600">ไม่พบน้ำยาที่ตรงกับคำค้น · ลองค้นหารหัสอื่นหรือสแกน Barcode</p>}
              {pickerMatches.length === 60 && <p className="border-t border-slate-100 p-2 text-center text-xs text-slate-600">แสดงสูงสุด 60 รายการ · พิมพ์เพิ่มเพื่อค้นหาให้แคบลง</p>}
            </div>}
          </div>
          <button type="button" className="button secondary min-h-11 shrink-0" aria-expanded={showScanner} aria-label={showScanner ? 'ปิดเครื่องสแกนน้ำยา' : 'สแกน Barcode เพื่อเลือกน้ำยา'} disabled={busy} onClick={() => { setPickerOpen(false); setShowScanner(value => !value); }}>
            <ScanLine size={18} aria-hidden/> <span>{showScanner ? 'ปิดสแกน' : 'สแกน'}</span>
          </button>
        </div>
        <p className="muted text-xs">ค้นหาจากรหัสหรือชื่อ แล้วแตะเลือกรายการ · หรือสแกน Barcode ที่กล่องน้ำยา</p>
      </div>
      {showScanner && <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
        {/* The parent adjustment form already owns submit; suppress the scanner's nested manual form. */}
        <BarcodeScanner onScan={onScan} feedback={feedback} summary={summary} showManual={false} autoStart/>
      </div>}
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
        <label className="field">จำนวน<IntegerQuantityInput className="input" aria-label="จำนวนที่ปรับ" min="1" value={amount} onChange={event => setAmount(event.target.value)} required/></label>
        {direction < 0 && !lotId && <p className="muted text-xs">การปรับลดต้องเลือก LOT ที่มีอยู่ในระบบ</p>}
        {direction < 0 && lotId && after < 0 && <p className="error text-sm" role="alert">จำนวนที่ลดมากกว่ายอดคงเหลือ ณ ตำแหน่งนี้</p>}
      </fieldset>
      <label className="field">เหตุผล (ไม่บังคับ)<textarea className="input min-h-24" name="reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} placeholder="เช่น ตั้งยอดคงเหลือเริ่มต้นตามการตรวจนับ ณ วันที่…"/></label>
      {raw && <details><summary className="cursor-pointer text-sm font-semibold">ดูข้อมูล Barcode ที่สแกน</summary><p className="muted text-xs break-all mt-2">{raw}</p></details>}
      <SubmitButton label="ตรวจทานและปรับยอด" pendingLabel="กำลังบันทึก…" disabled={!canSubmit || busy}/>
    </ConfirmForm>
  </div>;
}
