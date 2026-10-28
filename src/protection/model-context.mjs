import { createHash } from 'node:crypto';
export const passageKey = text => createHash('sha256').update(text).digest('hex');
// Bound memory and CPU latency; overlap protects entities at chunk boundaries.
export function* textWindows(text) {
  // Format parsers already isolate text values. Do not discard numeric values
  // or reinterpret literal angle brackets as markup at the model boundary.
  if (!text.trim()) return;
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + 2400);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + 1800) end = boundary;
      if (/^[\uDC00-\uDFFF]$/.test(text[end])) end--;
    }
    yield text.slice(start, end);
    if (end === text.length) break;
    start = end - 256;
    const boundary = text.indexOf(' ', start);
    if (boundary >= start && boundary < end) start = boundary + 1;
    if (/^[\uDC00-\uDFFF]$/.test(text[start])) start++;
  }
}
