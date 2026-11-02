import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Spool } from './api/spoolman';

/**
 * The assign-prompt flow end to end, with an in-memory settings table and stub
 * Spoolman / Home Assistant clients.
 */

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@/lib/db', () => {
  const settings = {
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
      store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null),
    findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
      where.key.in.filter(k => store.has(k)).map(k => ({ key: k, value: store.get(k)! }))),
    upsert: vi.fn(async ({ where, create, update }: {
      where: { key: string }; create: { value: string }; update: { value: string };
    }) => {
      store.set(where.key, store.has(where.key) ? update.value : create.value);
    }),
  };
  const prisma = { settings };
  return { default: prisma, prisma };
});

const { handleUnidentifiedTray, applyAssignChoice, resolvePendingOnManualAssign } = await import('./assign-prompt-flow');
const { listPendingTrays, pruneExpired, isSameLoad } = await import('./pending-trays');
const { assignActionId } = await import('./assign-prompt');

function spool(id: number, color: string, extra: Record<string, string> = {}, vendor = 'Add:North'): Spool {
  return {
    id,
    filament: { id, name: `Spool ${id}`, material: 'PLA', color_hex: color, vendor: { id: 1, name: vendor } },
    remaining_weight: 500,
    used_weight: 0,
    initial_weight: 1000,
    registered: '2025-01-01T00:00:00Z',
    extra,
    archived: false,
  } as unknown as Spool;
}

function stubClient(spools: Spool[]) {
  return {
    assignSpoolToTray: vi.fn(async () => ({})),
    setSpoolTag: vi.fn(async () => ({})),
    getSpool: vi.fn(async (id: number) => {
      const s = spools.find(x => x.id === id);
      if (!s) throw new Error('404');
      return s;
    }),
  };
}

function stubHa() {
  return { callService: vi.fn(async () => undefined) };
}

const settings = (over: Partial<{ enabled: boolean; autoAssign: boolean; notifyService: string }> = {}) => ({
  enabled: true,
  autoAssign: true,
  notifyService: 'mobile_app_phone',
  baseUrl: 'http://ha:3000',
  ...over,
});

const tray = (over: Partial<{ color: string; traySerial: string }> = {}) => ({
  trayId: 'x1c_tray_2',
  entityId: 'sensor.x1c_tray_2',
  label: 'X1C · AMS 1 Tray 2',
  material: 'PLA',
  color: '#057748FF',
  traySerial: '',
  ...over,
});

beforeEach(() => store.clear());

describe('handleUnidentifiedTray', () => {
  it('does nothing while the feature is off', async () => {
    const client = stubClient([]);
    const out = await handleUnidentifiedTray(client as never, [], tray(), settings({ enabled: false }), null);
    expect(out.action).toBe('disabled');
    expect(client.assignSpoolToTray).not.toHaveBeenCalled();
  });

  it('assigns a confident match and tells the phone', async () => {
    const exact = spool(24, '057748');
    const client = stubClient([exact]);
    const ha = stubHa();

    const out = await handleUnidentifiedTray(client as never, [exact, spool(5, 'ff0000')], tray(), settings(), ha as never);

    expect(out.action).toBe('auto_assigned');
    expect(client.assignSpoolToTray).toHaveBeenCalledWith(24, 'x1c_tray_2');
    expect(client.setSpoolTag).not.toHaveBeenCalled();
    expect(ha.callService).toHaveBeenCalledWith('notify', 'mobile_app_phone', expect.objectContaining({
      title: 'X1C · AMS 1 Tray 2: #24 Add:North Spool 24',
    }));
    expect(await listPendingTrays()).toEqual([]);
  });

  it('asks instead when auto-assign is off', async () => {
    const client = stubClient([]);
    const out = await handleUnidentifiedTray(client as never, [spool(24, '057748')], tray(), settings({ autoAssign: false }), null);
    expect(out.action).toBe('prompted');
    expect(client.assignSpoolToTray).not.toHaveBeenCalled();
  });

  it('records a pending tray and asks with a button per candidate when unsure', async () => {
    const a = spool(4, '277316');
    const b = spool(75, '3F8E43');
    const client = stubClient([a, b]);
    const ha = stubHa();

    const out = await handleUnidentifiedTray(client as never, [a, b], tray(), settings(), ha as never);

    expect(out.action).toBe('prompted');
    const [pending] = await listPendingTrays();
    expect(pending.trayId).toBe('x1c_tray_2');
    expect(pending.candidateIds).toEqual([75, 4]);

    const sent = (ha.callService.mock.calls[0] as unknown[])[2] as { data: { actions: Array<{ action: string }> } };
    expect(sent.data.actions.map(x => x.action)).toEqual([
      assignActionId(pending.id, 75),
      assignActionId(pending.id, 4),
      'URI',
    ]);
  });

  it('does not ask again for the same load', async () => {
    const spools = [spool(4, '277316'), spool(75, '3F8E43')];
    const ha = stubHa();
    await handleUnidentifiedTray(stubClient(spools) as never, spools, tray(), settings(), ha as never);
    const again = await handleUnidentifiedTray(stubClient(spools) as never, spools, tray(), settings(), ha as never);

    expect(again.action).toBe('already_pending');
    expect(ha.callService).toHaveBeenCalledTimes(1);
  });

  it('asks again when a different spool is loaded', async () => {
    const spools = [spool(4, '277316'), spool(75, '3F8E43')];
    const ha = stubHa();
    await handleUnidentifiedTray(stubClient(spools) as never, spools, tray(), settings(), ha as never);
    const again = await handleUnidentifiedTray(stubClient(spools) as never, spools, tray({ color: '#FFFFFFFF' }), settings(), ha as never);

    expect(again.action).toBe('prompted');
    expect(await listPendingTrays()).toHaveLength(1);
  });

  it('learns the serial when a Bambu spool is matched', async () => {
    const bambu = spool(53, '000000', {}, 'Bambu Lab');
    const client = stubClient([bambu]);
    await handleUnidentifiedTray(client as never, [bambu], tray({ color: '#000000FF', traySerial: 'SERIAL1' }), settings(), null);
    expect(client.assignSpoolToTray).toHaveBeenCalledWith(53, 'x1c_tray_2');
    expect(client.setSpoolTag).toHaveBeenCalledWith(53, 'SERIAL1');
  });
});

