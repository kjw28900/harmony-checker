import { CONFIG } from './config.js';
import { CORE_COPY } from '../copy.ko.js';
import { detectPitch, prepareSamples } from './pitch.js';

export async function analyzeSamples(input, sampleRate, { onProgress, signal } = {}) {
  const samples = prepareSamples(input, sampleRate);
  const rate = Math.min(sampleRate, CONFIG.analysisSampleRate);
  const hop = Math.round(rate * CONFIG.hopSeconds);
  const window = CONFIG.frameSize;
  const frames = [];
  let sliceStart = performance.now();
  for (let start = 0; start + window <= samples.length; start += hop) {
    if (signal?.aborted) throw new DOMException(CORE_COPY.analysisCancelled, 'AbortError');
    const frame = detectPitch(samples.subarray(start, start + window), rate);
    frames.push({ time: (start + window / 2) / rate, ...frame });
    if (performance.now() - sliceStart > 20) {
      onProgress?.(Math.min(1, (start + window) / samples.length));
      await new Promise(resolve => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  onProgress?.(1);
  return frames;
}
