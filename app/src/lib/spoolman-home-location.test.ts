import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpoolmanClient, HOME_LOCATION_FIELD } from './api/spoolman';

/**
 * Behavioral tests for return-to-home: assignSpoolToTray saves the spool's own
 * location to the home_location extra field, unassignSpoolFromTray restores it.
 * We stub global fetch and inspect the PATCH bodies.
 */

type FetchCall = { url: string; method: string; body: Record<string, unknown> | null };

function installFetch(spool: Record<string, unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  const handler = vi.fn(async (url: string, opts: RequestInit = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body as string) : null;
    calls.push({ url, method, body });
    if (method === 'GET' && /\/spool(\?.*)?$/.test(url)) {
      return { ok: true, json: async () => [] } as unknown as Response;
    }
    return { ok: true, json: async () => spool } as unknown as Response;
  });
  vi.stubGlobal('fetch', handler);
  return calls;
}

const patchBody = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === 'PATCH').pop()?.body ?? null;
const extraOf = (body: Record<string, unknown>) => body.extra as Record<string, string>;

const TRAY_A = 'x1c_ABC_tray_1';
const TRAY_B = 'x1c_ABC_tray_2';
const labels: Record<string, string> = {
  [TRAY_A]: 'X1C - AMS 1 Tray 1',
  [TRAY_B]: 'X1C - AMS 1 Tray 2',
};

function makeClient(opts: { home?: boolean; pen?: string } = {}) {
  const client = new SpoolmanClient('http://spoolman');
  client.setLocationResolver(async (key) => labels[key] ?? '');
  client.setReturnToHomeLocation(opts.home ?? true);
  if (opts.pen) client.setUnassignedLocation(opts.pen);
  return client;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('assignSpoolToTray — saving the home location', () => {
  it('saves the current shelf as home and writes the tray label', async () => {
    const calls = installFetch({ id: 1, extra: {}, location: 'Shelf 2' });
    await makeClient().assignSpoolToTray(1, TRAY_A);

    const body = patchBody(calls)!;
    expect(body.location).toBe(labels[TRAY_A]);
    expect(extraOf(body)[HOME_LOCATION_FIELD]).toBe(JSON.stringify('Shelf 2'));
  });

  it('keeps the saved home when moving between trays', async () => {
    const calls = installFetch({
      id: 1,
      extra: { active_tray: JSON.stringify(TRAY_A), [HOME_LOCATION_FIELD]: JSON.stringify('Shelf 2') },
      location: labels[TRAY_A],
    });
    await makeClient().assignSpoolToTray(1, TRAY_B);

    const body = patchBody(calls)!;
    expect(body.location).toBe(labels[TRAY_B]);
    expect(extraOf(body)[HOME_LOCATION_FIELD]).toBe(JSON.stringify('Shelf 2'));
  });

  it('does not save the holding pen as home', async () => {
    const calls = installFetch({
      id: 1,
      extra: { [HOME_LOCATION_FIELD]: JSON.stringify('Shelf 2') },
      location: 'To sort',
    });
    await makeClient({ pen: 'To sort' }).assignSpoolToTray(1, TRAY_A);

    expect(extraOf(patchBody(calls)!)[HOME_LOCATION_FIELD]).toBe(JSON.stringify('Shelf 2'));
  });

  it('does not save an empty location', async () => {
    const calls = installFetch({ id: 1, extra: {} });
    await makeClient().assignSpoolToTray(1, TRAY_A);

    expect(HOME_LOCATION_FIELD in extraOf(patchBody(calls)!)).toBe(false);
  });

  it('does nothing extra when the setting is off', async () => {
    const calls = installFetch({ id: 1, extra: {}, location: 'Shelf 2' });
    await makeClient({ home: false }).assignSpoolToTray(1, TRAY_A);

    const body = patchBody(calls)!;
    expect(body.location).toBe(labels[TRAY_A]);
    expect(HOME_LOCATION_FIELD in extraOf(body)).toBe(false);
  });

  it('is inert without a resolver (location sync off)', async () => {
    const calls = installFetch({ id: 1, extra: {}, location: 'Shelf 2' });
    const client = new SpoolmanClient('http://spoolman');
    client.setReturnToHomeLocation(true);
    await client.assignSpoolToTray(1, TRAY_A);

    const body = patchBody(calls)!;
    expect('location' in body).toBe(false);
    expect(HOME_LOCATION_FIELD in extraOf(body)).toBe(false);
  });
});

describe('unassignSpoolFromTray — restoring the home location', () => {
  const inTrayA = (home?: string) => ({
    id: 1,
    extra: {
      active_tray: JSON.stringify(TRAY_A),
      ...(home !== undefined && { [HOME_LOCATION_FIELD]: JSON.stringify(home) }),
    },
    location: labels[TRAY_A],
  });

  it('restores the saved home, ahead of the holding pen', async () => {
    const calls = installFetch(inTrayA('Shelf 2'));
    await makeClient({ pen: 'To sort' }).unassignSpoolFromTray(1);

    expect(patchBody(calls)!.location).toBe('Shelf 2');
  });

  it('keeps the home field after restoring, for the next round trip', async () => {
    const calls = installFetch(inTrayA('Shelf 2'));
    await makeClient().unassignSpoolFromTray(1);

    expect(extraOf(patchBody(calls)!)[HOME_LOCATION_FIELD]).toBe(JSON.stringify('Shelf 2'));
  });

  it('falls back to the holding pen when no home is saved', async () => {
    const calls = installFetch(inTrayA());
    await makeClient({ pen: 'To sort' }).unassignSpoolFromTray(1);

    expect(patchBody(calls)!.location).toBe('To sort');
  });

  it('falls back to clearing when neither home nor holding pen is set', async () => {
    const calls = installFetch(inTrayA(''));
    await makeClient().unassignSpoolFromTray(1);

    expect(patchBody(calls)!.location).toBeNull();
  });

  it('ignores a saved home when the setting is off', async () => {
    const calls = installFetch(inTrayA('Shelf 2'));
    await makeClient({ home: false, pen: 'To sort' }).unassignSpoolFromTray(1);

    expect(patchBody(calls)!.location).toBe('To sort');
  });

  it('never overwrites a location the user set by hand', async () => {
    const calls = installFetch({ ...inTrayA('Shelf 2'), location: 'On my desk' });
    await makeClient().unassignSpoolFromTray(1);

    expect('location' in patchBody(calls)!).toBe(false);
  });

  it('ignores a malformed home value', async () => {
    const spool = inTrayA();
    (spool.extra as Record<string, string>)[HOME_LOCATION_FIELD] = 'not json';
    const calls = installFetch(spool);
    await makeClient({ pen: 'To sort' }).unassignSpoolFromTray(1);

    expect(patchBody(calls)!.location).toBe('To sort');
  });
});
