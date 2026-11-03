// Level summaries contain numbers only. Keep raw PCM and microphone identifiers
// out of copyable diagnostics, and apply playback gain only in the audio graph.
export function measureLevel(samples) {
  let sum = 0, peak = 0;
  for (const sample of samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { rms, peak, dbfs: toDbfs(rms) };
}
export function toDbfs(rms) {
  return Number.isFinite(rms) && rms > 0 ? 20 * Math.log10(rms) : null;
}
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, median: null, max: null };
  const middle = sorted.length >>> 1;
  return { count: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1) };
}
export function levelDistribution(rmsValues) {
  // Digital silence is counted separately instead of pretending it has a finite dBFS.
  return { ...distribution(rmsValues.map(toDbfs)), silentChunks: rmsValues.filter(value => value === 0).length, totalChunks: rmsValues.length, unit: 'dBFS RMS' };
}
export function playbackGain(samples) {
  const { rms, peak } = measureLevel(samples);
  if (rms < 1e-6 || !Number.isFinite(rms)) return 1;
  return Math.min(128, Math.max(1, 0.15 / rms), 0.9 / Math.max(peak, 1e-12));
}
const SETTING_KEYS = ['channelCount', 'sampleRate', 'sampleSize', 'latency', 'echoCancellation', 'autoGainControl', 'noiseSuppression', 'volume'];
export function safeMicSettings(settings = {}) {
  return Object.fromEntries(SETTING_KEYS.filter(key => typeof settings[key] === 'boolean' || (typeof settings[key] === 'number' && Number.isFinite(settings[key]))).map(key => [key, settings[key]]));
}
export function residualRatioSummary(frames) {
  const fractions = frames.map(frame => frame.diagnostics?.residualFraction).filter(value => Number.isFinite(value) && value >= 0 && value < 1);
  return {
    residualEnergyFraction: distribution(fractions),
    residualToRemovedEnergyDb: distribution(fractions.filter(value => value > 0).map(value => 10 * Math.log10(value / (1 - value)))),
  };
}
