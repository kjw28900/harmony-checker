import { analyzeSamples } from './core/analysis.js';
import { analyzeSpeakerSamples } from './core/speaker.js';

self.onmessage = async ({ data }) => {
  if (data.type !== 'analyze') return;
  try {
    const reference = await analyzeSamples(data.reference, data.sampleRate, {
      onProgress: progress => self.postMessage({ type: 'progress', progress: progress * 0.5 }),
    });
    const options = { referenceSamples: data.reference, onProgress: progress => self.postMessage({ type: 'progress', progress: 0.5 + progress * 0.5 }) };
    const own = data.listeningMethod === 'speaker'
      ? await analyzeSpeakerSamples(data.own, data.sampleRate, reference, options)
      : await analyzeSamples(data.own, data.sampleRate, options);
    self.postMessage({ type: 'result', reference, own });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
