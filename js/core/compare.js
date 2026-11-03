import { CONFIG } from './config.js';
import { CORE_COPY } from '../copy.ko.js';
import { centsBetween, classifyDeviation, consonance, estimateKey, intervalName, JUST_OFFSETS, pitchClass } from './music.js';

export function compareFrames(reference, own) {
  const time = reference?.time ?? own?.time ?? 0;
  const base = { time, reference: reference ?? null, own: own ?? null };
  const validPitch = frame => frame?.voiced && Number.isFinite(frame.frequency) && frame.frequency > 0 && Number.isFinite(frame.confidence) && frame.confidence >= CONFIG.minConfidence && Number.isFinite(frame.rms) && frame.rms >= CONFIG.minRms;
  if (!validPitch(reference) || !validPitch(own)) {
    return { ...base, status: 'unknown', intervalSemitones: null, intervalName: CORE_COPY.unknown, intervalCents: null, deviationCents: null, widthCents: null, direction: null, consonance: null };
  }
  const intervalCents = centsBetween(reference.frequency, own.frequency);
  const intervalSemitones = Math.round(intervalCents / 100) || 0;
  const deviationCents = intervalCents - intervalSemitones * 100;
  // Signed deviation describes own pitch. Width reverses sign below reference.
  const widthCents = deviationCents * (intervalSemitones < 0 ? -1 : 1);
  return { ...base, status: classifyDeviation(deviationCents), intervalSemitones, intervalName: intervalName(intervalSemitones), intervalCents, deviationCents, widthCents, direction: widthCents >= 0 ? CORE_COPY.wider : CORE_COPY.narrower, consonance: consonance(intervalSemitones) };
}

function groupSegments(frames, hop) {
  const groups = [];
  let current = null;
  for (const frame of frames) {
    // Opposite near/off directions must not cancel into a misleading zero-cent
    // segment average. In-tune fluctuations remain one stable segment.
    const direction = ['near', 'off'].includes(frame.status) ? Math.sign(frame.widthCents) : 0;
    const key = `${frame.status}:${frame.intervalSemitones}:${direction}`;
    if (!current || current.key !== key || frame.time - current.lastTime > hop * 1.6) {
      if (current) groups.push(current);
      current = { key, start: Math.max(0, frame.time - hop / 2), end: frame.time + hop / 2, lastTime: frame.time, status: frame.status, intervalSemitones: frame.intervalSemitones, intervalName: frame.intervalName, consonance: frame.consonance, totalDeviation: 0, totalWidth: 0, count: 0 };
    }
    current.end = frame.time + hop / 2; current.lastTime = frame.time;
    current.totalDeviation += frame.deviationCents || 0; current.totalWidth += frame.widthCents || 0; current.count++;
  }
  if (current) groups.push(current);
  return groups.filter(g => g.end - g.start + 1e-8 >= CONFIG.minSegmentSeconds).map(g => ({
    start: g.start, end: g.end, duration: g.end - g.start, status: g.status, intervalSemitones: g.intervalSemitones, intervalName: g.intervalName, consonance: g.consonance,
    deviationCents: g.status === 'unknown' ? null : g.totalDeviation / g.count,
    widthCents: g.status === 'unknown' ? null : g.totalWidth / g.count,
  }));
}

function groupHarmonicSegments(frames, hop) {
  const segments = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const { lastTime, ...segment } = current;
    segments.push({ ...segment, duration: segment.end - segment.start });
    current = null;
  };
  for (const frame of frames) {
    if (frame.status === 'unknown' || !Number.isFinite(frame.intervalSemitones)) { flush(); continue; }
    // Harmony duration concerns the interval itself. Tuning status and deviation
    // direction may fluctuate with vibrato without interrupting that interval.
    if (!current || current.intervalSemitones !== frame.intervalSemitones || frame.time - current.lastTime > hop * 1.6) {
      flush();
      current = { start: Math.max(0, frame.time - hop / 2), end: frame.time + hop / 2, lastTime: frame.time, intervalSemitones: frame.intervalSemitones, intervalName: frame.intervalName, consonance: frame.consonance };
    } else { current.end = frame.time + hop / 2; current.lastTime = frame.time; }
  }
  flush();
  return segments;
}

function summarize(proportions, validFrames, harmony) {
  let tuning;
  if (!validFrames || proportions.unknown >= 0.65) tuning = CORE_COPY.summaryUnknown;
  else if (proportions.good / (1 - proportions.unknown) >= 0.75) tuning = CORE_COPY.summaryGood;
  else if (proportions.off > 0) tuning = CORE_COPY.summaryOff;
  else tuning = CORE_COPY.summaryNear;
  const dissonanceCount = harmony.sustainedDissonance.length, outsideScaleCount = harmony.outsideScale.length;
  return dissonanceCount || outsideScaleCount ? `${tuning} ${CORE_COPY.summaryHarmony(dissonanceCount, outsideScaleCount)}` : tuning;
}

