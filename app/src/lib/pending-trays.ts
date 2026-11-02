/**
 * "Pending" trays: trays that were just loaded with filament SpoolmanSync could
 * not identify, waiting for the user to say which spool it is — from the phone
 * notification, or by opening the spool's page from its NFC sticker / QR label.
 *
 * Kept in the settings table as one JSON row (a handful of entries at most),
 * pruned on every read once they expire.
 */
import prisma from '@/lib/db';

export const PENDING_TRAYS_KEY = 'pending_tray_assignments';
export const PENDING_MINUTES_KEY = 'pending_tray_minutes';
export const DEFAULT_PENDING_MINUTES = 30;

export interface PendingTray {
  /** Short id used in notification actions (they cannot carry a tray id safely). */
  id: string;
  /** Tray key assignments are stored under (unique_id, or entity_id as fallback). */
  trayId: string;
  /** Tray sensor entity_id, for logging and the live state checks. */
  entityId: string;
  /** Human label, e.g. "X1C · AMS 1 Tray 2". */
  label: string;
  material: string;
  color: string;
  /** Spool serial the tray reported, '' for a spool without one. */
  traySerial: string;
  /** Spool ids offered in the notification, best first. */
  candidateIds: number[];
  createdAt: number;
}

type PendingMap = Record<string, PendingTray>;

export async function getPendingMinutes(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { key: PENDING_MINUTES_KEY } });
  const n = Number(s?.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PENDING_MINUTES;
}

async function load(): Promise<PendingMap> {
  const s = await prisma.settings.findUnique({ where: { key: PENDING_TRAYS_KEY } });
  if (!s?.value) return {};
  try {
    const parsed: unknown = JSON.parse(s.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PendingMap) : {};
  } catch {
    return {};
  }
}

async function save(map: PendingMap): Promise<void> {
  const value = JSON.stringify(map);
  await prisma.settings.upsert({
    where: { key: PENDING_TRAYS_KEY },
    update: { value },
    create: { key: PENDING_TRAYS_KEY, value },
  });
}

/** Drop expired entries; returns the live ones (keyed by trayId). */
export function pruneExpired(map: PendingMap, now: number, minutes: number): PendingMap {
  const cutoff = now - minutes * 60_000;
  const live: PendingMap = {};
  for (const [key, entry] of Object.entries(map)) {
    if (entry && typeof entry.createdAt === 'number' && entry.createdAt >= cutoff) live[key] = entry;
  }
  return live;
}

/** All pending trays that have not expired, newest first. */
export async function listPendingTrays(now: number = Date.now()): Promise<PendingTray[]> {
  const map = await load();
  const live = pruneExpired(map, now, await getPendingMinutes());
  if (Object.keys(live).length !== Object.keys(map).length) await save(live);
  return Object.values(live).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPendingTray(trayId: string): Promise<PendingTray | null> {
  return (await listPendingTrays()).find(p => p.trayId === trayId) ?? null;
}

export async function getPendingTrayById(id: string): Promise<PendingTray | null> {
  return (await listPendingTrays()).find(p => p.id === id) ?? null;
}

/** Whether an existing entry already describes this load (no re-prompt needed). */
export function isSameLoad(existing: PendingTray | null, next: Pick<PendingTray, 'material' | 'color' | 'traySerial'>): boolean {
  return !!existing
    && existing.material === next.material
    && existing.color.toLowerCase() === next.color.toLowerCase()
    && existing.traySerial === next.traySerial;
}

export async function setPendingTray(entry: Omit<PendingTray, 'id' | 'createdAt'>, now: number = Date.now()): Promise<PendingTray> {
  const map = pruneExpired(await load(), now, await getPendingMinutes());
  const pending: PendingTray = {
    ...entry,
    id: Math.random().toString(36).slice(2, 10),
    createdAt: now,
  };
  map[entry.trayId] = pending;
  await save(map);
  return pending;
}

/** Remove the pending entry for a tray (assigned, emptied, or superseded). */
export async function clearPendingTray(...trayIds: string[]): Promise<PendingTray | null> {
  const map = await load();
  let removed: PendingTray | null = null;
  for (const trayId of trayIds) {
    if (trayId && map[trayId]) {
      removed = removed ?? map[trayId];
      delete map[trayId];
    }
  }
  if (removed) await save(map);
  return removed;
}
