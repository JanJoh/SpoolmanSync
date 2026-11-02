/**
 * The assign-prompt flow, shared by the webhook (tray loaded, notification
 * button tapped) and the manual assign API (sticker / QR page). Dependencies are
 * passed in so the flow can be tested without Spoolman or Home Assistant.
 */
import type { Spool, SpoolmanClient } from '@/lib/api/spoolman';
import type { HomeAssistantClient } from '@/lib/api/homeassistant';
import {
  buildAssignedNotification,
  buildPromptNotification,
  clearPhoneNotification,
  parseAssignActionId,
  sendPhoneNotification,
  type AssignPromptSettings,
} from '@/lib/assign-prompt';
import {
  clearPendingTray,
  getPendingTray,
  getPendingTrayById,
  isSameLoad,
  setPendingTray,
  type PendingTray,
} from '@/lib/pending-trays';
import { findSpoolCandidates, pickConfidentCandidate } from '@/lib/spool-matching';

export interface UnidentifiedTray {
  /** Key assignments are stored under (unique_id). */
  trayId: string;
  entityId: string;
  label: string;
  material: string;
  color: string;
  /** Valid spool serial the tray reported, '' when none (or not a per-spool serial). */
  traySerial: string;
}

export type PromptOutcome =
  | { action: 'disabled' }
  | { action: 'auto_assigned'; spool: Spool; notified: boolean }
  | { action: 'prompted'; pending: PendingTray; candidateIds: number[]; notified: boolean }
  | { action: 'already_pending'; pending: PendingTray };

/**
 * Called for a tray that has filament but no spool assigned and no serial match.
 * Assigns a confident match (when auto-assign is on), otherwise records the tray
 * as pending and asks on the phone. Re-reports of the same load are ignored so
 * the phone is not pinged on every attribute update.
 */
export async function handleUnidentifiedTray(
  client: SpoolmanClient,
  spools: Spool[],
  tray: UnidentifiedTray,
  settings: AssignPromptSettings,
  ha: HomeAssistantClient | null,
): Promise<PromptOutcome> {
  if (!settings.enabled) return { action: 'disabled' };

  const existing = await getPendingTray(tray.trayId);
  if (isSameLoad(existing, tray)) return { action: 'already_pending', pending: existing! };

  const candidates = findSpoolCandidates(spools, {
    material: tray.material,
    color: tray.color,
    hasSerial: !!tray.traySerial,
  });

  const confident = settings.autoAssign ? pickConfidentCandidate(candidates) : null;
  if (confident) {
    await assignWithSerial(client, confident.id, tray.trayId, tray.traySerial);
    await clearPendingTray(tray.trayId);
    const notified = await sendPhoneNotification(
      ha,
      settings.notifyService,
      buildAssignedNotification(tray.trayId, tray.label, confident, settings.baseUrl),
    );
    return { action: 'auto_assigned', spool: confident, notified };
  }

  const candidateIds = candidates.map(c => c.spool.id);
  const pending = await setPendingTray({ ...tray, candidateIds });
  const notified = await sendPhoneNotification(
    ha,
    settings.notifyService,
    buildPromptNotification(pending, candidates, settings.baseUrl),
  );
  return { action: 'prompted', pending, candidateIds, notified };
}

/** Assign, and teach SpoolmanSync the spool's serial when the tray reported one. */
export async function assignWithSerial(
  client: SpoolmanClient,
  spoolId: number,
  trayId: string,
  traySerial: string,
): Promise<void> {
  await client.assignSpoolToTray(spoolId, trayId);
  if (traySerial) await client.setSpoolTag(spoolId, traySerial);
}

export type ChoiceOutcome =
  | { status: 'ignored'; reason: 'not_ours' | 'expired' | 'unknown_spool' }
  | { status: 'assigned'; spool: Spool; pending: PendingTray };

/** A notification button was tapped: assign that spool to the pending tray. */
export async function applyAssignChoice(
  client: SpoolmanClient,
  action: string,
  settings: AssignPromptSettings,
  ha: HomeAssistantClient | null,
): Promise<ChoiceOutcome> {
  const parsed = parseAssignActionId(action);
  if (!parsed) return { status: 'ignored', reason: 'not_ours' };

  const pending = await getPendingTrayById(parsed.pendingId);
  if (!pending) return { status: 'ignored', reason: 'expired' };

  let spool: Spool;
  try {
    spool = await client.getSpool(parsed.spoolId);
  } catch {
    return { status: 'ignored', reason: 'unknown_spool' };
  }
  if (!spool || spool.archived) return { status: 'ignored', reason: 'unknown_spool' };

  await assignWithSerial(client, spool.id, pending.trayId, pending.traySerial);
  await clearPendingTray(pending.trayId);
  await clearPhoneNotification(ha, settings.notifyService, pending.trayId);
  return { status: 'assigned', spool, pending };
}

/**
 * A spool was assigned by hand (dashboard, sticker or QR page). If that tray was
 * pending, finish it off: learn the serial, drop the entry and the question.
 */
export async function resolvePendingOnManualAssign(
  client: SpoolmanClient,
  spoolId: number,
  trayId: string,
  settings: AssignPromptSettings,
  ha: HomeAssistantClient | null,
): Promise<PendingTray | null> {
  const pending = await clearPendingTray(trayId);
  if (!pending) return null;
  if (pending.traySerial) await client.setSpoolTag(spoolId, pending.traySerial);
  await clearPhoneNotification(ha, settings.notifyService, pending.trayId);
  return pending;
}
