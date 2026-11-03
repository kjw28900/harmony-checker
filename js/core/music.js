import { CONFIG } from './config.js';
import { CORE_COPY } from '../copy.ko.js';

export const NOTE_NAMES = CORE_COPY.noteNames;
const INTERVAL_NAMES = CORE_COPY.intervalNames;
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const JUST_OFFSETS = Object.freeze({ 3: 15.6, 4: -13.7, 5: -2, 7: 2, 8: 13.7, 9: -15.6 });
export const frequencyToMidi = frequency => frequency > 0 ? 69 + 12 * Math.log2(frequency / 440) : null;
export const midiToFrequency = midi => 440 * 2 ** ((midi - 69) / 12);
export const centsBetween = (reference, own) => reference > 0 && own > 0 ? 1200 * Math.log2(own / reference) : null;
export const pitchClass = midi => ((Math.round(midi) % 12) + 12) % 12;
export function noteName(midi) {
  if (!Number.isFinite(midi)) return CORE_COPY.missingNote;
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[pitchClass(rounded)]}${Math.floor(rounded / 12) - 1}`;
}
export function intervalName(semitones) {
  if (!Number.isFinite(semitones)) return CORE_COPY.unknown;
  const value = Math.abs(Math.round(semitones)), octaves = Math.floor(value / 12), rest = value % 12;
  if (value === 0) return INTERVAL_NAMES[0];
  const direction = semitones < 0 ? CORE_COPY.below : CORE_COPY.above;
  const label = octaves ? CORE_COPY.compoundInterval(octaves, rest ? INTERVAL_NAMES[rest] : '') : INTERVAL_NAMES[rest];
  return `${label} ${direction}`;
}
export function classifyDeviation(cents) {
  if (!Number.isFinite(cents)) return 'unknown';
  const magnitude = Math.abs(cents);
  return magnitude <= CONFIG.inTuneCents + CONFIG.centsBoundaryEpsilon ? 'good' : magnitude <= CONFIG.nearCents + CONFIG.centsBoundaryEpsilon ? 'near' : 'off';
}
export function consonance(semitones) {
  const value = Math.abs(Math.round(semitones)) % 12;
  if ([0, 7].includes(value)) return 'perfect';
  if ([3, 4, 8, 9].includes(value)) return 'imperfect';
  if (value === 5) return 'context';
  return 'dissonant';
}
function correlation(a, b) {
  const ma = a.reduce((s, n) => s + n, 0) / a.length;
  const mb = b.reduce((s, n) => s + n, 0) / b.length;
  let top = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; top += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? top / Math.sqrt(aa * bb) : 0;
}
export function estimateKey(frames) {
  const histogram = Array(12).fill(0);
  for (const frame of frames) if (frame.voiced && Number.isFinite(frame.midi)) histogram[pitchClass(frame.midi)] += Math.max(0, frame.confidence || 0);
  const max = Math.max(...histogram);
  const distinct = histogram.filter(n => n > max * 0.04 && n > 0).length;
  const candidates = [];
  for (let root = 0; root < 12; root++) for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
    const rotated = histogram.map((_, i) => profile[(i - root + 12) % 12]);
    candidates.push({ root, mode, correlation: correlation(histogram, rotated) });
  }
  candidates.sort((a, b) => b.correlation - a.correlation);
  const best = candidates[0], margin = best.correlation - candidates[1].correlation;
  const confident = distinct >= CONFIG.keyMinDistinctNotes && best.correlation >= CONFIG.keyMinCorrelation && margin >= CONFIG.keyMinMargin;
  const scale = best.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return { ...best, margin, distinct, confident, name: confident ? CORE_COPY.keyName(NOTE_NAMES[best.root], best.mode) : CORE_COPY.unknownKey, scale: scale.map(n => (n + best.root) % 12), histogram };
}
