import { describe, it, expect } from 'vitest';
import type { Spool } from './api/spoolman';
import {
  materialFamily,
  colorDeltaE,
  findSpoolCandidates,
  pickConfidentCandidate,
} from './spool-matching';

let nextId = 1;
function spool(over: {
  id?: number;
  material?: string;
  color?: string | null;
  vendor?: string;
  remaining?: number;
  used?: number;
  lastUsed?: string;
  archived?: boolean;
  extra?: Record<string, string>;
}): Spool {
  return {
    id: over.id ?? nextId++,
    filament: {
      id: 1,
      name: 'Test',
      material: over.material ?? 'PLA',
      color_hex: over.color === null ? undefined : (over.color ?? 'ffffff'),
      vendor: { id: 1, name: over.vendor ?? 'Generic' },
    },
    remaining_weight: over.remaining ?? 500,
    used_weight: over.used ?? 0,
    initial_weight: 1000,
    registered: '2025-01-01T00:00:00Z',
    last_used: over.lastUsed,
    extra: over.extra ?? {},
    archived: over.archived ?? false,
  } as unknown as Spool;
}

describe('materialFamily', () => {
  it('drops vendor product-line prefixes', () => {
    expect(materialFamily('E-PLA')).toBe('PLA');
    expect(materialFamily('X-PLA')).toBe('PLA');
    expect(materialFamily('HT-PLA')).toBe('PLA');
  });

  it('keeps compound suffixes distinct', () => {
    expect(materialFamily('PLA-CF')).toBe('PLA-CF');
    expect(materialFamily('PETG-CF')).toBe('PETG-CF');
  });

  it('normalises case, finish words and a trailing plus', () => {
    expect(materialFamily('pla matte')).toBe('PLA');
    expect(materialFamily('PLA+')).toBe('PLA');
    expect(materialFamily('PLA_Basic')).toBe('PLA');
  });

  it('is empty for no material', () => {
    expect(materialFamily('')).toBe('');
    expect(materialFamily(undefined)).toBe('');
  });
});

describe('colorDeltaE', () => {
  it('is 0 for the same colour in any notation', () => {
    expect(colorDeltaE('#057748FF', '057748')).toBeCloseTo(0, 5);
  });

  it('is small for near colours and large for different ones', () => {
    expect(colorDeltaE('ffffff', 'fffaf2')!).toBeLessThan(5);
    expect(colorDeltaE('ffffff', '000000')!).toBeGreaterThan(90);
  });

  it('is null when a colour is unknown', () => {
    expect(colorDeltaE('ffffff', undefined)).toBeNull();
    expect(colorDeltaE('nonsense', 'ffffff')).toBeNull();
  });
});

describe('findSpoolCandidates', () => {
  const tray = { material: 'PLA', color: '#057748FF', hasSerial: false };

  it('keeps same-family spools of a similar colour, closest first', () => {
    // Real pair: a palette green against Add:North Green, ΔE ≈ 38.
    const close = spool({ material: 'PLA', color: '0C8C01' });
    const exact = spool({ material: 'E-PLA', color: '057748' });
    const result = findSpoolCandidates([close, exact], tray);
    expect(result.map(c => c.spool.id)).toEqual([exact.id, close.id]);
  });

  it('drops other materials, far colours, archived, empty and assigned spools', () => {
    const spools = [
      spool({ material: 'PETG', color: '057748' }),
      spool({ material: 'PLA', color: 'ff0000' }),
      spool({ material: 'PLA', color: '03CF1E' }), // bright green, ΔE ≈ 65
      spool({ material: 'PLA', color: '057748', archived: true }),
      spool({ material: 'PLA', color: '057748', remaining: 0 }),
      spool({ material: 'PLA', color: '057748', extra: { active_tray: JSON.stringify('other_tray') } }),
    ];
    expect(findSpoolCandidates(spools, tray)).toEqual([]);
  });

  it('keeps a spool whose assignment was cleared', () => {
    const s = spool({ material: 'PLA', color: '057748', extra: { active_tray: JSON.stringify('') } });
    expect(findSpoolCandidates([s], tray)).toHaveLength(1);
  });

  it('keeps colourless spools, ranked last', () => {
    const noColour = spool({ material: 'PLA', color: null });
    const coloured = spool({ material: 'PLA', color: '057748' });
    const result = findSpoolCandidates([noColour, coloured], tray);
    expect(result.map(c => c.spool.id)).toEqual([coloured.id, noColour.id]);
    expect(result[1].deltaE).toBeNull();
  });

  it('prefers opened spools, then the most recently used, on a colour tie', () => {
    const sealed = spool({ color: '057748' });
    const older = spool({ color: '057748', used: 10, lastUsed: '2026-01-01T00:00:00Z' });
    const newer = spool({ color: '057748', used: 10, lastUsed: '2026-10-01T00:00:00Z' });
    const result = findSpoolCandidates([sealed, older, newer], tray);
    expect(result.map(c => c.spool.id)).toEqual([newer.id, older.id, sealed.id]);
  });

  it('for a tray reporting a serial, only offers Bambu spools without one', () => {
    const bambu = spool({ vendor: 'Bambu Lab', color: '057748' });
    const tagged = spool({ vendor: 'Bambu Lab', color: '057748', extra: { tag: JSON.stringify('ABC') } });
    const other = spool({ vendor: 'Add:North', color: '057748' });
    const result = findSpoolCandidates([bambu, tagged, other], { ...tray, hasSerial: true });
    expect(result.map(c => c.spool.id)).toEqual([bambu.id]);
  });

  it('returns nothing when the tray reports no material', () => {
    expect(findSpoolCandidates([spool({})], { material: '', color: 'ffffff', hasSerial: false })).toEqual([]);
  });
});

describe('pickConfidentCandidate', () => {
  const c = (deltaE: number | null) => ({ spool: spool({}), deltaE });

  it('picks a close, lone candidate', () => {
    const only = c(3);
    expect(pickConfidentCandidate([only])).toBe(only.spool);
  });

  it('picks the best when the runner-up is clearly further away', () => {
    const best = c(3);
    expect(pickConfidentCandidate([best, c(20)])).toBe(best.spool);
  });

  it('asks when two candidates are close together', () => {
    expect(pickConfidentCandidate([c(3), c(8)])).toBeNull();
  });

  it('asks when the best is not close enough', () => {
    expect(pickConfidentCandidate([c(12)])).toBeNull();
  });

  it('asks when a colour is unknown', () => {
    expect(pickConfidentCandidate([c(null)])).toBeNull();
    expect(pickConfidentCandidate([c(3), c(null)])).toBeNull();
  });

  it('asks when there are no candidates', () => {
    expect(pickConfidentCandidate([])).toBeNull();
  });
});
