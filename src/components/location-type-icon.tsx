import { Archive, DoorClosed, Layers, MapPin, Refrigerator, Rows3, Snowflake, Table2, type LucideIcon } from 'lucide-react';

const icons: Record<string, LucideIcon> = { room: DoorClosed, refrigerator: Refrigerator, freezer: Snowflake, cabinet: Archive, shelf: Layers, rack: Rows3, bench: Table2, other: MapPin };

/** The type is always named next to the icon (or in its accessible name), never conveyed by the picture alone. */
export function LocationTypeIcon({ type, size = 18, className }: { type: string; size?: number; className?: string }) {
  const Icon = icons[type] ?? MapPin;
  return <Icon size={size} aria-hidden className={className} />;
}