describe('applyAssignChoice', () => {
  async function promptFor(spools: Spool[], traySerial = '') {
    await handleUnidentifiedTray(stubClient(spools) as never, spools, tray({ traySerial }), settings(), null);
    return (await listPendingTrays())[0];
  }

  it('assigns the chosen spool, learns the serial and withdraws the question', async () => {
    const spools = [spool(4, '277316', {}, 'Bambu Lab'), spool(75, '3F8E43', {}, 'Bambu Lab')];
    const pending = await promptFor(spools, 'SERIAL2');
    const client = stubClient(spools);
    const ha = stubHa();

    const out = await applyAssignChoice(client as never, assignActionId(pending.id, 4), settings(), ha as never);

    expect(out.status).toBe('assigned');
    expect(client.assignSpoolToTray).toHaveBeenCalledWith(4, 'x1c_tray_2');
    expect(client.setSpoolTag).toHaveBeenCalledWith(4, 'SERIAL2');
    expect(ha.callService).toHaveBeenCalledWith('notify', 'mobile_app_phone', {
      message: 'clear_notification',
      data: { tag: 'spoolmansync-x1c_tray_2' },
    });
    expect(await listPendingTrays()).toEqual([]);
  });

  it('ignores actions that are not ours, expired questions and unknown spools', async () => {
    const spools = [spool(4, '277316'), spool(75, '3F8E43')];
    const pending = await promptFor(spools);
    const client = stubClient(spools);

    expect(await applyAssignChoice(client as never, 'URI', settings(), null)).toEqual({ status: 'ignored', reason: 'not_ours' });
    expect(await applyAssignChoice(client as never, assignActionId('gone', 4), settings(), null)).toEqual({ status: 'ignored', reason: 'expired' });
    expect(await applyAssignChoice(client as never, assignActionId(pending.id, 999), settings(), null)).toEqual({ status: 'ignored', reason: 'unknown_spool' });
    expect(client.assignSpoolToTray).not.toHaveBeenCalled();
  });
});

describe('resolvePendingOnManualAssign', () => {
  it('finishes a pending tray assigned from the sticker / label page', async () => {
    const spools = [spool(4, '277316', {}, 'Bambu Lab'), spool(75, '3F8E43', {}, 'Bambu Lab')];
    await handleUnidentifiedTray(stubClient(spools) as never, spools, tray({ traySerial: 'SERIAL3' }), settings(), null);
    const client = stubClient(spools);

    const resolved = await resolvePendingOnManualAssign(client as never, 75, 'x1c_tray_2', settings(), null);

    expect(resolved?.trayId).toBe('x1c_tray_2');
    expect(client.setSpoolTag).toHaveBeenCalledWith(75, 'SERIAL3');
    expect(await listPendingTrays()).toEqual([]);
  });

  it('is a no-op for a tray that was not pending', async () => {
    const client = stubClient([]);
    expect(await resolvePendingOnManualAssign(client as never, 1, 'other_tray', settings(), null)).toBeNull();
    expect(client.setSpoolTag).not.toHaveBeenCalled();
  });
});

describe('pending trays', () => {
  it('expire after the configured time', async () => {
    const entry = { id: 'a', trayId: 't', entityId: 'e', label: 'l', material: 'PLA', color: '', traySerial: '', candidateIds: [], createdAt: 0 };
    expect(pruneExpired({ t: entry }, 29 * 60_000, 30)).toHaveProperty('t');
    expect(pruneExpired({ t: entry }, 31 * 60_000, 30)).toEqual({});
  });

  it('treat a re-report of the same load as the same, case-insensitively', () => {
    const entry = { id: 'a', trayId: 't', entityId: 'e', label: 'l', material: 'PLA', color: '#ABCDEF', traySerial: '', candidateIds: [], createdAt: 0 };
    expect(isSameLoad(entry, { material: 'PLA', color: '#abcdef', traySerial: '' })).toBe(true);
    expect(isSameLoad(entry, { material: 'PETG', color: '#abcdef', traySerial: '' })).toBe(false);
    expect(isSameLoad(null, { material: 'PLA', color: '#abcdef', traySerial: '' })).toBe(false);
  });
});
