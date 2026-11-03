import { COPY, RUNTIME } from './copy.ko.js';
import { detectPitch } from './core/pitch.js';
import { analyzeSamples } from './core/analysis.js';
import { compareFrames, compareTracks } from './core/compare.js';
import { noteName } from './core/music.js';
import { CONFIG } from './core/config.js';
import { SPEAKER_CONFIG, createSpeakerReference, detectSpeakerPitch, analyzeSpeakerSamples, referenceFrequenciesAt } from './core/speaker.js';

const $ = id => document.getElementById(id);
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 300;
const MAX_BYTES = 50 * 1024 * 1024;
const state = {
  mode: 'file', reference: null, own: null, referenceFrames: [], ownFrames: [],
  result: null, context: null, playing: [], playbackTimer: null, worker: null,
  generation: 0, playbackVersion: 0, navigationVersion: 0, live: null, preview: null, offset: 0, lastErrorAction: null,
  screen: 'home', timing: [], fileTokens: { reference: 0, own: 0 }, reading: new Set(), preparing: false, pendingStream: null, rejectJob: null,
  listeningMethod: 'speaker', analysisMethod: 'file',
};
const plain = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const copy = (key, fallback) => plain(key.split('.').reduce((v, k) => v?.[k], COPY), fallback);
function text(id, value) { const node = $(id); if (node && node.textContent !== String(value)) node.textContent = value; }
function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}
function timeLabel(seconds, precise = false) {
  if (precise) {
    const ticks = Math.round(Math.max(0, seconds || 0) * 10);
    return `${Math.floor(ticks / 600)}:${((ticks % 600) / 10).toFixed(1).padStart(4, '0')}`;
  }
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
function show(screen) {
  // A screen change cancels pending playback as well as already playing nodes.
  stopPlayback();
  state.screen = screen;
  document.querySelectorAll('[id^="screen-"]').forEach(node => { node.hidden = node.id !== `screen-${screen}`; });
  requestAnimationFrame(redraw);
  const heading = $(`screen-${screen}`)?.querySelector('h1,h2');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function stopPlayback() {
  state.playbackVersion++;
  state.playing.forEach(source => { try { source.stop(); source.disconnect(); } catch {} });
  state.playing = [];
  clearTimeout(state.playbackTimer);
  state.preview = null;
  text('reference-preview', copy('preview', COPY.preview));
  text('own-preview', copy('preview', COPY.preview));
  text('play-results', copy('playResults', RUNTIME.preview));
}
function dispose() {
  state.generation++;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.rejectJob?.(new Error('Cancelled')); state.rejectJob = null;
  state.pendingStream?.getTracks().forEach(track => track.stop()); state.pendingStream = null;
  state.preparing = false; state.analyzing = false; state.reading.clear();
  state.fileTokens.reference++; state.fileTokens.own++;
  stopPlayback();
  if (state.live) cleanupLive(state.live);
  state.reference = null;
  state.own = null;
  state.referenceFrames = [];
  state.ownFrames = [];
  state.result = null;
  state.analysisMethod = 'file';
  state.offset = 0; state.timing = []; state.lastMicSettings = null;
  $('stop-live').disabled = false;
  text('copy-status', '');
  $('copy-fallback')?.remove();
  ['reference-file', 'own-file'].forEach(id => { if ($(id)) $(id).value = ''; });
  text('reference-name', copy('noFile', COPY.noFile));
  text('own-name', copy('noFile', COPY.noFile));
  text('reference-meta', ''); text('own-meta', '');
  $('progress-panel').hidden = true;
  $('offset').value = '0';
  updateButtons();
}
function chooseMode(mode) {
  dispose();
  state.mode = mode;
  text('setup-title', mode === 'live' ? copy('liveSetupTitle', COPY.liveSetupTitle) : copy('fileSetupTitle', COPY.fileSetupTitle));
  $('file-mode-fields').hidden = mode !== 'file';
  $('live-mode-fields').hidden = mode !== 'live';
  $('analyze-button').hidden = mode === 'live';
  updateListeningMethod();
  show('setup');
}
function updateListeningMethod() {
  document.querySelectorAll('input[name="listening-method"]').forEach(input => { input.checked = input.value === state.listeningMethod; });
  text('listening-hint', state.listeningMethod === 'speaker'
    ? `${COPY.speakerTip} ${RUNTIME.speakerDelayNotice(SPEAKER_CONFIG.maxDelaySeconds)}`
    : COPY.headphonesTip);
}
function updateButtons() {
  const busy = state.analyzing || Boolean(state.worker) || state.preparing || state.reading.size > 0;
  $('analyze-button').disabled = !state.reference || !state.own || busy;
  $('start-live').disabled = !state.reference || Boolean(state.live) || busy;
  $('reference-file').disabled = state.analyzing || Boolean(state.worker) || state.preparing;
  $('own-file').disabled = state.analyzing || Boolean(state.worker) || state.preparing;
  $('reference-preview').disabled = !state.reference;
  $('own-preview').disabled = !state.own;
  document.querySelectorAll('input[name="listening-method"]').forEach(input => { input.disabled = busy || Boolean(state.live); });
}
function errorView(kind, message, action = () => show('setup')) {
  stopPlayback();
  text('error-title', copy(`errors.${kind}.title`, RUNTIME.errorTitle));
  text('error-message', message || copy(`errors.${kind}.message`, RUNTIME.errorMessage));
  text('error-action', copy(`errors.${kind}.action`, RUNTIME.retry));
  state.lastErrorAction = action;
  show('error');
}
function ensureContext() {
  if (!state.context || state.context.state === 'closed') {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error(RUNTIME.unsupportedAudio);
    state.context = new Context({ latencyHint: 'interactive' });
    state.context.addEventListener('statechange', () => {
      if (state.live && state.context.state !== 'running') finishLive(RUNTIME.interruptedAudio);
    });
  }
  return state.context;
}
async function readFile(file, kind) {
  if (!file) return;
  stopPlayback();
  const token = state.generation;
  const fileToken = ++state.fileTokens[kind];
  const stale = () => token !== state.generation || fileToken !== state.fileTokens[kind];
  state[kind] = null; state.result = null;
  text(`${kind}-name`, copy('noFile')); drawWave(`${kind}-wave`, null);
  if (file.size > MAX_BYTES) { state.reading.delete(kind); updateButtons(); return errorView('fileSize', RUNTIME.tooLarge); }
  state.reading.add(kind);
  text(`${kind}-meta`, RUNTIME.fileOpening);
  state[kind] = null;
  updateButtons();
  try {
    // decodeAudioData uses this offline context's sample rate: mono conversion follows explicitly.
    const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const decoder = new Context(1, 1, SAMPLE_RATE);
    const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
    if (stale()) return;
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_SECONDS) {
      throw Object.assign(new Error(RUNTIME.tooLong), { kind: 'fileLength' });
    }
    const samples = new Float32Array(decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < samples.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
    }
    state[kind] = { name: file.name, duration: decoded.duration, samples, buffer: null };
    text(`${kind}-name`, file.name);
    text(`${kind}-meta`, RUNTIME.fileMeta(timeLabel(decoded.duration), decoded.numberOfChannels));
    drawWave(`${kind}-wave`, samples);
    updateButtons();
  } catch (error) {
    if (stale()) return;
    text(`${kind}-meta`, RUNTIME.fileRetry);
    errorView(error.kind || 'fileType', error.kind ? error.message : RUNTIME.fileDecodeError);
  } finally {
    if (fileToken === state.fileTokens[kind]) { state.reading.delete(kind); updateButtons(); }
  }
}
function audioBuffer(track, context) {
  if (!track.buffer) {
    track.buffer = context.createBuffer(1, track.samples.length, SAMPLE_RATE);
    track.buffer.copyToChannel(track.samples, 0);
  }
  return track.buffer;
}
async function preview(kind) {
  if (!state[kind]) return;
  if (state.preview === kind) { stopPlayback(); return; }
  const generation = state.generation;
  const track = state[kind];
  const screen = state.screen;
  stopPlayback();
  const request = state.playbackVersion;
  const isCurrent = () => generation === state.generation && request === state.playbackVersion && screen === state.screen && state[kind] === track;
  try {
    const context = ensureContext();
    const resumed = context.resume();
    await resumed;
    if (!isCurrent()) return;
    const source = context.createBufferSource();
    source.buffer = audioBuffer(track, context);
    source.connect(context.destination);
    source.onended = () => { if (isCurrent()) stopPlayback(); };
    source.start();
    state.playing.push(source); state.preview = kind;
    text(`${kind}-preview`, RUNTIME.stop);
  } catch {
    if (isCurrent()) errorView('playback');
  }
}
function setProgress(value, message) {
  $('progress-panel').hidden = false;
  $('analysis-progress').value = Math.max(0, Math.min(1, value));
  text('progress-label', message || RUNTIME.progress(Math.round(value * 100)));
}
async function analyzePair() {
  if (!state.reference || !state.own) return;
  stopPlayback();
  const token = ++state.generation;
  const listeningMethod = state.own.listeningMethod || 'file';
  state.analysisMethod = listeningMethod;
  state.analyzing = true;
  $('copy-fallback')?.remove(); text('copy-status', '');
  updateButtons();
  show('setup');
  setProgress(0);
  $('analyze-button').disabled = true;
  $('start-live').disabled = true;
  try {
    let tracks;
    // Modules work in current Safari and Chrome. Keep a cooperative local fallback for older engines.
    try {
      tracks = await new Promise((resolve, reject) => {
        state.rejectJob = reject;
        const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
        state.worker = worker;
        worker.onmessage = ({ data }) => {
          if (token !== state.generation) return;
          if (data.type === 'progress') setProgress(data.progress);
          if (data.type === 'error') reject(new Error(data.message));
          if (data.type === 'result') { state.rejectJob = null; resolve(data); }
        };
        worker.onerror = event => reject(new Error(event.message || 'Worker unavailable'));
        const reference = state.reference.samples.slice();
        const own = state.own.samples.slice();
        worker.postMessage({ type: 'analyze', reference, own, sampleRate: SAMPLE_RATE, listeningMethod }, [reference.buffer, own.buffer]);
      });
    } catch (error) {
      if (token !== state.generation) return;
      if (state.worker) { state.worker.terminate(); state.worker = null; }
      const signal = { get aborted() { return token !== state.generation; } };
      const reference = await analyzeSamples(state.reference.samples, SAMPLE_RATE, { signal, onProgress: p => setProgress(p / 2) });
      const options = { signal, onProgress: p => setProgress(0.5 + p / 2), referenceSamples: state.reference.samples };
      const own = listeningMethod === 'speaker'
        ? await analyzeSpeakerSamples(state.own.samples, SAMPLE_RATE, reference, options)
        : await analyzeSamples(state.own.samples, SAMPLE_RATE, options);
      tracks = { reference, own };
    }
    if (token !== state.generation) return;
    state.referenceFrames = tracks.reference;
    state.ownFrames = tracks.own;
    state.offset = 0;
    $('offset').value = 0;
    updateResult();
    show('results');
  } catch (error) {
    if (token === state.generation) errorView('analysis', RUNTIME.analysisError);
  } finally {
    if (token === state.generation) {
      state.analyzing = false; state.rejectJob = null;
      if (state.worker) { state.worker.terminate(); state.worker = null; }
      $('progress-panel').hidden = true;
      updateButtons();
    }
  }
}
function cancelAnalysis() {
  state.generation++;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.rejectJob?.(new Error('Cancelled')); state.rejectJob = null;
  state.pendingStream?.getTracks().forEach(track => track.stop()); state.pendingStream = null; state.preparing = false; state.analyzing = false;
  $('progress-panel').hidden = true;
  updateButtons();
  text('progress-label', RUNTIME.analysisCancelled);
}
function permissionError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return RUNTIME.permissionDenied;
  if (error.name === 'NotFoundError') return RUNTIME.noMic;
  if (error.name === 'NotReadableError') return RUNTIME.micBusy;
  return error.message || RUNTIME.micFailed;
}
async function startLive() {
  if (!state.reference || state.live || state.preparing) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return errorView('secure', RUNTIME.secureError);
  }
  const token = ++state.generation;
  const listeningMethod = state.listeningMethod;
  let context;
  try { context = ensureContext(); } catch (error) { return errorView('microphone', error.message); }
  // Invoke resume synchronously in this user gesture, before the permission await.
  const resumed = context.resume();
  stopPlayback();
  state.preparing = true; updateButtons();
  setProgress(0, RUNTIME.checkingMic);
  let stream;
  let live;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    if (token !== state.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    state.pendingStream = stream;
    await resumed;
    if (!context.audioWorklet || !window.AudioWorkletNode) throw new Error(RUNTIME.unsupportedWorklet);
    setProgress(0, RUNTIME.analyzingReference);
    state.referenceFrames = await analyzeSamples(state.reference.samples, SAMPLE_RATE, {
      signal: { get aborted() { return token !== state.generation; } }, onProgress: p => setProgress(p),
    });
    if (token !== state.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    await context.audioWorklet.addModule(new URL('./audio-capture.js', import.meta.url));
    if (token !== state.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    const speakerReference = listeningMethod === 'speaker' ? createSpeakerReference(state.reference.samples, SAMPLE_RATE) : null;
    const startTime = context.currentTime + 0.2;
    const source = context.createMediaStreamSource(stream);
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 3500; filter.Q.value = 0.707;
    const worklet = new AudioWorkletNode(context, 'local-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { startTime, targetRate: SAMPLE_RATE, maxSeconds: state.reference.duration } });
    const mute = context.createGain(); mute.gain.value = 0;
    source.connect(filter).connect(worklet).connect(mute).connect(context.destination);
    const referenceSource = context.createBufferSource();
    referenceSource.buffer = audioBuffer(state.reference, context);
    referenceSource.connect(context.destination);
    live = { stream, source, filter, worklet, mute, referenceSource, speakerReference, startTime, listeningMethod, referenceOnlySince: null, chunks: [], total: 0, ring: new Float32Array(2048), history: [], timings: [], finishing: false, resolveDone: null, raf: null, settings: stream.getAudioTracks()[0].getSettings() };
    $('stop-live').disabled = false;
    state.live = live; state.preparing = false; state.pendingStream = null;
    worklet.port.onmessage = ({ data }) => {
      if (state.live !== live) return;
      if (data.type === 'done') { live.resolveDone?.(); if (!live.finishing) finishLive(); return; }
      if (data.type !== 'samples') return;
      live.chunks.push(data.samples); live.total += data.samples.length;
      if (data.samples.length >= live.ring.length) live.ring.set(data.samples.subarray(data.samples.length - live.ring.length));
      else { live.ring.copyWithin(0, data.samples.length); live.ring.set(data.samples, live.ring.length - data.samples.length); }
      if (live.total < live.ring.length) return;
      const receivedAt = performance.now();
      const endTime = data.endTime - startTime;
      const pitch = listeningMethod === 'speaker'
        ? detectSpeakerPitch(live.ring, SAMPLE_RATE, { referenceContext: live.speakerReference, windowEndTime: endTime, referenceFrequencies: referenceFrequenciesAt(state.referenceFrames, endTime) })
        : detectPitch(live.ring, SAMPLE_RATE);
      const own = { ...pitch, time: Math.max(0, endTime - live.ring.length / SAMPLE_RATE / 2) };
      if (listeningMethod === 'speaker' && ['residual-insufficient', 'reference-overlap'].includes(own.reason)) live.referenceOnlySince ??= own.time;
      else live.referenceOnlySince = null;
      const ref = nearestFrame(state.referenceFrames, own.time);
      const comparison = compareFrames(ref, own);
      live.history.push({ time: own.time, reference: ref?.midi, own: own.midi, frame: comparison });
      live.history = live.history.filter(point => point.time >= own.time - 8);
      renderLive(comparison, ref, own);
      requestAnimationFrame(() => {
        if (state.live !== live) return;
        const processingMs = performance.now() - receivedAt;
        const queueMs = Math.max(0, (context.currentTime - data.endTime) * 1000);
        live.timings.push({ processingMs, queueMs, windowMs: live.ring.length / SAMPLE_RATE * 1000, chunkMs: data.samples.length / SAMPLE_RATE * 1000 });
      });
    };
    worklet.onprocessorerror = () => {
      if (state.live !== live || live.finishing) return;
      cleanupLive(live); updateButtons(); errorView('microphone', RUNTIME.captureError);
    };
    const wallStart = performance.now();
    live.watchdog = setInterval(() => {
      if (state.live !== live || live.finishing) return;
      if (performance.now() - wallStart > 2500 && (context.currentTime < startTime + 0.1 || live.total === 0)) {
        cleanupLive(live); updateButtons(); errorView('microphone', RUNTIME.captureError);
      }
    }, 1000);
    referenceSource.onended = () => { if (state.live === live && !live.finishing) finishLive(); };
    referenceSource.start(startTime);
    stream.getTracks().forEach(track => track.onended = () => { if (!live.finishing) finishLive(RUNTIME.micDisconnected); });
    $('progress-panel').hidden = true;
    text('live-status', RUNTIME.waiting);
    text('live-listening-mode', listeningMethod === 'speaker' ? COPY.speakerModeLabel : COPY.headphonesModeLabel);
    const caution = document.querySelector('[data-copy="liveCaution"]');
    if (caution) caution.textContent = listeningMethod === 'speaker' ? COPY.speakerLiveCaution : COPY.liveCaution;
    show('live');
    function tick() {
      if (state.live !== live) return;
      text('live-time', timeLabel(context.currentTime - startTime));
      live.raf = requestAnimationFrame(tick);
    }
    tick();
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (live) cleanupLive(live);
    if (token !== state.generation) return;
    state.preparing = false; state.pendingStream = null;
    $('progress-panel').hidden = true;
    updateButtons();
    errorView('microphone', permissionError(error));
  }
}
function nearestFrame(frames, time) {
  if (!frames.length) return null;
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.02;
  const index = Math.round((time - frames[0].time) / hop);
  return index >= 0 && index < frames.length ? frames[index] : null;
}
function cleanupLive(live) {
  live.finishing = true;
  cancelAnimationFrame(live.raf);
  clearInterval(live.watchdog);
  try { live.referenceSource.stop(); } catch {}
  live.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
  [live.source, live.filter, live.worklet, live.mute, live.referenceSource].forEach(node => { try { node.disconnect(); } catch {} });
  live.worklet.port.close();
  live.speakerReference = null;
  if (state.live === live) state.live = null;
}
async function finishLive(reason = '') {
  const live = state.live;
  if (!live || live.finishing) return;
  live.finishing = true;
  $('stop-live').disabled = true;
  try { live.referenceSource.stop(); } catch {}
  // Allow the processor to flush its final partial block; a suspended context cannot flush.
  await Promise.race([
    new Promise(resolve => { live.resolveDone = resolve; live.worklet.port.postMessage('stop'); }),
    new Promise(resolve => setTimeout(resolve, 300)),
  ]);
  if (state.live !== live) return;
  const samples = new Float32Array(live.total);
  let position = 0;
  live.chunks.forEach(chunk => { samples.set(chunk, position); position += chunk.length; });
  state.timing = live.timings;
  state.lastMicSettings = live.settings;
  cleanupLive(live);
  $('stop-live').disabled = false;
  if (samples.length < SAMPLE_RATE * CONFIG.minRecordingSeconds) {
    updateButtons();
    errorView('silence', RUNTIME.tooShort(CONFIG.minRecordingSeconds));
    return;
  }
  state.own = { name: RUNTIME.takeName, duration: samples.length / SAMPLE_RATE, samples, buffer: null, listeningMethod: live.listeningMethod };
  text('own-name', RUNTIME.takeName);
  text('own-meta', RUNTIME.takeMeta(timeLabel(state.own.duration)));
  await analyzePair();
  if (reason && state.screen === 'results') text('copy-status', reason);
}
function statusOf(frame) { return frame?.status || frame?.classification || 'unknown'; }
function deviationOf(frame) { return frame?.deviation ?? frame?.deviationCents ?? frame?.centsDeviation ?? null; }
function renderLive(frame, reference, own) {
  const status = statusOf(frame);
  const deviation = deviationOf(frame);
  const label = frame?.intervalName || frame?.interval?.name || '';
  const valid = Number.isFinite(deviation) && !['unknown', 'uncertain', 'unvoiced'].includes(status);
  const width = frame.widthCents ?? deviation;
  const verdict = status === 'good' ? COPY.goodLive : status === 'near' ? (width >= 0 ? COPY.wideLive : COPY.narrowLive) : (width >= 0 ? COPY.wideOffLive : COPY.narrowOffLive);
  text('live-status', valid ? `${label} · ${verdict}` : RUNTIME.waiting);
  text('live-detail', valid ? RUNTIME.liveDetail(noteName(reference.midi), noteName(own.midi), deviation) : RUNTIME.clearVoices);
  if (!valid && state.live?.listeningMethod === 'speaker' && state.live.referenceOnlySince != null && own.time - state.live.referenceOnlySince >= 0.6) text('live-detail', COPY.speakerReferenceOnly);
  $('live-status').dataset.status = status;
  drawMeter(valid ? frame.widthCents ?? deviation : null);
  drawLiveHistory();
}
function statusLabel(status) {
  return RUNTIME.statusLabels[status] || status;
}
function updateResult() {
  state.result = compareTracks(state.referenceFrames, state.ownFrames, { offsetSeconds: state.offset });
  text('offset-value', RUNTIME.offset(state.offset));
  renderResults();
}
function renderResults() {
  const result = state.result;
  if (!result) return;
  text('result-summary', typeof result.summary === 'string' ? result.summary : result.summary?.text || result.summary?.message || RUNTIME.resultSummary);
  const proportions = result.proportions || {};
  const normalized = [
    ['correct', proportions.correct ?? proportions.good ?? proportions.matched ?? 0],
    ['slight', proportions.near ?? proportions.slight ?? proportions.warning ?? 0],
    ['off', proportions.off ?? proportions.bad ?? 0],
    ['unknown', proportions.unknown ?? proportions.uncertain ?? 0],
  ];
  const sum = normalized.reduce((total, [, value]) => total + value, 0) || 1;
  $('ratio-bar').replaceChildren(); $('ratio-legend').replaceChildren();
  normalized.forEach(([key, value]) => {
    const percentage = value / sum * 100;
    const bar = element('span', null, `ratio-piece ${key}`); bar.style.width = `${percentage}%`;
    bar.setAttribute('aria-label', `${statusLabel(key)} ${Math.round(percentage)}%`);
    $('ratio-bar').append(bar);
    $('ratio-legend').append(element('span', `${statusLabel(key)} ${Math.round(percentage)}%`, `legend-item ${key}`));
  });
  text('result-badge', normalized[3][1] / sum >= 0.5 ? RUNTIME.resultBadgeUnknown : RUNTIME.resultBadgeMeasured);
  const method = state.analysisMethod;
  $('result-listening-mode').hidden = method === 'file';
  text('result-listening-mode', method === 'speaker' ? COPY.speakerModeLabel : COPY.headphonesModeLabel);
  const ownOption = $('playback-source').querySelector('option[value="own"]');
  if (ownOption) ownOption.textContent = method === 'speaker' ? COPY.speakerOwnPlayback : COPY.listenOwn;
  renderSegments(result.segments || []);
  renderHarmony(result.harmony);
  renderDetails(result.intervalStats);
  drawResultGraph();
}
function renderSegments(segments) {
  const list = $('problem-list'); list.replaceChildren();
  const problems = segments.filter(segment => !['correct','good','matched'].includes(statusOf(segment))).sort((a,b) => {
    const severity = value => ['off','bad'].includes(statusOf(value)) ? 3 : ['near','slight','warning'].includes(statusOf(value)) ? 2 : 1;
    return severity(b) - severity(a) || ((b.end ?? 0) - (b.start ?? 0)) - ((a.end ?? 0) - (a.start ?? 0));
  }).slice(0, 5);
  if (!problems.length) { list.append(element('p', RUNTIME.noProblems)); return; }
  problems.forEach(segment => {
    const item = element('div', null, 'problem-item');
    const start = segment.start ?? segment.startTime ?? 0;
    const end = segment.end ?? segment.endTime ?? start;
    const deviation = deviationOf(segment) ?? segment.meanDeviation ?? segment.averageDeviation;
    const width = segment.widthCents ?? deviation;
    const message = segment.message || segment.description || RUNTIME.segmentFallback(segment.intervalName || '', statusLabel(statusOf(segment)), width);
    item.append(element('strong', `${timeLabel(start, true)}–${timeLabel(end, true)}`), element('span', message));
    const button = element('button', RUNTIME.preview, 'button button-quiet'); button.type = 'button';
    button.addEventListener('click', () => playResult(start, Math.max(0.25, end - start)));
    item.append(button); list.append(item);
  });
}
function renderHarmony(harmony) {
  const node = $('harmony-content'); node.replaceChildren();
  node.append(element('p', RUNTIME.harmonyNotice));
  if (!harmony) { node.append(element('p', RUNTIME.unknownKey)); return; }
  const key = harmony.key || harmony.estimatedKey;
  const label = typeof key === 'string' ? key : key?.confident ? key?.name || key?.label : null;
  node.append(element('p', label ? RUNTIME.estimatedKey(label) : RUNTIME.uncertainKey));
  if (harmony.commonIntervals?.length) node.append(element('p', RUNTIME.commonIntervals(harmony.commonIntervals.map(value => value.intervalName).join(', '))));
  const messages = harmony.comments || harmony.messages || harmony.notes || [];
  (Array.isArray(messages) ? messages : [messages]).forEach(message => node.append(element('p', typeof message === 'string' ? message : message.message || message.text)));
  const outside = harmony.outsideScale || harmony.outOfKeySegments || harmony.outOfKey || [];
  outside.slice?.(0,5).forEach(segment => node.append(element('p', RUNTIME.outsideSegment(timeLabel(segment.start, true), timeLabel(segment.end, true)))));
  const dissonant = harmony.sustainedDissonance || harmony.dissonantSegments || harmony.dissonances || [];
  dissonant.slice?.(0,5).forEach(segment => node.append(element('p', RUNTIME.dissonantSegment(timeLabel(segment.start, true), timeLabel(segment.end, true)))));
}
function renderDetails(stats) {
  const node = $('details-content'); node.replaceChildren();
  node.append(element('p', RUNTIME.detailsScale));
  node.append(element('p', RUNTIME.detailsNotice));
  if (state.analysisMethod === 'speaker') {
    const frames = state.ownFrames;
    const reasons = frames.reduce((counts, frame) => {
      if (frame.reason) counts[frame.reason] = (counts[frame.reason] || 0) + 1;
      return counts;
    }, {});
    node.prepend(element('p', COPY.speakerResultNotice), element('p', RUNTIME.speakerDetails({
      totalFrames: frames.length,
      reasons,
    })));
  }
  const values = Array.isArray(stats) ? stats : Object.values(stats || {});
  if (values.length) {
    const table = element('table');
    const thead = element('thead'); const heading = element('tr');
    RUNTIME.tableHeaders.forEach(value => heading.append(element('th', value))); thead.append(heading); table.append(thead);
    const body = element('tbody');
    values.forEach(value => { const tr = element('tr'); const deviation = value.meanDeviationCents ?? value.meanDeviation ?? value.averageDeviation ?? value.deviation ?? value.meanCents; tr.append(element('td', value.name || value.intervalName || value.interval || RUNTIME.interval), element('td', Number.isFinite(deviation) ? `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}c` : '—'), element('td', RUNTIME.duration(value.duration ?? value.seconds ?? 0))); body.append(tr); });
    table.append(body); node.append(table);
  }
  node.append(element('p', RUNTIME.justReference));
  if (state.timing.length) {
    const values = state.timing.map(value => value.processingMs).sort((a,b) => a-b);
    node.append(element('p', RUNTIME.timing(values[Math.floor(values.length/2)])));
  }
}
async function playResult(start = 0, duration) {
  if (!state.reference || !state.own) return;
  const generation = state.generation;
  const tracks = { reference: state.reference, own: state.own };
  const offsetSeconds = state.offset;
  const screen = state.screen;
  const selection = $('playback-source').value;
  stopPlayback();
  const request = state.playbackVersion;
  const isCurrent = () => generation === state.generation && request === state.playbackVersion && screen === state.screen && state.reference === tracks.reference && state.own === tracks.own;
  try {
    const context = ensureContext(); const resumed = context.resume(); await resumed;
    if (!isCurrent()) return;
    const kinds = selection === 'both' ? ['reference', 'own'] : [selection];
    const when = context.currentTime + 0.05;
    const end = Math.max(...kinds.map(kind => tracks[kind].duration - (kind === 'own' ? offsetSeconds : 0)));
    const length = Math.min(duration ?? end - start, end - start);
    if (length <= 0) return;
    kinds.forEach(kind => {
      let offset = start + (kind === 'own' ? offsetSeconds : 0);
      let delay = 0;
      if (offset < 0) { delay = -offset; offset = 0; }
      const available = Math.min(length-delay, tracks[kind].duration-offset);
      if (available <= 0) return;
      const source = context.createBufferSource(); source.buffer = audioBuffer(tracks[kind], context);
      const gain = context.createGain(); gain.gain.value = selection === 'both' ? 0.5 : 1;
      source.connect(gain).connect(context.destination);
      source.start(when+delay, offset, available); state.playing.push(source);
    });
    text('play-results', RUNTIME.playingFrom(timeLabel(start)));
    state.playbackTimer = setTimeout(stopPlayback, (length+0.1)*1000);
  } catch {
    if (isCurrent()) errorView('playback', undefined, () => show('results'));
  }
}

function resultText() {
  const result = state.result;
  const summary = $('result-summary').textContent;
  const intervals = $('details-content').textContent;
  return RUNTIME.resultText({ summary, ratios: $('ratio-legend').textContent, offset: state.offset, harmony: $('harmony-content').textContent, details: intervals, mode: state.analysisMethod });
}
async function copyResult() {
  if (!state.result) return;
  const content = resultText();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(content);
    text('copy-status', RUNTIME.copied);
  } catch {
    let field = $('copy-fallback');
    if (!field) { field = element('textarea'); field.id = 'copy-fallback'; field.rows = 8; field.setAttribute('aria-label', RUNTIME.fallbackLabel); $('copy-status').after(field); }
    field.value = content; field.hidden = false; field.focus(); field.select();
    text('copy-status', RUNTIME.copyFallback);
  }
}
function canvasContext(id, fallbackHeight=160) {
  const canvas = $(id); if (!canvas) return null;
  const width = canvas.clientWidth; if (!width) return null;
  const height = canvas.clientHeight || fallbackHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) { canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
  return { ctx, width, height };
}
function colors() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return { text: dark ? '#d6e5e2' : '#354947', grid: dark ? '#30413f' : '#dbe5e2', reference: dark ? '#9daead' : '#788a87', own: dark ? '#75c4b0' : '#16856c', correct:'#219875',slight:'#c57c22',off:'#cf5854',unknown:'#94a3a0' };
}
function drawWave(id, samples) {
  const drawing = canvasContext(id,64); if (!drawing) return;
  const {ctx,width,height} = drawing; const c = colors(); ctx.strokeStyle=c.own; ctx.lineWidth=1.4;
  ctx.beginPath();
  if (!samples) { ctx.moveTo(0,height/2); ctx.lineTo(width,height/2); ctx.stroke(); return; }
  const step=Math.max(1,Math.ceil(samples.length/width));
  for(let x=0;x<width;x++){ let min=0,max=0; const begin=Math.floor(x*samples.length/width); for(let i=begin;i<Math.min(samples.length,begin+step);i++){min=Math.min(min,samples[i]);max=Math.max(max,samples[i]);} ctx.moveTo(x,height/2+min*height*.46);ctx.lineTo(x,height/2+max*height*.46); }
  ctx.stroke();
}
function drawMeter(deviation=null) {
  const drawing=canvasContext('live-meter',180); if(!drawing)return;
  const {ctx,width,height}=drawing; const c=colors(); const radius=Math.min(width*.39,height*.72), cx=width/2,cy=height-26;
  const angle=value=>Math.PI+(Math.max(-50,Math.min(50,value))+50)/100*Math.PI;
  [[-50,-35,c.off],[-35,-15,c.slight],[-15,15,c.correct],[15,35,c.slight],[35,50,c.off]].forEach(([from,to,color])=>{ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=12;ctx.arc(cx,cy,radius,angle(from),angle(to));ctx.stroke();});
  ctx.fillStyle=c.text;ctx.font='12px system-ui';ctx.textAlign='center';[-50,0,50].forEach(value=>ctx.fillText(`${value>0?'+':''}${value}c`,cx+Math.cos(angle(value))*(radius+21),cy+Math.sin(angle(value))*(radius+21)+5));
  if(Number.isFinite(deviation)){ctx.strokeStyle=c.text;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(angle(deviation))*(radius-15),cy+Math.sin(angle(deviation))*(radius-15));ctx.stroke();ctx.beginPath();ctx.arc(cx,cy,5,0,2*Math.PI);ctx.fill();}
}
function drawPitchLines(id,reference,own,duration,comparisons=[]) {
  const drawing=canvasContext(id,240);if(!drawing)return;
  const {ctx,width,height}=drawing,c=colors(),left=43,right=12,top=17,bottom=27;
  const all=[...reference,...own].map(f=>f.midi).filter(Number.isFinite);
  const min=all.length?Math.floor(all.reduce((a,b)=>Math.min(a,b),Infinity))-2:48,max=all.length?Math.ceil(all.reduce((a,b)=>Math.max(a,b),-Infinity))+2:84;
  const x=time=>left+(time/Math.max(.01,duration))*(width-left-right),y=midi=>top+(max-midi)/Math.max(1,max-min)*(height-top-bottom);
  ctx.font='11px system-ui';ctx.textAlign='right';
  for(let midi=min;midi<=max;midi++){if((max-min>28&&midi%12!==0)||(max-min>14&&midi%3!==0))continue;ctx.strokeStyle=c.grid;ctx.beginPath();ctx.moveTo(left,y(midi));ctx.lineTo(width-right,y(midi));ctx.stroke();ctx.fillStyle=c.text;ctx.fillText(noteName(midi),left-6,y(midi)+4);}
  ctx.textAlign='center';for(let i=0;i<=4;i++){const t=duration*i/4;ctx.fillStyle=c.text;ctx.fillText(duration<10?RUNTIME.graphTime(t):timeLabel(t),x(t),height-6);}
  function line(frames,color,offset=0,isOwn=false){let previous=null;ctx.lineWidth=2;frames.forEach((f,index)=>{if(!Number.isFinite(f.midi)||f.voiced===false){previous=null;return;}const point={x:x(f.time-offset),y:y(f.midi),time:f.time};if(point.x<left||point.x>width-right){previous=null;return;}if(previous&&f.time-previous.time<.15){ctx.strokeStyle=isOwn?(c[({good:'correct',near:'slight'})[statusOf(comparisons[index])]||statusOf(comparisons[index])]||color):color;ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(point.x,point.y);ctx.stroke();}previous=point;});}
  line(reference,c.reference);line(own,c.own,0,true);
}
function drawResultGraph(){
  if(!state.result)return;
  const frames=state.result.frames;
  const reference=frames.map(f=>({time:f.time,midi:f.reference?.midi,voiced:f.reference?.voiced}));
  const own=frames.map(f=>({time:f.time,midi:f.own?.midi,voiced:f.own?.voiced}));
  drawPitchLines('result-graph',reference,own,Math.max(state.reference.duration,state.own.duration-state.offset),frames);
}
function drawLiveHistory(){const history=state.live?.history||[];if(!history.length)return;const first=Math.max(0,history.at(-1).time-8);drawPitchLines('live-history',history.map(p=>({time:p.time-first,midi:p.reference,voiced:Number.isFinite(p.reference)})),history.map(p=>({time:p.time-first,midi:p.own,voiced:Number.isFinite(p.own)})),8,history.map(p=>p.frame));}
function redraw(){if(state.screen==='setup'){drawWave('reference-wave',state.reference?.samples);drawWave('own-wave',state.own?.samples);}if(state.screen==='results')drawResultGraph();if(state.screen==='live'){drawMeter(state.live?.history.at(-1)?.frame?.widthCents ?? null);drawLiveHistory();}}

