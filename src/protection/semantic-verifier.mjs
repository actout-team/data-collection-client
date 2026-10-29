import { createHash } from 'node:crypto';
import { ensureGenerator } from './managed-assets.mjs';
import { startGeneratorProcess } from './generator-process.mjs';
import { VERIFIER_MODEL, RUNTIME_VERSION } from './generator-assets.mjs';
import { VERIFICATION_PROMPT, VERIFICATION_REVIEW_PROMPT, EXTRACTION_PROMPT, EXTRACTION_GRAMMAR, verificationRequest, isOrdinary, needsBoundaryReview, recoverInnerIdentity } from './semantic-prompt.mjs';

export function createSemanticVerifier({ directory, signal, progress, log = () => {}, preference = 'auto', ensure = ensureGenerator, start = startGeneratorProcess } = {}) {
  const cache = new Map();
  let runtime, closed, calls = 0, cacheHits = 0, rejected = 0, retainedWithoutVerification = 0, boundaryReviews = 0, boundaryRetained = 0, backend;
  const load = () => runtime ||= (async () => {
    const config = await ensure(directory, { signal, progress, preference, modelAsset: VERIFIER_MODEL, modelPhase: 'Downloading detection verifier' });
    signal?.throwIfAborted(); progress?.({ phase: 'Loading detection verifier', percent: 0 });
    const process = await start(config, { signal, log });
    backend = process.info?.backend; return process;
  })();
  return {
    async keep(span, text) {
      signal?.throwIfAborted();
      if (closed) throw Error('Detection verifier is closed.');
      const request = verificationRequest(span, text);
      if (!request) { retainedWithoutVerification++; return true; }
      const content = JSON.stringify(request), key = createHash('sha256').update(span.category + '\0' + content).digest('hex');
      if (cache.has(key)) { cacheHits++; return cache.get(key); }
      const engine = await load();
      let keep = false;
      // Two task formulations must agree before suppressing a detection.
      // Disagreement, ambiguity and malformed responses retain protection.
      for (const prompt of [VERIFICATION_PROMPT, VERIFICATION_REVIEW_PROMPT]) {
        const response = await engine.generate({
          stream: false, messages: [{ role: 'system', content: prompt }, { role: 'user', content }],
          temperature: 0, seed: 1, max_tokens: 12, cache_prompt: true
        });
        signal?.throwIfAborted(); calls++;
        if (response.choices?.[0]?.finish_reason !== 'stop' || !isOrdinary(response.choices?.[0]?.message?.content)) { keep = true; break; }
      }
      if (!keep && needsBoundaryReview(span.category, request.candidate)) {
        const response = await engine.generate({
          stream: false, messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content }],
          temperature: 0, seed: 1, max_tokens: 64, cache_prompt: true, grammar: EXTRACTION_GRAMMAR
        });
        signal?.throwIfAborted(); calls++; boundaryReviews++;
        keep = recoverInnerIdentity(response, request.candidate);
        if (keep) boundaryRetained++;
      }
      if (!keep) rejected++;
      if (cache.size >= 4096) cache.delete(cache.keys().next().value);
      cache.set(key, keep); return keep;
    },
    get info() { return { id: VERIFIER_MODEL.id, revision: VERIFIER_MODEL.revision, sha256: VERIFIER_MODEL.sha256, precision: 'Q4_K_M', policy: 'semantic-boundaries-v1', runtimeVersion: RUNTIME_VERSION, backend, calls, cacheHits, rejected, retainedWithoutVerification, boundaryReviews, boundaryRetained }; },
    close() {
      return closed ||= (async () => {
        const engine = await runtime?.catch(() => null);
        try { await engine?.close(); } finally { cache.clear(); }
      })();
    }
  };
}
