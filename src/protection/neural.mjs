import { startModelWorker } from './model-client.mjs';
import { backendLabel } from './model-backend.mjs';
import { createHash } from 'node:crypto';
import { ensureModel } from './model-cache.mjs';
import { MODEL, GPU_MODEL } from './model-config.mjs';
import { refineModelSpan } from './entity-quality.mjs';
import { textWindows } from './model-context.mjs';
export { textWindows } from './model-context.mjs';
export async function createNeural({ directory, categories, signal, progress, log = () => {}, preference = 'auto', precision }) {
  if (precision && !['uint8','float32'].includes(precision)) throw Error('Unknown detector precision.');
  const model = precision ? (precision === 'uint8' ? MODEL : GPU_MODEL) : preference === 'cpu' ? MODEL : GPU_MODEL;
  const cached = await ensureModel(directory, { signal, progress, log, model });
  signal?.throwIfAborted(); progress?.({ phase: 'Loading local model', percent: 0 });
  const worker = await startModelWorker({ directory: cached, categories, signal, log, preference, modelFile: model.files[0].name });
  const seen = new Set(); let scanned = 0, inferenceCalls = 0, cacheHits = 0;
  const started = performance.now(); let closed;
  const infer = async text => { signal?.throwIfAborted(); inferenceCalls++; const spans = await worker.detect(text); signal?.throwIfAborted(); return spans; };
  function validate(span, text) {
    const { start, end, category } = span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end || !categories.includes(category)) throw Error('Invalid local model span. Protection stopped.');
  }
  function add(span, text, detector) {
    validate(span, text);
    const refined = refineModelSpan(span, text);
    if (!refined) return;
    const { start, end, category } = refined;
    detector.add(text.slice(start, end), category, { source: 'model', label: span.label, score: span.score }, text);
  }
  async function discoverMany(values, detector, tick = () => {}) {
    function* unique() {
      const scheduled = new Set();
      for (const value of values) for (const text of textWindows(value)) {
        signal?.throwIfAborted(); if (!text.trim()) continue;
        const hash = createHash('sha256').update(text).digest('hex');
        if (seen.has(hash) || scheduled.has(hash)) { cacheHits++; continue; }
        if (scheduled.size >= 10000) scheduled.delete(scheduled.values().next().value);
        scheduled.add(hash); yield { text, hash };
      }
    }
    // Concatenation is not tensor batching: unrelated fields can change the
    // model's contextual predictions even when output spans stay in bounds.
    // Scan each passage independently, retaining caching and bounded windows.
    for (const record of unique()) {
      for (const span of await infer(record.text)) add(span, record.text, detector);
      if (seen.size >= 10000) seen.delete(seen.values().next().value);
      seen.add(record.hash); scanned++;
      tick();
    }
  }
  return {
    get info() { return { id: model.id, revision: model.revision, precision: model.precision, language: model.language, threshold: model.threshold, admissionPolicy: 'contextual-values-v3', contextPolicy: 'passage-scoped-with-visible-dom-v2', runtime: 'ONNX Runtime', backend: worker.backend, backendLabel: backendLabel(worker.backend), acceleration: worker.acceleration, inferenceCalls, cacheHits, network: 'model download only' }; },
    discover: (value, detector, tick) => discoverMany([value], detector, tick), discoverMany,
    get scanned() { return scanned; },
    close() { return closed ||= (async () => { log('info', `Model scan: ${scanned} text fragments, ${inferenceCalls} model calls, ${cacheHits} cache hits, ${Math.round((performance.now() - started) / 1000)} seconds.`); await worker.close(); })(); }
  };
}
