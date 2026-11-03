import { CONFIG } from './config.js';

// Low-pass before resampling prevents high-frequency vocal harmonics from aliasing
// into the fundamental range. This is a 2nd-order Butterworth low-pass filter.
export function prepareSamples(samples, sampleRate, targetRate = CONFIG.analysisSampleRate) {
  if (!(sampleRate > 0) || !samples?.length) return new Float32Array();
  if (sampleRate <= targetRate) return Float32Array.from(samples);
  const cutoff = Math.min(3200, targetRate * 0.42);
  const k = Math.tan(Math.PI * cutoff / sampleRate);
  const norm = 1 / (1 + Math.SQRT2 * k + k * k);
  const b0 = k * k * norm, b1 = 2 * b0, b2 = b0;
  const a1 = 2 * (k * k - 1) * norm;
  const a2 = (1 - Math.SQRT2 * k + k * k) * norm;
  const filtered = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    filtered[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  const ratio = sampleRate / targetRate;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio, index = Math.floor(position), mix = position - index;
    output[i] = filtered[index] * (1 - mix) + (filtered[index + 1] ?? filtered[index]) * mix;
  }
  return output;
}

export function detectPitch(input, inputRate, options = {}) {
  const cfg = { ...CONFIG, ...options };
  const samples = inputRate > cfg.analysisSampleRate ? prepareSamples(input, inputRate, cfg.analysisSampleRate) : input;
  const sampleRate = Math.min(inputRate, cfg.analysisSampleRate);
  let mean = 0, power = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length || 1;
  for (let i = 0; i < samples.length; i++) power += (samples[i] - mean) ** 2;
  const rms = Math.sqrt(power / (samples.length || 1));
  const invalid = (confidence = 0) => ({ frequency: null, confidence, rms, voiced: false, midi: null });
  const minTau = Math.max(2, Math.floor(sampleRate / cfg.maxFrequency));
  const maxTau = Math.min(Math.ceil(sampleRate / cfg.minFrequency), Math.floor(samples.length / 2) - 1);
  if (!Number.isFinite(rms) || rms < cfg.minRms || maxTau <= minTau) return invalid();
  // YIN's fixed window difference and cumulative mean normalized difference.
  const windowSize = samples.length - maxTau - 1;
  const difference = new Float64Array(maxTau + 2);
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }
  const normalized = new Float64Array(maxTau + 2);
  normalized[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    running += difference[tau];
    normalized[tau] = running ? difference[tau] * tau / running : 1;
  }
  let candidate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (normalized[tau] < cfg.yinThreshold) {
      while (tau < maxTau && normalized[tau + 1] < normalized[tau]) tau++;
      candidate = tau; break;
    }
  }
  if (candidate < 0) return invalid();
  const confidence = Math.max(0, Math.min(1, 1 - normalized[candidate]));
  const left = normalized[candidate - 1], center = normalized[candidate], right = normalized[candidate + 1];
  const denominator = 2 * (2 * center - right - left);
  const correction = denominator ? (right - left) / denominator : 0;
  const period = candidate + Math.max(-0.5, Math.min(0.5, correction));
  const frequency = sampleRate / period;
  // Allow the small interpolation uncertainty at the requested range boundary.
  if (confidence < cfg.minConfidence || frequency < cfg.minFrequency * 0.995 || frequency > cfg.maxFrequency * 1.005) return invalid(confidence);
  return { frequency, confidence, rms, voiced: true, midi: 69 + 12 * Math.log2(frequency / 440) };
}
