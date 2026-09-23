'use client';

export function PrintButton() {
  return <button type="button" className="button print-hide" onClick={() => window.print()}>พิมพ์ / บันทึก PDF</button>;
}
