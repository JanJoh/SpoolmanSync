import { describe, it, expect } from 'vitest';
import { classifyTrayState, lengthToWeight, isValidTrayUuid, isActivePrintState, isPhantomSerialReport, isExternalSpoolTray, liveReportsEmpty, MATERIAL_DENSITY } from './webhook-helpers';

describe('classifyTrayState (issue #65 — never clear on transient states)', () => {
  it('treats unavailable/unknown/missing as transient (must NOT clear assignment)', () => {
    expect(classifyTrayState(undefined)).toBe('transient');
    expect(classifyTrayState(null)).toBe('transient');
    expect(classifyTrayState('unavailable')).toBe('transient');
    expect(classifyTrayState('unknown')).toBe('transient');
    expect(classifyTrayState('Unavailable')).toBe('transient'); // case-insensitive
    expect(classifyTrayState('?')).toBe('transient'); // AMS still reading the RFID tag
    expect(classifyTrayState('UNKNOWN')).toBe('transient');
  });

  it('treats literal Empty and blank name as empty', () => {
    expect(classifyTrayState('Empty')).toBe('empty');
    expect(classifyTrayState('empty')).toBe('empty');
    expect(classifyTrayState('')).toBe('empty'); // Creality empty slot
  });

  it('treats a real filament name as present', () => {
    expect(classifyTrayState('PLA')).toBe('present');
    expect(classifyTrayState('Matte Dark Blue')).toBe('present');
    expect(classifyTrayState('PETG-CF')).toBe('present');
  });
});

describe('lengthToWeight (Creality cm → g conversion)', () => {
  it('converts using PLA density by default', () => {
    // volume = π * 0.0875^2 * 100 = 2.40528 cm³; * 1.24 = 2.9825 g
    expect(lengthToWeight(100)).toBeCloseTo(2.9825, 3);
    expect(lengthToWeight(100, 'PLA')).toBeCloseTo(2.9825, 3);
  });

  it('uses material-specific density', () => {
    expect(lengthToWeight(100, 'ABS')).toBeCloseTo(2.40528 * MATERIAL_DENSITY.ABS, 3);
    // denser material → heavier for same length
    expect(lengthToWeight(100, 'PETG')).toBeGreaterThan(lengthToWeight(100, 'ABS'));
  });

  it('is case-insensitive and falls back to PLA for unknown materials', () => {
    expect(lengthToWeight(50, 'pla')).toBeCloseTo(lengthToWeight(50, 'PLA'), 6);
    expect(lengthToWeight(50, 'WoodFill')).toBeCloseTo(lengthToWeight(50, 'PLA'), 6);
  });

  it('scales linearly with length and is zero at zero', () => {
    expect(lengthToWeight(0)).toBe(0);
    expect(lengthToWeight(200)).toBeCloseTo(2 * lengthToWeight(100), 6);
  });
});

describe('isValidTrayUuid', () => {
  it('rejects empty / unknown / all-zero ids (non-Bambu spools)', () => {
    expect(isValidTrayUuid(undefined)).toBe(false);
    expect(isValidTrayUuid(null)).toBe(false);
    expect(isValidTrayUuid('')).toBe(false);
    expect(isValidTrayUuid('unknown')).toBe(false);
    expect(isValidTrayUuid('0000000000000000')).toBe(false);
  });

  it('accepts a real serial', () => {
    expect(isValidTrayUuid('A1B2C3D4')).toBe(true);
    expect(isValidTrayUuid('0000A0000')).toBe(true); // not all zeros
  });
});

describe('isActivePrintState', () => {
  it('treats terminal/unknown states as inactive', () => {
    for (const state of [undefined, null, '', 'idle', 'finished', 'completed', 'complete', 'offline', 'off', 'none', 'unknown', 'unavailable']) {
      expect(isActivePrintState(state)).toBe(false);
    }
  });

  it('treats printing/pausing style states as active', () => {
    for (const state of ['printing', 'running', 'paused', 'pause', 'prepare', 'slicing', 'auto_bed_leveling']) {
      expect(isActivePrintState(state)).toBe(true);
    }
  });
});

describe('isPhantomSerialReport', () => {
  const uuid = 'FD62C5377B0A407FA1E42EFD2F88AD63';

  it('rejects a serial on a slot that flags itself empty', () => {
    expect(isPhantomSerialReport(uuid, { attributes: { empty: true, tray_uuid: uuid } })).toBe(true);
  });

  it('rejects a serial that has already reverted in live state', () => {
    expect(isPhantomSerialReport(uuid, { attributes: { empty: false, tray_uuid: '00000000000000000000000000000000' } })).toBe(true);
  });

  it('accepts a serial that is still present on a loaded slot', () => {
    expect(isPhantomSerialReport(uuid, { attributes: { empty: false, tray_uuid: uuid.toLowerCase() } })).toBe(false);
  });

  it('fails open without live state or without the attributes', () => {
    expect(isPhantomSerialReport(uuid, null)).toBe(false);
    expect(isPhantomSerialReport(uuid, { attributes: {} })).toBe(false);
  });
});

describe('isExternalSpoolTray', () => {
  it('recognises external spool unique ids and entity ids', () => {
    expect(isExternalSpoolTray('X1C_00M09D482103405_ExternalSpool_external_spool')).toBe(true);
    expect(isExternalSpoolTray('sensor.x1c_00m09d482103405_externalspool_external_spool')).toBe(true);
  });

  it('does not match AMS trays', () => {
    expect(isExternalSpoolTray('X1C_00M09D482103405_AMS_19F06A580300880_tray_1')).toBe(false);
    expect(isExternalSpoolTray('')).toBe(false);
  });
});

describe('liveReportsEmpty', () => {
  it('is true when the slot flags itself empty, even with a filament profile', () => {
    expect(liveReportsEmpty({ attributes: { empty: true, name: 'Bambu PETG-CF', type: 'PETG-CF' } })).toBe(true);
  });

  it('is false for a loaded slot', () => {
    expect(liveReportsEmpty({ attributes: { empty: false, name: 'Bambu PETG-CF' } })).toBe(false);
  });

  it('fails open without live state', () => {
    expect(liveReportsEmpty(null)).toBe(false);
    expect(liveReportsEmpty({})).toBe(false);
  });
});
