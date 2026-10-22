import { notFound } from 'next/navigation';

// Location labels are managed by the central Lab Management Portal.
// Do not print old warehouse-specific location QR labels from this app.
export default function RetiredLocationQrPage(): never {
  notFound();
}