for(const node of document.querySelectorAll('[data-copy]')){const value=node.dataset.copy.split('.').reduce((v,k)=>v?.[k],COPY);if(typeof value==='string')node.replaceChildren(...value.split('<br>').flatMap((part,index)=>index?[document.createElement('br'),document.createTextNode(part)]:[document.createTextNode(part)]));}
document.querySelectorAll('[data-action]').forEach(node => node.addEventListener('click', () => {
  const action = node.dataset.action;
  const navigation = ++state.navigationVersion;
  if (action === 'mode-live') chooseMode('live');
  if (action === 'mode-file') chooseMode('file');
  if (action === 'home') { dispose(); show('home'); }
  if (action === 'help') {
    if (state.live) {
      finishLive().then(() => {
        if (navigation !== state.navigationVersion || state.live || !['results', 'error'].includes(state.screen)) return;
        show('help');
      });
    } else { cancelAnalysis(); show('help'); }
  }
}));
$('reference-file').addEventListener('change',event=>readFile(event.target.files[0],'reference'));
$('own-file').addEventListener('change',event=>readFile(event.target.files[0],'own'));
$('reference-preview').addEventListener('click',()=>preview('reference'));
$('own-preview').addEventListener('click',()=>preview('own'));
$('analyze-button').addEventListener('click',analyzePair);
$('cancel-analysis').addEventListener('click',cancelAnalysis);
$('start-live').addEventListener('click',startLive);
document.querySelectorAll('input[name="listening-method"]').forEach(input => input.addEventListener('change', () => {
  state.listeningMethod = input.value;
  updateListeningMethod();
}));
$('stop-live').addEventListener('click',()=>finishLive());
$('play-results').addEventListener('click',()=>playResult());
$('stop-results').addEventListener('click',stopPlayback);
$('playback-source').addEventListener('change',stopPlayback);
$('offset').addEventListener('input',event=>{stopPlayback();state.offset=Number(event.target.value);updateResult();});
$('result-graph').addEventListener('click',event=>{const rect=event.currentTarget.getBoundingClientRect();const ratio=Math.max(0,Math.min(1,(event.clientX-rect.left-43)/(rect.width-55)));playResult(ratio*Math.max(state.reference.duration,state.own.duration-state.offset));});
$('copy-result').addEventListener('click',copyResult);
$('restart').addEventListener('click',()=>{ state.navigationVersion++; chooseMode(state.mode); });
$('error-action').addEventListener('click',()=>{ state.navigationVersion++; state.lastErrorAction?.(); });
window.addEventListener('resize',redraw);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',redraw);
document.querySelectorAll('details').forEach(node=>node.addEventListener('toggle',redraw));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.live)finishLive(RUNTIME.backgrounded);});
window.addEventListener('pagehide',()=>{ state.navigationVersion++; dispose(); });
window.harmonyDiagnostics=()=>({sampleRate:state.context?.sampleRate,timings:state.timing,microphoneSettings:state.lastMicSettings,listeningMethod:state.live?.listeningMethod||state.analysisMethod,selectedListeningMethod:state.listeningMethod,speakerExclusions:state.ownFrames.reduce((counts,frame)=>{if(frame.reason)counts[frame.reason]=(counts[frame.reason]||0)+1;return counts;},{}),frameCounts:{reference:state.referenceFrames.length,own:state.ownFrames.length},microphoneActive:Boolean(state.live||state.pendingStream),screen:state.screen});
updateButtons();
updateListeningMethod();
redraw();
