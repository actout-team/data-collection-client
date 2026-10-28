// Match GLiNER's word splitter while preserving original UTF-16 offsets.
export const words = text => [...text.matchAll(/[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S/gu)].map(m => ({ value: m[0], start: m.index, end: m.index + m[0].length }));

export function encodeWords(text, encode, budget) {
  const tokens = [];
  function append(word) {
    const ids = encode(word.value);
    if (ids.length <= budget) { tokens.push({ ...word, ids }); return; }
    // Long URLs, identifiers and unbroken Unicode can exceed an entire window.
    // Split only these words, re-tokenizing each half without cutting a surrogate pair.
    let middle = Math.floor(word.value.length / 2);
    if (/[\uDC00-\uDFFF]/u.test(word.value[middle])) middle--;
    if (!middle) throw Error('A single character exceeds the local model token budget.');
    append({ value: word.value.slice(0, middle), start: word.start, end: word.start + middle });
    append({ value: word.value.slice(middle), start: word.start + middle, end: word.end });
  }
  for (const word of words(text)) append(word);
  return tokens;
}
