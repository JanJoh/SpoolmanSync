/**
 * Assign prompt: when a tray reports filament that matches no spool by serial,
 * offer the likely spools on the user's phone (Home Assistant mobile app
 * notification with one button per candidate), or assign a confident match
 * outright. The user can also answer by opening the spool's page from its NFC
 * sticker or QR label, which offers the pending tray first.
 *
 * Opt-in: nothing here runs unless ASSIGN_PROMPT_ENABLED_KEY is on.
 */
import prisma from '@/lib/db';
import type { Spool } from '@/lib/api/spoolman';
import type { HAPrinter, HomeAssistantClient } from '@/lib/api/homeassistant';
import type { PendingTray } from '@/lib/pending-trays';
import type { SpoolCandidate } from '@/lib/spool-matching';

export const ASSIGN_PROMPT_ENABLED_KEY = 'assign_prompt_enabled';
export const ASSIGN_PROMPT_NOTIFY_KEY = 'assign_prompt_notify_service';
export const AUTO_ASSIGN_CONFIDENT_KEY = 'auto_assign_confident';

/** Prefix of every notification action id this feature sends. */
export const ASSIGN_ACTION_PREFIX = 'SPOOLMANSYNC_ASSIGN_';
/** How many candidates get their own button. */
export const MAX_CANDIDATE_BUTTONS = 3;

export interface AssignPromptSettings {
  enabled: boolean;
  /** Notify service without the "notify." prefix, e.g. "mobile_app_my_phone"; '' = none. */
  notifyService: string;
  autoAssign: boolean;
  /** Base URL for links (the QR / NFC base URL setting); '' = no links. */
  baseUrl: string;
}

/** Accept "notify.mobile_app_x" or "mobile_app_x"; reject anything else. */
export function normalizeNotifyService(value: string | undefined | null): string {
  const v = (value || '').trim().replace(/^notify\./, '');
  return /^[a-z0-9_]+$/.test(v) ? v : '';
}

export async function getAssignPromptSettings(): Promise<AssignPromptSettings> {
  const rows = await prisma.settings.findMany({
    where: { key: { in: [ASSIGN_PROMPT_ENABLED_KEY, ASSIGN_PROMPT_NOTIFY_KEY, AUTO_ASSIGN_CONFIDENT_KEY, 'qr_base_url'] } },
  });
  const get = (key: string) => rows.find(r => r.key === key)?.value;
  return {
    enabled: get(ASSIGN_PROMPT_ENABLED_KEY) === 'true',
    notifyService: normalizeNotifyService(get(ASSIGN_PROMPT_NOTIFY_KEY)),
    // On by default once the feature itself is enabled.
    autoAssign: get(AUTO_ASSIGN_CONFIDENT_KEY) !== 'false',
    baseUrl: (get('qr_base_url') || '').trim().replace(/\/+$/, ''),
  };
}

/** "X1C · AMS 1 Tray 2" for a tray entity/unique id, or the id itself when unknown. */
export function describeTray(printers: HAPrinter[], trayKey: string): string {
  for (const p of printers) {
    for (const ams of p.ams_units) {
      for (const t of ams.trays) {
        if (t.entity_id === trayKey || t.unique_id === trayKey) {
          return `${p.name} · ${ams.name} Tray ${t.tray_number}`;
        }
      }
    }
    for (const ext of p.external_spools) {
      if (ext.entity_id === trayKey || ext.unique_id === trayKey) {
        return `${p.name} · ${ext.slot_name?.trim() || 'External'}`;
      }
    }
  }
  return trayKey;
}

export function spoolTitle(spool: Spool): string {
  const vendor = spool.filament?.vendor?.name?.trim();
  const name = spool.filament?.name?.trim() || spool.filament?.material || 'Spool';
  return `#${spool.id} ${vendor ? `${vendor} ` : ''}${name}`;
}

