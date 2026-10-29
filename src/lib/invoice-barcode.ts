/** Invoice scanning accepts the printed invoice identifier, never an arbitrary
 * structured QR payload, product GS1 symbol, or a web link. The user can always
 * correct the populated field before creating the invoice.
 */
export type InvoiceScanNumber = { ok: true; invoiceNumber: string } | { ok: false; message: string };
const invalid = (message: string): InvoiceScanNumber => ({ ok: false, message });

export function invoiceNumberFromScan(raw: string, symbology: string): InvoiceScanNumber {
  const invoiceNumber = raw.trim();
  if (!invoiceNumber) return invalid('ไม่พบข้อความใน Barcode');
  if (invoiceNumber.length > 120) return invalid('รหัสยาวเกินไป · กรุณาตรวจสอบเลขที่ Invoice บนเอกสาร');
  // Codes on reagent boxes commonly encode GS1 product/batch information, not
  // invoice references. Never place that whole payload into the invoice field.
  if (/^\](?:C1|d2|e0)/i.test(invoiceNumber) || /^\(01\)/.test(invoiceNumber) || invoiceNumber.includes('\x1d')) {
    return invalid('พบรหัส GS1 ของสินค้า ไม่ใช่เลข Invoice');
  }
  if (/^\s*(?:https?:\/\/|www\.|mailto:|tel:|\{|\[|<\?xml)/i.test(invoiceNumber)
      || /[\r\n\x00-\x1f\x7f]/.test(invoiceNumber)) {
    return invalid('Barcode มีข้อมูลหลายส่วนหรือเป็นลิงก์ · กรุณากรอกเลข Invoice จากเอกสาร');
  }
  // Data Matrix is commonly used by GS1 reagents. To avoid accidental use of
  // a reagent identifier, only permit invoice numbers in the formats above.
  if (symbology === 'DATA_MATRIX') return invalid('โปรดสแกน Barcode เลข Invoice บนเอกสาร ไม่ใช่ Data Matrix ของน้ำยา');
  // Plain alphanumerics plus conventional invoice-number separators. Reject
  // structured QR data rather than extracting an unverified substring.
  if (!/^[\p{L}\p{N} ._\/#:+-]+$/u.test(invoiceNumber)) {
    return invalid('รหัสไม่ใช่เลข Invoice แบบข้อความตรง ๆ · กรุณากรอกเอง');
  }
  return { ok: true, invoiceNumber };
}
