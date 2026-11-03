/* Local PCM capture only. No storage, encoding, network, or pitch processing here. */
class LocalCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.startTime = settings.startTime || 0;
    this.targetRate = settings.targetRate || 16000;
    this.maxSamples = Math.round((settings.maxSeconds || 300) * this.targetRate);
    this.output = new Float32Array(1024);
    this.used = 0;
    this.total = 0;
    this.nextSample = this.startTime;
    this.done = false;
    this.port.onmessage = event => {
      if (event.data === 'stop') this.finish();
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.output.slice(0, this.used);
    this.port.postMessage({ type: 'samples', samples, endTime: this.startTime + this.total / this.targetRate }, [samples.buffer]);
    this.used = 0;
  }
  finish() {
    if (this.done) return;
    this.flush();
    this.done = true;
    this.port.postMessage({ type: 'done' });
  }
  process(inputs) {
    if (this.done) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const time = currentTime + i / sampleRate;
      if (time + 0.5 / sampleRate < this.nextSample) continue;
      if (time < this.startTime) continue;
      this.output[this.used++] = channel[i];
      this.total++;
      this.nextSample += 1 / this.targetRate;
      if (this.used === this.output.length) this.flush();
      if (this.total >= this.maxSamples) { this.finish(); return false; }
    }
    return true;
  }
}
registerProcessor('local-capture', LocalCapture);
