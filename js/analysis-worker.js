import { analyzeSamples } from './core/analysis.js';

self.onmessage = async ({ data }) => {
  if (data.type !== 'analyze') return;
  try {
    const reference = await analyzeSamples(data.reference, data.sampleRate, {
      onProgress: progress => self.postMessage({ type: 'progress', progress: progress * 0.5 }),
    });
    const own = await analyzeSamples(data.own, data.sampleRate, {
      onProgress: progress => self.postMessage({ type: 'progress', progress: 0.5 + progress * 0.5 }),
    });
    self.postMessage({ type: 'result', reference, own });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
