import QRCode from 'qrcode';

/** Server-side QR as an SVG string (error correction M, 2-module quiet zone). */
export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}

/** The same SVG as a data URI, so a page can show it with <img> and needs no raw-HTML injection. */
export async function qrDataUri(text: string): Promise<string> {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await qrSvg(text))}`;
}
