import { CONFIG } from './config.js';
import { CORE_COPY } from '../copy.ko.js';
import { detectPitch, prepareSamples } from './pitch.js';

// Experimental, reference-aware tonal suppression. These engineering settings
// have not been calibrated with phone loudspeakers or human vocal recordings.
export const SPEAKER_CONFIG = Object.freeze({
  historySeconds: 0.3,
  exclusionCents: 50,
  historyMergeCents: 15,
  maxReferenceFrequencies: 8,
  maxHarmonics: 16,
  maxSuppressionFrequency: 3500,
  projectionPasses: 2,
  minResidualEnergyFraction: 0.025,
  minResidualConfidence: 0.94,
  minFundamentalFraction: 0.1,
  maxHalfWindowDifferenceCents: 35,
});

const cents = (a, b) => 1200 * Math.log2(a / b);
const rmsOf = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / (samples.length || 1));

function referenceList(input, config) {
  const frequencies = [];
  for (const frequency of input) {
    if (!Number.isFinite(frequency) || frequency < CONFIG.minFrequency * 0.99 || frequency > CONFIG.maxFrequency * 1.01) continue;
    if (!frequencies.some(previous => Math.abs(cents(previous, frequency)) < config.historyMergeCents)) frequencies.push(frequency);
    if (frequencies.length > config.maxReferenceFrequencies) break;
  }
  return frequencies;
}

export function overlapsReference(frequency, referenceFrequencies, exclusionCents = SPEAKER_CONFIG.exclusionCents) {
  if (!(frequency > 0)) return false;
  return referenceFrequencies.some(reference => {
    const ratio = frequency / reference;
    const harmonic = Math.max(1, Math.round(ratio));
    if (Math.abs(cents(frequency, reference * harmonic)) <= exclusionCents) return true;
    // Octaves below the reference cannot identify an independent singer either.
    const octave = Math.round(Math.log2(ratio));
    return Math.abs(cents(frequency, reference * 2 ** octave)) <= exclusionCents;
  });
}

function sinusoidBasis(frequency, sampleRate, length) {
  const sine = new Float32Array(length), cosine = new Float32Array(length);
  const step = 2 * Math.PI * frequency / sampleRate, sinStep = Math.sin(step), cosStep = Math.cos(step);
  let sin = 0, cos = 1, ss = 0, cc = 0, sc = 0;
  for (let i = 0; i < length; i++) {
    sine[i] = sin; cosine[i] = cos; ss += sin * sin; cc += cos * cos; sc += sin * cos;
    const nextSin = sin * cosStep + cos * sinStep;
    cos = cos * cosStep - sin * sinStep; sin = nextSin;
  }
  return { sine, cosine, ss, cc, sc, determinant: ss * cc - sc * sc };
}

function suppressKnownHarmonics(samples, sampleRate, referenceFrequencies, config) {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const residual = Float32Array.from(samples, sample => sample - mean);
  const harmonicFrequencies = [];
  for (const reference of referenceFrequencies) for (let multiple = 1; multiple <= config.maxHarmonics; multiple++) {
    const frequency = reference * multiple;
    if (frequency > Math.min(config.maxSuppressionFrequency, sampleRate * 0.45)) break;
    if (!harmonicFrequencies.some(existing => Math.abs(cents(existing, frequency)) < 5)) harmonicFrequencies.push(frequency);
  }
  const bases = harmonicFrequencies.map(frequency => sinusoidBasis(frequency, sampleRate, samples.length));
  // Coordinate projection allows unknown speaker delay/phase and unknown linear
  // room-filter gain independently for each reference harmonic. It does not
  // reconstruct a second voice or perform a learned source separation.
  for (let pass = 0; pass < config.projectionPasses; pass++) for (const basis of bases) {
    if (basis.determinant < 1e-9) continue;
    let sumSin = 0, sumCos = 0;
    for (let i = 0; i < residual.length; i++) { sumSin += residual[i] * basis.sine[i]; sumCos += residual[i] * basis.cosine[i]; }
    const a = (sumSin * basis.cc - sumCos * basis.sc) / basis.determinant;
    const b = (sumCos * basis.ss - sumSin * basis.sc) / basis.determinant;
    for (let i = 0; i < residual.length; i++) residual[i] -= a * basis.sine[i] + b * basis.cosine[i];
  }
  return residual;
}

function fundamentalFraction(samples, frequency, sampleRate, power) {
  let sin = 0, cos = 0, weights = 0;
  for (let i = 0; i < samples.length; i++) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1));
    const angle = 2 * Math.PI * frequency * i / sampleRate;
    sin += samples[i] * Math.sin(angle) * weight; cos += samples[i] * Math.cos(angle) * weight; weights += weight;
  }
  const amplitude = 2 * Math.hypot(sin, cos) / weights;
  return amplitude * amplitude / (2 * power);
}