export function compareTracks(referenceFrames, ownFrames, { offsetSeconds = 0 } = {}) {
  const lattice = referenceFrames.length > 1 ? referenceFrames : ownFrames;
  const hop = lattice.length > 1 ? Math.max(0.001, lattice[1].time - lattice[0].time) : CONFIG.hopSeconds;
  const origin = referenceFrames[0]?.time ?? (ownFrames[0] ? Math.max(0, ownFrames[0].time - offsetSeconds) : 0);
  const lastTime = Math.max(referenceFrames.at(-1)?.time ?? -1, ownFrames.at(-1) ? ownFrames.at(-1).time - offsetSeconds : -1);
  let ownIndex = 0, referenceIndex = 0;
  const nearest = (track, index, target) => {
    while (index + 1 < track.length && Math.abs(track[index + 1].time - target) <= Math.abs(track[index].time - target)) index++;
    const frame = track[index];
    return { index, frame: frame && Math.abs(frame.time - target) <= hop * 0.75 ? frame : null };
  };
  // Count the union of both tracks. An extra tail without its partner is unknown,
  // rather than silently disappearing from the ratio.
  const frames = [];
  for (let index = 0; origin + index * hop <= lastTime + hop * 0.1; index++) {
    const time = origin + index * hop;
    const reference = nearest(referenceFrames, referenceIndex, time);
    const own = nearest(ownFrames, ownIndex, time + offsetSeconds);
    referenceIndex = reference.index; ownIndex = own.index;
    frames.push({ ...compareFrames(reference.frame, own.frame), time });
  }
  const counts = { good: 0, near: 0, off: 0, unknown: 0 };
  for (const frame of frames) counts[frame.status]++;
  const proportions = Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, frames.length ? count / frames.length : key === 'unknown' ? 1 : 0]));
  const segments = groupSegments(frames, hop);
  const valid = frames.filter(f => f.status !== 'unknown');
  const intervalGroups = new Map();
  for (const frame of valid) {
    const key = frame.intervalSemitones;
    const group = intervalGroups.get(key) ?? { intervalSemitones: key, intervalName: frame.intervalName, count: 0, total: 0, totalWidth: 0 };
    group.count++; group.total += frame.deviationCents; group.totalWidth += frame.widthCents; intervalGroups.set(key, group);
  }
  const intervalStats = [...intervalGroups.values()].map(g => ({ intervalSemitones: g.intervalSemitones, intervalName: g.intervalName, count: g.count, duration: g.count * hop, meanDeviationCents: g.total / g.count, meanWidthCents: g.totalWidth / g.count, justOffsetCents: JUST_OFFSETS[Math.abs(g.intervalSemitones) % 12] ?? null })).sort((a, b) => b.count - a.count);
  const key = estimateKey([...referenceFrames, ...ownFrames]);
  const outsideScale = [];
  if (key.confident) {
    for (const [part, track] of [['reference', referenceFrames], ['own', ownFrames]]) {
      let current = null;
      for (const frame of track) {
        const adjustedTime = frame.time - (part === 'own' ? offsetSeconds : 0);
        const outside = adjustedTime >= 0 && frame.voiced && !key.scale.includes(pitchClass(frame.midi));
        if (outside && (!current || current.pitchClass !== pitchClass(frame.midi))) {
          if (current && current.end - current.start + 1e-8 >= CONFIG.sustainedHarmonySeconds) outsideScale.push(current);
          current = { part, start: adjustedTime, end: adjustedTime + hop, sourceStart: frame.time, sourceEnd: frame.time + hop, pitchClass: pitchClass(frame.midi) };
        } else if (outside) { current.end = adjustedTime + hop; current.sourceEnd = frame.time + hop; }
        else { if (current && current.end - current.start + 1e-8 >= CONFIG.sustainedHarmonySeconds) outsideScale.push(current); current = null; }
      }
      if (current && current.end - current.start + 1e-8 >= CONFIG.sustainedHarmonySeconds) outsideScale.push(current);
    }
  }
  const harmonicSegments = groupHarmonicSegments(frames, hop);
  const harmony = { key, outsideScale, segments: harmonicSegments, sustainedDissonance: harmonicSegments.filter(s => s.consonance === 'dissonant' && s.duration + 1e-8 >= CONFIG.sustainedHarmonySeconds), commonIntervals: intervalStats.slice(0, 3) };
  return { frames, segments, harmonicSegments, proportions, counts, validFrames: valid.length, summary: summarize(proportions, valid.length, harmony), harmony, intervalStats, duration: frames.length ? frames.at(-1).time + hop / 2 : 0, offsetSeconds };
}
