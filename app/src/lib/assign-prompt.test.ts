import { describe, it, expect } from 'vitest';
import type { Spool } from './api/spoolman';
import type { HAPrinter } from './api/homeassistant';
import type { PendingTray } from './pending-trays';
import {
  normalizeNotifyService,
  assignActionId,
  parseAssignActionId,
  notificationTag,
  buildPromptNotification,
  buildAssignedNotification,
  describeTray,
  MAX_CANDIDATE_BUTTONS,
  buildUnmatchedUsageNotification,
} from './assign-prompt';

const spool = (id: number, remaining = 495): Spool => ({
  id,
  filament: { id: 1, name: 'Green', material: 'PLA', vendor: { id: 1, name: 'Clas Ohlson' } },
  remaining_weight: remaining,
  extra: {},
} as unknown as Spool);

const pending: PendingTray = {
  id: 'abc123',
  trayId: 'x1c_tray_2',
  entityId: 'sensor.x1c_ams_1_tray_2',
  label: 'X1C · AMS 1 Tray 2',
  material: 'PLA',
  color: '#057748FF',
  traySerial: '',
  candidateIds: [24, 4],
  createdAt: 0,
};

describe('normalizeNotifyService', () => {
  it('accepts the service with or without the notify. prefix', () => {
    expect(normalizeNotifyService('notify.mobile_app_my_phone')).toBe('mobile_app_my_phone');
    expect(normalizeNotifyService(' mobile_app_my_phone ')).toBe('mobile_app_my_phone');
  });

  it('rejects anything that is not a plain service name', () => {
    expect(normalizeNotifyService('light.turn_on')).toBe('');
    expect(normalizeNotifyService('notify.bad name')).toBe('');
    expect(normalizeNotifyService('')).toBe('');
  });
});

describe('assign action ids', () => {
  it('round-trips', () => {
    expect(parseAssignActionId(assignActionId('abc123', 24))).toEqual({ pendingId: 'abc123', spoolId: 24 });
  });

  it('ignores other actions', () => {
    expect(parseAssignActionId('URI')).toBeNull();
    expect(parseAssignActionId('SPOOLMANSYNC_ASSIGN_abc')).toBeNull();
    expect(parseAssignActionId(undefined)).toBeNull();
  });
});

describe('notificationTag', () => {
  it('is stable per tray and safe as a tag', () => {
    expect(notificationTag('x1c tray/2')).toBe('spoolmansync-x1c_tray_2');
  });
});

describe('buildPromptNotification', () => {
  it('offers one button per candidate, capped, plus an open link', () => {
    const candidates = [1, 2, 3, 4, 5].map(id => ({ spool: spool(id), deltaE: id }));
    const n = buildPromptNotification(pending, candidates, 'http://ha:3000');
    const data = n.data as { tag: string; url: string; actions: Array<{ action: string; title: string; uri?: string }> };

    expect(n.title).toBe('X1C · AMS 1 Tray 2: which spool?');
    expect(data.tag).toBe(notificationTag('x1c_tray_2'));
    expect(data.url).toBe('http://ha:3000/');
    expect(data.actions).toHaveLength(MAX_CANDIDATE_BUTTONS + 1);
    expect(data.actions[0]).toEqual({ action: assignActionId('abc123', 1), title: '#1 Clas Ohlson Green · 495 g' });
    expect(data.actions.at(-1)).toEqual({ action: 'URI', title: 'Open SpoolmanSync', uri: 'http://ha:3000/' });
  });

  it('still asks, without buttons, when nothing matches', () => {
    const n = buildPromptNotification(pending, [], '');
    const data = n.data as { url?: string; actions: unknown[] };
    expect(n.message).toContain('no spool in Spoolman matches');
    expect(data.actions).toEqual([]);
    expect(data.url).toBeUndefined();
  });
});

describe('buildAssignedNotification', () => {
  it('names the spool and replaces the question for that tray', () => {
    const n = buildAssignedNotification('x1c_tray_2', 'X1C · AMS 1 Tray 2', spool(24), '');
    expect(n.title).toBe('X1C · AMS 1 Tray 2: #24 Clas Ohlson Green');
    expect((n.data as { tag: string }).tag).toBe(notificationTag('x1c_tray_2'));
  });
});

describe('describeTray', () => {
  const printers = [{
    name: 'X1C',
    ams_units: [{ name: 'AMS 1', trays: [{ entity_id: 'sensor.t2', unique_id: 'u2', tray_number: 2 }] }],
    external_spools: [{ entity_id: 'sensor.ext', unique_id: 'uext', tray_number: 0 }],
  }] as unknown as HAPrinter[];

  it('labels AMS trays and external slots by entity or unique id', () => {
    expect(describeTray(printers, 'sensor.t2')).toBe('X1C · AMS 1 Tray 2');
    expect(describeTray(printers, 'u2')).toBe('X1C · AMS 1 Tray 2');
    expect(describeTray(printers, 'sensor.ext')).toBe('X1C · External');
  });

  it('falls back to the id', () => {
    expect(describeTray(printers, 'sensor.unknown')).toBe('sensor.unknown');
  });
});

describe('buildUnmatchedUsageNotification', () => {
  it('names the tray and the grams, with its own tag', () => {
    const n = buildUnmatchedUsageNotification('x1c_ams_128_tray_1', 'X1C · AMS HT Tray 1', 154.73, 'http://ha:3000');
    expect(n.title).toBe('X1C · AMS HT Tray 1: 154.7 g not deducted');
    const data = n.data as { tag: string; url?: string };
    expect(data.tag).toBe('spoolmansync-x1c_ams_128_tray_1-usage');
    expect(data.url).toBe('http://ha:3000/');
  });

  it('omits the link without a base URL', () => {
    const n = buildUnmatchedUsageNotification('t', 'T', 1, '');
    expect((n.data as { url?: string }).url).toBeUndefined();
  });
});