export function detectSpeakerPitch(input, inputRate, { referenceFrequencies = [], referencePresent = true, ...options } = {}) {
  const config = { ...SPEAKER_CONFIG, ...options };
  const samples = inputRate > CONFIG.analysisSampleRate ? prepareSamples(input, inputRate) : input;
  const sampleRate = Math.min(inputRate, CONFIG.analysisSampleRate);
  const rms = rmsOf(samples);
  const frequencies = referenceList(referenceFrequencies, config);
  const diagnostics = { referenceCount: frequencies.length, residualFraction: null, residualConfidence: 0, fundamentalFraction: null, halfWindowDifferenceCents: null };
  const unknown = (reason, confidence = 0) => ({ frequency: null, midi: null, voiced: false, confidence, rms, reason, diagnostics });
  if (!samples?.length || !Number.isFinite(rms) || rms < CONFIG.minRms) return unknown('uncertain');
  if (!frequencies.length) {
    if (referencePresent) return unknown('uncertain');
    const pitch = detectPitch(samples, sampleRate);
    return { ...pitch, reason: pitch.voiced ? null : 'uncertain', diagnostics };
  }
  if (frequencies.length > config.maxReferenceFrequencies) return unknown('uncertain');
  const residual = suppressKnownHarmonics(samples, sampleRate, frequencies, config);
  const residualRms = rmsOf(residual);
  diagnostics.residualFraction = residualRms * residualRms / (rms * rms);
  if (residualRms < CONFIG.minRms || diagnostics.residualFraction < config.minResidualEnergyFraction) return unknown('reference-only');
  const pitch = detectPitch(residual, sampleRate, { minConfidence: config.minResidualConfidence, yinThreshold: 1 - config.minResidualConfidence });
  diagnostics.residualConfidence = pitch.confidence;
  if (!pitch.voiced) return unknown('uncertain', pitch.confidence);
  if (overlapsReference(pitch.frequency, frequencies, config.exclusionCents)) return unknown('reference-overlap', pitch.confidence);
  diagnostics.fundamentalFraction = fundamentalFraction(residual, pitch.frequency, sampleRate, residualRms * residualRms);
  if (diagnostics.fundamentalFraction < config.minFundamentalFraction) return unknown('uncertain', pitch.confidence);
  const midpoint = Math.floor(residual.length / 2);
  const first = detectPitch(residual.subarray(0, midpoint), sampleRate);
  const last = detectPitch(residual.subarray(midpoint), sampleRate);
  if (!first.voiced || !last.voiced) return unknown('uncertain', pitch.confidence);
  diagnostics.halfWindowDifferenceCents = Math.abs(cents(first.frequency, last.frequency));
  if (diagnostics.halfWindowDifferenceCents > config.maxHalfWindowDifferenceCents) return unknown('uncertain', pitch.confidence);
  return { ...pitch, rms: residualRms, reason: null, diagnostics };
}

// windowEndTime is relative to reference playback start. Reference pitch frames
// represent 128ms windows centered at frame.time: only frames whose entire
// window has elapsed are eligible, so this helper does not look into the future.
export function referenceFrequenciesAt(referenceFrames, windowEndTime, { historySeconds = SPEAKER_CONFIG.historySeconds } = {}) {
  const latestCenter = windowEndTime - CONFIG.frameSize / CONFIG.analysisSampleRate / 2;
  let low = 0, high = referenceFrames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (referenceFrames[middle].time <= latestCenter + 1e-8) low = middle + 1;
    else high = middle;
  }
  const frequencies = [];
  // Newest first: the most recently observable estimate represents each merged
  // history bucket, while older distinct pitches still protect against echoes.
  for (let index = low - 1; index >= 0 && referenceFrames[index].time >= latestCenter - historySeconds; index--) {
    const frame = referenceFrames[index];
    if (frame.voiced && Number.isFinite(frame.frequency)) frequencies.push(frame.frequency);
  }
  return frequencies;
}

export async function analyzeSpeakerSamples(input, sampleRate, referenceFrames, { onProgress, signal, historySeconds = SPEAKER_CONFIG.historySeconds, ...options } = {}) {
  const samples = prepareSamples(input, sampleRate);
  const rate = Math.min(sampleRate, CONFIG.analysisSampleRate);
  const hop = Math.round(rate * CONFIG.hopSeconds), window = CONFIG.frameSize;
  const frames = [];
  let sliceStart = performance.now();
  for (let start = 0; start + window <= samples.length; start += hop) {
    if (signal?.aborted) throw new DOMException(CORE_COPY.analysisCancelled, 'AbortError');
    const windowEnd = (start + window) / rate;
    const referenceFrequencies = referenceFrequenciesAt(referenceFrames, windowEnd, { historySeconds });
    const time = (start + window / 2) / rate;
    // Missing a reference estimate is not evidence that the loudspeaker is quiet.
    const frame = detectSpeakerPitch(samples.subarray(start, start + window), rate, { ...options, referenceFrequencies, referencePresent: true });
    frames.push({ time, ...frame });
    if (performance.now() - sliceStart > 20) {
      onProgress?.(Math.min(1, windowEnd * rate / samples.length));
      await new Promise(resolve => setTimeout(resolve, 0)); sliceStart = performance.now();
    }
  }
  onProgress?.(1);
  return frames;
}
