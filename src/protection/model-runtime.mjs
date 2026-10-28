import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createBackend } from './model-backend.mjs';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';
import { admitModelSpan } from './entity-quality.mjs';
import { MODEL, LABELS } from './model-config.mjs';
import { encodeWords } from './model-tokens.mjs';
const sigmoid = value => 1 / (1 + Math.exp(-value));
export function decode(logits, tokens, labels, offset = 0, text) {
  const n = tokens.length, c = labels.length;
  if (logits.dims.join(',') !== `1,${n},${c},3`) throw Error(`Unexpected local model output shape: ${logits.dims}; expected 1,${n},${c},3.`);
  const score = (position, token, label) => sigmoid(logits.data[(token * c + label) * 3 + position]);
  const found = [];
  for (let label = 0; label < c; label++) for (let start = 0; start < n; start++) {
    if (score(0, start, label) < MODEL.threshold) continue;
    let total = 0;
    for (let end = start; end < n; end++) {
      const inside = score(2, end, label); if (inside < MODEL.threshold) break;
      total += inside;
      if (score(1, end, label) >= MODEL.threshold) found.push({ start: offset + tokens[start].start, end: offset + tokens[end].end, category: LABELS[labels[label]], label: labels[label], score: Math.min(score(0, start, label), score(1, end, label), total / (end - start + 1)) });
    }
  }
  // Keep the most confident non-overlapping spans within a window.
  const selected = [];
  for (const item of found.filter(s => text === undefined || admitModelSpan(s, text)).sort((a, b) => b.score - a.score)) if (!selected.some(s => item.start < s.end && item.end > s.start)) selected.push(item);
  return selected;
}
export async function loadModel(directory, categories, options = {}) {
  const tokenizer = new Tokenizer(JSON.parse(await readFile(path.join(directory, 'tokenizer.json'), 'utf8')), JSON.parse(await readFile(path.join(directory, 'tokenizer_config.json'), 'utf8')));
  const session = await createBackend(ort, path.join(directory, options.modelFile || 'model.onnx'), options);
  const labels = Object.keys(LABELS).filter(label => categories.includes(LABELS[label]));
  const encodedWords = new Map();
  const encode = value => {
    if (encodedWords.has(value)) return encodedWords.get(value);
    const ids = tokenizer.encode(value, { add_special_tokens: false }).ids;
    if (encodedWords.size >= 8192) encodedWords.delete(encodedWords.keys().next().value);
    encodedWords.set(value, ids); return ids;
  };
  const special = tokenizer.encode('', { add_special_tokens: true }).ids;
  if (special.length !== 2 || special[0] !== 50281 || special[1] !== 50282) { await session.close(); throw Error('Local model tokenizer mismatch.'); }
  const prompt = labels.flatMap(label => [...encode('<<ENT>>'), ...encode(label)]).concat(encode('<<SEP>>'));
  // Leave room for context around fragments of unusually large words.
  const wordBudget = Math.min(128, 512 - prompt.length - 2);
  return {
    get backend() { return session.provider; },
    verify: session.verify,
    async detect(text) {
      const tokens = encodeWords(text, encode, wordBudget); if (!tokens.length) return [];
      const found = new Map();
      // Token-budget windows with 32-word overlap: no truncation or skipped tail.
      for (let first = 0; first < tokens.length;) {
        let last = first, length = prompt.length + 2;
        while (last < tokens.length && length + tokens[last].ids.length <= 512 && last - first < 256) length += tokens[last++].ids.length;
        const ids = [special[0], ...prompt], mask = ids.map(() => 0);
        for (let i = first; i < last; i++) { ids.push(...tokens[i].ids); mask.push(...tokens[i].ids.map((_, j) => j ? 0 : i - first + 1)); }
        ids.push(special[1]); mask.push(0);
        const tensor = (data, dims) => new ort.Tensor('int64', BigInt64Array.from(data, BigInt), dims);
        const feeds = { input_ids: tensor(ids, [1, ids.length]), attention_mask: tensor(ids.map(() => 1), [1, ids.length]), words_mask: tensor(mask, [1, ids.length]), text_lengths: tensor([last - first], [1, 1]) };
        let output;
        try {
          output = await session.run(feeds);
          for (const item of decode(output.logits, tokens.slice(first, last), labels, 0, text)) { const key = `${item.start}:${item.end}:${item.category}`; if (!found.has(key) || found.get(key).score < item.score) found.set(key, item); }
        } finally { Object.values(feeds).forEach(t => t.dispose()); Object.values(output || {}).forEach(t => t.dispose()); }
        if (last === tokens.length) break;
        first = Math.max(first + 1, last - Math.min(32, Math.floor((last - first) / 2)));
      }
      return [...found.values()];
    },
    close: () => session.close()
  };
}
