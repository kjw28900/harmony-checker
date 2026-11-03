import { CONFIG } from './config.js';
import { prepareSamples } from './pitch.js';

const TABLES = new Map();
function fftTables(size) {
  if (TABLES.has(size)) return TABLES.get(size);
  const bits = Math.log2(size), reversed = new Uint16Array(size);
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2), window = new Float64Array(size);
  let windowSum = 0;
  for (let i = 0; i < size; i++) {
    let value = i, flip = 0;
    for (let bit = 0; bit < bits; bit++) { flip = (flip << 1) | (value & 1); value >>>= 1; }
    reversed[i] = flip; window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)); windowSum += window[i];
    if (i < size / 2) { cos[i] = Math.cos(-2 * Math.PI * i / size); sin[i] = Math.sin(-2 * Math.PI * i / size); }
  }
  const tables = { reversed, cos, sin, window, windowSum }; TABLES.set(size, tables); return tables;
}

function windowedSpectrum(samples) {
  const size = samples.length;
  if (size < 64 || (size & (size - 1))) return null;
  const tables = fftTables(size), real = new Float64Array(size), imaginary = new Float64Array(size);
  const mean = samples.reduce((sum, value) => sum + value, 0) / size;
  for (let i = 0; i < size; i++) real[tables.reversed[i]] = (samples[i] - mean) * tables.window[i];
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2, stride = size / width;
    for (let start = 0; start < size; start += width) for (let j = 0; j < half; j++) {
      const left = start + j, right = left + half, index = j * stride;
      const r = real[right] * tables.cos[index] - imaginary[right] * tables.sin[index];
      const im = real[right] * tables.sin[index] + imaginary[right] * tables.cos[index];
      real[right] = real[left] - r; imaginary[right] = imaginary[left] - im;
      real[left] += r; imaginary[left] += im;
    }
  }
  const magnitude = new Float64Array(size / 2);
  let max = 0;
  for (let i = 1; i < magnitude.length; i++) { magnitude[i] = Math.hypot(real[i], imaginary[i]); max = Math.max(max, magnitude[i]); }
  return { magnitude, max, tables, size };
}

export function spectralPeaks(samples, sampleRate, { maxPeaks = 24, minimumRelativeAmplitude = 0.003 } = {}) {
  const spectrum = windowedSpectrum(samples);
  if (!spectrum) return [];
  const { magnitude, max, tables, size } = spectrum;
  const peaks = [];
  for (let i = 2; i < magnitude.length - 1; i++) {
    if (magnitude[i] < max * minimumRelativeAmplitude || magnitude[i] < magnitude[i - 1] || magnitude[i] <= magnitude[i + 1]) continue;
    const left = Math.log(magnitude[i - 1] + 1e-30), middle = Math.log(magnitude[i] + 1e-30), right = Math.log(magnitude[i + 1] + 1e-30);
    const denominator = left - 2 * middle + right;
    const correction = denominator ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator)) : 0;
    const frequency = (i + correction) * sampleRate / size;
    if (frequency < 30 || frequency > 3500) continue;
    peaks.push({ frequency, amplitude: 2 * Math.exp(middle - 0.25 * (left - right) * correction) / tables.windowSum });
  }
  return peaks.sort((a, b) => b.amplitude - a.amplitude).slice(0, maxPeaks);
}

const binOf = frequency => Math.round(1200 * Math.log2(frequency / 30) / 10);
const cents = (a, b) => 1200 * Math.log2(a / b);

export function createSpeakerReference(input, inputRate) {
  const samples = inputRate > CONFIG.analysisSampleRate ? prepareSamples(input, inputRate) : input;
  return { kind: 'speaker-reference-spectrum-v1', samples, sampleRate: Math.min(inputRate, CONFIG.analysisSampleRate), frameSize: CONFIG.frameSize, hop: CONFIG.frameSize / 2, frames: [], occurrences: new Map(), duration: samples.length / Math.min(inputRate, CONFIG.analysisSampleRate) };
}

