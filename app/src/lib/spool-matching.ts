/**
 * Candidate matching for trays that report filament but no recognised spool:
 * third-party spools (no RFID at all) and Bambu spools whose serial SpoolmanSync
 * has not learned yet.
 *
 * Pure functions only — no I/O — so the ranking and the auto-assign rule can be
 * tested without Spoolman or Home Assistant.
 */
import type { Spool } from '@/lib/api/spoolman';
import { normalizeHexColor } from '@/lib/tray-mismatch';

/** What the printer reports for the tray being matched. */
export interface TrayReport {
  material: string | undefined | null;
  color: string | undefined | null;
  /** True when the tray reports a valid spool serial (a Bambu RFID spool). */
  hasSerial: boolean;
}

export interface SpoolCandidate {
  spool: Spool;
  /** CIE76 colour difference to the tray colour; null when either colour is unknown. */
  deltaE: number | null;
}

/**
 * Colour difference (CIE76) up to which a spool is offered at all. Generous on
 * purpose: the tray colour is whatever was picked from the slicer's palette, so
 * a "green" tray sits ΔE 15–40 from real green spools. Auto-assign is far
 * stricter (below).
 */
export const DEFAULT_MAX_DELTA_E = 45;
/** Auto-assign only below this difference… */
export const DEFAULT_CONFIDENT_DELTA_E = 10;
/** …and only when the runner-up is at least this much further away. */
export const DEFAULT_CONFIDENT_GAP = 15;

/** Base materials that vendors prefix with a product line ("E-PLA", "HT-PLA"). */
const PREFIXABLE_BASES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PP', 'PVA', 'HIPS'];

/**
 * The material family used for candidate filtering. Looser than the mismatch
 * warning's baseMaterialToken: a vendor product-line prefix is dropped
 * ("E-PLA", "X-PLA", "HT-PLA" → "PLA"), while a suffix is kept because it is a
 * genuinely different filament ("PLA-CF", "PETG-CF" stay distinct).
 */
export function materialFamily(material: string | undefined | null): string {
  const token = (material || '')
    .toUpperCase()
    .trim()
    .split(/[\s_]+/)[0]
    .replace(/\+$/, '');
  const prefixed = /^[A-Z0-9]+-([A-Z]+)$/.exec(token);
  if (prefixed && PREFIXABLE_BASES.includes(prefixed[1])) return prefixed[1];
  return token;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB hex (6 or 8 chars, with or without '#') → CIE L*a*b* (D65). */
export function hexToLab(color: string | undefined | null): [number, number, number] | null {
  const hex = normalizeHexColor(color);
  if (!hex) return null;
  const r = srgbToLinear(parseInt(hex.slice(0, 2), 16));
  const g = srgbToLinear(parseInt(hex.slice(2, 4), 16));
  const b = srgbToLinear(parseInt(hex.slice(4, 6), 16));

  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Perceptual colour difference (CIE76 ΔE); null when either colour is unknown. */
export function colorDeltaE(a: string | undefined | null, b: string | undefined | null): number | null {
  const la = hexToLab(a);
  const lb = hexToLab(b);
  if (!la || !lb) return null;
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

function decodeExtra(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return '';
  }
}

function isBambuVendor(spool: Spool): boolean {
  return /bambu/i.test(spool.filament?.vendor?.name || '');
}

function hasBeenUsed(spool: Spool): boolean {
  return (spool.used_weight ?? 0) > 0 || !!spool.first_used;
}

/**
 * Spools that could be the one just loaded, best first.
 *
 * Excluded: archived and empty spools, spools already assigned to a tray, and
 * spools of another material family. For a tray reporting a serial, only Bambu
 * spools without a learned serial qualify (anything else would have matched or
 * cannot carry that tag). Spools whose colour is too far off are dropped; spools
 * with no colour on either side are kept but ranked last.
 *
 * Ranking: closest colour, then opened spools before sealed ones, then most
 * recently used.
 */
export function findSpoolCandidates(
  spools: Spool[],
  tray: TrayReport,
  maxDeltaE: number = DEFAULT_MAX_DELTA_E,
): SpoolCandidate[] {
  const family = materialFamily(tray.material);
  if (!family) return [];

  const candidates: SpoolCandidate[] = [];
  for (const spool of spools) {
    if (spool.archived) continue;
    if ((spool.remaining_weight ?? 0) <= 0) continue;
    if (decodeExtra(spool.extra?.['active_tray'])) continue;
    if (materialFamily(spool.filament?.material) !== family) continue;
    if (tray.hasSerial && (!isBambuVendor(spool) || decodeExtra(spool.extra?.['tag']))) continue;

    const deltaE = colorDeltaE(tray.color, spool.filament?.color_hex);
    if (deltaE !== null && deltaE > maxDeltaE) continue;
    candidates.push({ spool, deltaE });
  }

  return candidates.sort((a, b) => {
    const da = a.deltaE ?? Number.POSITIVE_INFINITY;
    const db = b.deltaE ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const ua = hasBeenUsed(a.spool) ? 0 : 1;
    const ub = hasBeenUsed(b.spool) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return (b.spool.last_used || '').localeCompare(a.spool.last_used || '');
  });
}

/**
 * The candidate to auto-assign, or null to ask instead.
 *
 * Confident means: the best candidate's colour is within `confidentDeltaE`, and
 * every other candidate is at least `minGap` further away (or there is no other
 * candidate). Unknown colours are never confident.
 */
export function pickConfidentCandidate(
  candidates: SpoolCandidate[],
  confidentDeltaE: number = DEFAULT_CONFIDENT_DELTA_E,
  minGap: number = DEFAULT_CONFIDENT_GAP,
): Spool | null {
  const [best, runnerUp] = candidates;
  if (!best || best.deltaE === null || best.deltaE > confidentDeltaE) return null;
  if (!runnerUp) return best.spool;
  if (runnerUp.deltaE === null) return null;
  return runnerUp.deltaE - best.deltaE >= minGap ? best.spool : null;
}