function buttonTitle(spool: Spool): string {
  return `${spoolTitle(spool)} · ${Math.round(spool.remaining_weight ?? 0)} g`;
}

export function assignActionId(pendingId: string, spoolId: number): string {
  return `${ASSIGN_ACTION_PREFIX}${pendingId}_${spoolId}`;
}

/** Parse an action id back to its pending id and spool id; null if it is not ours. */
export function parseAssignActionId(action: string | undefined | null): { pendingId: string; spoolId: number } | null {
  const m = /^SPOOLMANSYNC_ASSIGN_([a-z0-9]+)_(\d+)$/.exec((action || '').trim());
  if (!m) return null;
  return { pendingId: m[1], spoolId: Number(m[2]) };
}

/** Notification tag, so a newer message about the same tray replaces the older one. */
export function notificationTag(trayId: string): string {
  return `spoolmansync-${trayId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Data for notify.<service>: the "which spool?" question. */
export function buildPromptNotification(
  pending: PendingTray,
  candidates: SpoolCandidate[],
  baseUrl: string,
): Record<string, unknown> {
  const shown = candidates.slice(0, MAX_CANDIDATE_BUTTONS);
  const what = [pending.material, pending.color].filter(Boolean).join(', ');
  const message = shown.length > 0
    ? `${what || 'Unknown filament'} was loaded. Tap the matching spool, or scan its tag.`
    : `${what || 'Unknown filament'} was loaded and no spool in Spoolman matches. Scan the spool's tag or pick it in SpoolmanSync.`;

  const actions: Record<string, unknown>[] = shown.map(c => ({
    action: assignActionId(pending.id, c.spool.id),
    title: buttonTitle(c.spool),
  }));
  if (baseUrl) actions.push({ action: 'URI', title: 'Open SpoolmanSync', uri: `${baseUrl}/` });

  return {
    title: `${pending.label}: which spool?`,
    message,
    data: {
      tag: notificationTag(pending.trayId),
      ...(baseUrl && { url: `${baseUrl}/` }),
      actions,
    },
  };
}

/** Data for notify.<service>: "assigned automatically", with a way to correct it. */
export function buildAssignedNotification(
  trayId: string,
  trayLabel: string,
  spool: Spool,
  baseUrl: string,
): Record<string, unknown> {
  return {
    title: `${trayLabel}: ${spoolTitle(spool)}`,
    message: `Assigned automatically (${Math.round(spool.remaining_weight ?? 0)} g left). Open SpoolmanSync if this is the wrong spool.`,
    data: {
      tag: notificationTag(trayId),
      ...(baseUrl && { url: `${baseUrl}/` }),
    },
  };
}

/** Data for notify.<service>: usage arrived for a tray with no spool, so nothing was deducted. */
export function buildUnmatchedUsageNotification(
  trayId: string,
  trayLabel: string,
  grams: number,
  baseUrl: string,
): Record<string, unknown> {
  return {
    title: `${trayLabel}: ${grams.toFixed(1)} g not deducted`,
    message: 'No spool is assigned to this tray, so the usage was not recorded. Assign the spool and deduct the grams by hand in Spoolman.',
    data: {
      tag: `${notificationTag(trayId)}-usage`,
      ...(baseUrl && { url: `${baseUrl}/` }),
    },
  };
}

/** Send a notification through Home Assistant; failures are logged, never thrown. */
export async function sendPhoneNotification(
  ha: HomeAssistantClient | null,
  service: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!ha || !service) return false;
  try {
    await ha.callService('notify', service, data);
    return true;
  } catch (err) {
    console.warn(`[assign-prompt] Could not send notify.${service}:`, err);
    return false;
  }
}

/** Remove the question from the phone once it is answered some other way. */
export async function clearPhoneNotification(
  ha: HomeAssistantClient | null,
  service: string,
  trayId: string,
): Promise<void> {
  await sendPhoneNotification(ha, service, {
    message: 'clear_notification',
    data: { tag: notificationTag(trayId) },
  });
}