export function ensureReferenceThrough(context, endTime) {
  if (context?.kind !== 'speaker-reference-spectrum-v1' || !Number.isFinite(endTime)) return [];
  const lastStart = Math.min(context.samples.length - context.frameSize, Math.floor(endTime * context.sampleRate + 1e-6) - context.frameSize);
  const finalIndex = Math.floor(lastStart / context.hop);
  for (let index = context.frames.length; index <= finalIndex; index++) {
    const start = index * context.hop;
    const peaks = spectralPeaks(context.samples.subarray(start, start + context.frameSize), context.sampleRate);
    const frame = { index, endTime: (start + context.frameSize) / context.sampleRate, peaks };
    context.frames.push(frame);
    for (const peak of peaks) {
      const bin = binOf(peak.frequency), occurrences = context.occurrences.get(bin) || [];
      occurrences.push({ frame, peak }); context.occurrences.set(bin, occurrences);
    }
  }
  return context.frames;
}

function beforeTime(list, endTime) {
  let low = 0, high = list.length;
  while (low < high) { const mid = (low + high) >>> 1; if (list[mid].frame.endTime <= endTime + 1e-8) low = mid + 1; else high = mid; }
  return low - 1;
}

export function referencePeaksNear(context, frequency, endTime, toleranceCents = 50) {
  ensureReferenceThrough(context, endTime);
  const results = [], center = binOf(frequency), radius = Math.ceil(toleranceCents / 10) + 1;
  for (let bin = center - radius; bin <= center + radius; bin++) {
    const occurrences = context.occurrences.get(bin);
    if (!occurrences) continue;
    // A frequency bucket has a fixed-size query budget even after a long song.
    const latest = beforeTime(occurrences, endTime);
    for (let index = latest; index >= Math.max(0, latest - 1); index--) {
      const occurrence = occurrences[index];
      if (Math.abs(cents(frequency, occurrence.peak.frequency)) <= toleranceCents) results.push(occurrence);
    }
  }
  return results.sort((a, b) => b.frame.endTime - a.frame.endTime);
}

export function latestReferencePeaks(context, endTime) {
  ensureReferenceThrough(context, endTime);
  const index = Math.min(context.frames.length - 1, Math.floor((endTime * context.sampleRate - context.frameSize + 1e-6) / context.hop));
  return context.frames[index]?.peaks ?? [];
}

export function recentReferenceComponents(context, endTime, { historySeconds = 1.2, maxComponents = 64 } = {}) {
  ensureReferenceThrough(context, endTime);
  const latest = Math.min(context.frames.length - 1, Math.floor((endTime * context.sampleRate - context.frameSize + 1e-6) / context.hop));
  const components = [];
  for (let index = latest; index >= 0 && context.frames[index].endTime >= endTime - historySeconds; index--) {
    const frame = context.frames[index];
    for (const peak of frame.peaks) {
      if (peak.amplitude < frame.peaks[0].amplitude * 0.003) continue;
      if (!components.some(component => Math.abs(cents(component.frequency, peak.frequency)) < 5)) components.push(peak);
      if (components.length > maxComponents) return components;
    }
  }
  return components;
}

export function spectralAmplitude(samples, frequency, sampleRate) {
  if (!(frequency > 0) || frequency >= sampleRate / 2) return 0;
  const tables = fftTables(samples.length);
  const step = 2 * Math.PI * frequency / sampleRate, sinStep = Math.sin(step), cosStep = Math.cos(step);
  let sine = 0, cosine = 1, a = 0, b = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] * tables.window[i]; a += value * sine; b += value * cosine;
    const next = sine * cosStep + cosine * sinStep; cosine = cosine * cosStep - sine * sinStep; sine = next;
  }
  return 2 * Math.hypot(a, b) / tables.windowSum;
}
