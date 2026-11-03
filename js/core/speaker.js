import { CONFIG } from './config.js';
import { CORE_COPY } from '../copy.ko.js';
import { detectPitch, prepareSamples } from './pitch.js';
import { createSpeakerReference, ensureReferenceThrough, latestReferencePeaks, recentReferenceComponents, referencePeaksNear, spectralAmplitude } from './reference-spectrum.js';
export { createSpeakerReference } from './reference-spectrum.js';

// Experimental, reference-aware tonal suppression. These engineering settings
// have not been calibrated with phone loudspeakers or human vocal recordings.
export const SPEAKER_CONFIG = Object.freeze({
  historySeconds: 0.3,
  maxDelaySeconds: 1.2,
  exclusionCents: 50,
  historyMergeCents: 15,
  maxReferenceFrequencies: 8,
  maxHarmonics: 16,
  maxRecentSpectralComponents: 64,
  maxSuppressionFrequency: 3500,
  projectionPasses: 2,
  minResidualEnergyFraction: 0.025,
  minResidualConfidence: 0.94,
  minFundamentalFraction: 0.1,
  maxHalfWindowDifferenceCents: 35,
  lowerFundamentalAmplitudeRatio: 0.008,
  lowerFundamentalAbsoluteAmplitude: 0.0005,
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

function suppressKnownHarmonics(samples, sampleRate, referenceFrequencies, config, spectralComponents = null) {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const residual = Float32Array.from(samples, sample => sample - mean);
  const harmonicFrequencies = spectralComponents ? spectralComponents.map(component => component.frequency) : [];
  if (!spectralComponents) for (const reference of referenceFrequencies) for (let multiple = 1; multiple <= config.maxHarmonics; multiple++) {
    const frequency = reference * multiple;
    if (frequency > Math.min(config.maxSuppressionFrequency, sampleRate * 0.45)) break;
    if (!harmonicFrequencies.some(existing => Math.abs(cents(existing, frequency)) < 5)) harmonicFrequencies.push(frequency);
  }
  const bases = harmonicFrequencies.map(frequency => sinusoidBasis(frequency, sampleRate, samples.length));
  // Production uses observed reference spectral components over the supported
  // history, independently of the potentially incorrect reference YIN f0.
  // Coordinate projection allows unknown delay/phase and linear room-filter
  // gain independently for each observed component. It does not
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

function lowerFundamentalSupport(samples, residual, candidate, sampleRate, config) {
  const amplitude = spectralAmplitude(samples, candidate, sampleRate);
  for (const divisor of [2, 3, 4]) {
    const lower = candidate / divisor;
    if (lower < 35) continue;
    const lowerAmplitude = Math.max(spectralAmplitude(samples, lower, sampleRate), spectralAmplitude(residual, lower, sampleRate));
    if (lowerAmplitude >= config.lowerFundamentalAbsoluteAmplitude && lowerAmplitude >= amplitude * config.lowerFundamentalAmplitudeRatio) return { frequency: lower, amplitudeRatio: lowerAmplitude / Math.max(amplitude, 1e-12) };
  }
  return null;
}

function ambiguousReferenceFundamental(context, estimatedFrequency, windowEndTime, config) {
  const peaks = latestReferencePeaks(context, windowEndTime);
  const strongest = peaks[0]?.amplitude ?? 0;
  for (const divisor of [2, 3, 4]) {
    const lower = estimatedFrequency / divisor;
    if (lower < 35) continue;
    if (peaks.some(peak => Math.abs(cents(peak.frequency, lower)) <= 35 && peak.amplitude >= strongest * config.lowerFundamentalAmplitudeRatio)) return true;
  }
  return false;
}

function referenceCandidateEvidence(samples, sampleRate, context, frequency, windowEndTime, config) {
  const occurrences = referencePeaksNear(context, frequency, windowEndTime, config.exclusionCents);
  const candidateAmplitude = spectralAmplitude(samples, frequency, sampleRate);
  if (candidateAmplitude < config.lowerFundamentalAbsoluteAmplitude) return null;
  const measured = new Map();
  for (const occurrence of occurrences) {
    const { frame, peak } = occurrence;
    const features = frame.peaks.filter(feature => {
      const multiple = Math.max(1, Math.round(feature.frequency / peak.frequency));
      const sameFamily = Math.abs(cents(feature.frequency, peak.frequency * multiple)) <= 50;
      return feature === peak || (sameFamily && feature.amplitude >= frame.peaks[0].amplitude * 0.03);
    }).slice(0, 6);
    if (!features.includes(peak)) features.push(peak);
    let matched = 0;
    for (const feature of features) {
      const key = feature.frequency.toFixed(3);
      if (!measured.has(key)) measured.set(key, spectralAmplitude(samples, feature.frequency, sampleRate));
      const microphoneAmplitude = measured.get(key);
      const expected = feature.amplitude / peak.amplitude;
      const observed = microphoneAmplitude / candidateAmplitude;
      if (microphoneAmplitude >= config.lowerFundamentalAbsoluteAmplitude && observed >= expected * 0.08 && observed <= expected * 12) matched++;
    }
    if (matched >= Math.min(2, features.length)) {
      const ageSeconds = Math.max(0, windowEndTime - frame.endTime);
      // A current reference plus an old echo can have the same observed tonal
      // components as a current reference plus a real singer. An energy-share
      // exception cannot separate these cases safely. Prefer abstention for
      // matched past-reference families, accepting the loss of real-voice yield.
      return { ageSeconds, matchedPartials: matched };
    }
  }
  return null;
}

export function detectSpeakerPitch(input, inputRate, { referenceFrequencies = [], referencePresent = true, referenceContext = null, windowEndTime = null, requireReferenceEvidence = true, ...options } = {}) {
  const config = { ...SPEAKER_CONFIG, ...options };
  const samples = inputRate > CONFIG.analysisSampleRate ? prepareSamples(input, inputRate) : input;
  const sampleRate = Math.min(inputRate, CONFIG.analysisSampleRate);
  const rms = rmsOf(samples);
  const frequencies = referenceList(referenceFrequencies, config);
  const evidenceAvailable = referenceContext?.kind === 'speaker-reference-spectrum-v1' && Number.isFinite(windowEndTime);
  const diagnostics = { referenceCount: frequencies.length, residualFraction: null, residualConfidence: 0, fundamentalFraction: null, halfWindowDifferenceCents: null, evidence: evidenceAvailable ? 'waveform-spectrum' : 'frequency-only', stage: null };
  const unknown = (reason, confidence = 0) => ({ frequency: null, midi: null, voiced: false, confidence, rms, reason, diagnostics });
  if (!samples?.length || !Number.isFinite(rms) || rms < CONFIG.minRms) return unknown('uncertain');
  if (!frequencies.length) {
    if (referencePresent) return unknown('reference-unavailable');
    const pitch = detectPitch(samples, sampleRate);
    return { ...pitch, reason: pitch.voiced ? null : 'uncertain', diagnostics };
  }
  if (requireReferenceEvidence && !evidenceAvailable) return unknown('reference-unavailable');
  let spectralComponents = null;
  if (evidenceAvailable) {
    ensureReferenceThrough(referenceContext, windowEndTime);
    if (ambiguousReferenceFundamental(referenceContext, frequencies[0], windowEndTime, config)) return unknown('lower-fundamental-ambiguous');
    spectralComponents = recentReferenceComponents(referenceContext, windowEndTime, { historySeconds: config.maxDelaySeconds, maxComponents: config.maxRecentSpectralComponents });
    diagnostics.spectralComponentCount = spectralComponents.length;
    if (!spectralComponents.length || spectralComponents.length > config.maxRecentSpectralComponents) { diagnostics.stage = 'reference-spectrum-budget'; return unknown('reference-unavailable'); }
  }
  if (frequencies.length > config.maxReferenceFrequencies) return unknown('uncertain');
  const residual = suppressKnownHarmonics(samples, sampleRate, frequencies, config, spectralComponents);
  const residualRms = rmsOf(residual);
  diagnostics.residualFraction = residualRms * residualRms / (rms * rms);
  if (residualRms < CONFIG.minRms || diagnostics.residualFraction < config.minResidualEnergyFraction) return unknown('residual-insufficient');
  const pitch = detectPitch(residual, sampleRate, { minConfidence: config.minResidualConfidence, yinThreshold: 1 - config.minResidualConfidence });
  diagnostics.residualConfidence = pitch.confidence;
  if (!pitch.voiced) { diagnostics.stage = 'residual-periodicity'; return unknown('uncertain', pitch.confidence); }
  if (overlapsReference(pitch.frequency, frequencies, config.exclusionCents)) return unknown('reference-overlap', pitch.confidence);
  if (evidenceAvailable) {
    const explained = referenceCandidateEvidence(samples, sampleRate, referenceContext, pitch.frequency, windowEndTime, config);
    if (explained) {
      diagnostics.stage = `reference-spectrum:${explained.matchedPartials}`;
      return unknown(explained.ageSeconds <= config.maxDelaySeconds ? 'reference-overlap' : 'delay-unsupported', pitch.confidence);
    }
  }
  const lower = lowerFundamentalSupport(samples, residual, pitch.frequency, sampleRate, config);
  if (lower) { diagnostics.stage = 'supported-subharmonic'; return unknown('lower-fundamental-ambiguous', pitch.confidence); }
  diagnostics.fundamentalFraction = fundamentalFraction(residual, pitch.frequency, sampleRate, residualRms * residualRms);
  if (diagnostics.fundamentalFraction < config.minFundamentalFraction) { diagnostics.stage = 'candidate-fundamental-weak'; return unknown('uncertain', pitch.confidence); }
  const midpoint = Math.floor(residual.length / 2);
  const first = detectPitch(residual.subarray(0, midpoint), sampleRate);
  const last = detectPitch(residual.subarray(midpoint), sampleRate);
  if (!first.voiced || !last.voiced) { diagnostics.stage = 'half-window-unvoiced'; return unknown('uncertain', pitch.confidence); }
  diagnostics.halfWindowDifferenceCents = Math.abs(cents(first.frequency, last.frequency));
  if (diagnostics.halfWindowDifferenceCents > config.maxHalfWindowDifferenceCents) { diagnostics.stage = 'half-window-disagreement'; return unknown('uncertain', pitch.confidence); }
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

export async function analyzeSpeakerSamples(input, sampleRate, referenceFrames, { onProgress, signal, historySeconds = SPEAKER_CONFIG.historySeconds, referenceSamples, referenceContext, ...options } = {}) {
  const samples = prepareSamples(input, sampleRate);
  const rate = Math.min(sampleRate, CONFIG.analysisSampleRate);
  const hop = Math.round(rate * CONFIG.hopSeconds), window = CONFIG.frameSize;
  const frames = [];
  const context = referenceContext || (referenceSamples ? createSpeakerReference(referenceSamples, sampleRate) : null);
  let sliceStart = performance.now();
  for (let start = 0; start + window <= samples.length; start += hop) {
    if (signal?.aborted) throw new DOMException(CORE_COPY.analysisCancelled, 'AbortError');
    const windowEnd = (start + window) / rate;
    const referenceFrequencies = referenceFrequenciesAt(referenceFrames, windowEnd, { historySeconds });
    const time = (start + window / 2) / rate;
    // Missing a reference estimate is not evidence that the loudspeaker is quiet.
    const frame = detectSpeakerPitch(samples.subarray(start, start + window), rate, { ...options, referenceFrequencies, referencePresent: true, referenceContext: context, windowEndTime: windowEnd });
    frames.push({ time, ...frame });
    if (performance.now() - sliceStart > 20) {
      onProgress?.(Math.min(1, windowEnd * rate / samples.length));
      await new Promise(resolve => setTimeout(resolve, 0)); sliceStart = performance.now();
    }
  }
  onProgress?.(1);
  return frames;
}
