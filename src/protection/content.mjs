// Connector-independent value boundary routing. No schema/key text is sent to
// detection. Unknown structured syntax is retained, never flattened to prose.
import { jsonText } from './formats.mjs';
import { htmlText, xmlText, edits } from './structured.mjs';
import { fieldCategory } from './detect.mjs';
import { credentialAssignments } from './entity-quality.mjs';

// Preserve the credential label's meaning without sending schema text to the
// detector. The surrounding prose still follows the normal structure router.
export function assignedText(text, ranges, detector, mode, key, context, warn, onEdits, depth) {
  const scan = () => {
    const changes = [];
    let cursor = 0;
    const part = (start, end, field) => {
      if (start === end) return;
      valueText(text.slice(start, end), detector, mode, field, context, warn,
        found => changes.push(...found.map(c => ({ ...c, start: start + c.start, stop: start + c.stop }))), depth + 1);
    };
    for (const range of ranges) {
      part(cursor, range.start, key);
      part(range.start, range.end, 'password');
      cursor = range.end;
    }
    part(cursor, text.length, key);
    if (mode === 'discover') return text;
    onEdits?.(changes);
    return edits(text, changes);
  };
  // Supplementary rules may inspect separate values. The model still receives
  // the full sentence once, without separately scanning its contextless pieces.
  return mode === 'discover' && detector.withObservation ? detector.withObservation(text, scan) : scan();
}
export function valueText(text, detector, mode, key = '', context = '', warn = () => {}, onEdits, depth = 0) {
  const keep = reason => { warn(reason); onEdits?.([]); return text; };
  if (depth > 24) return keep('Embedded structure exceeds 24 levels; copied unchanged');
  // A scalar explicitly labelled as a secret may itself contain JSON/code
  // punctuation. Those characters are password data, not embedded syntax.
  if (fieldCategory(key, context, text) === 'secrets') {
    if (mode === 'discover') { detector.discover(text, key, context); return text; }
    const found = detector.spans(text, true, { key, context }).map(m => { m.row.occurrences++; return { start: m.start, stop: m.end, value: m.row.replacement }; });
    onEdits?.(found); return edits(text, found);
  }
  const trimmed = text.trim();
  try {
    if (/^[{[\"]/.test(trimmed)) return jsonText(text, detector, mode, context, warn, onEdits, depth + 1);
    if (/^<\?xml\b|^<[\w:.-]+(?:\s|>|\/)/.test(trimmed)) {
      if (/(?:^|_)html(?:$|_)/i.test(key) || /^<(?:!doctype\s+html|html|p|div|span|a|table)\b/i.test(trimmed)) return htmlText(text, detector, mode, warn, onEdits, depth + 1);
      return xmlText(text, detector, mode, warn, onEdits, depth + 1);
    }
    if (/^<!doctype\s+html/i.test(trimmed)) return htmlText(text, detector, mode, warn, onEdits, depth + 1);
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.message !== 'JSON nesting exceeds 256 levels.') throw error;
    return keep('Unparseable embedded structure; copied unchanged');
  }
  if (/[,\t]/.test(text) && /\r?\n[^\r\n]*[,\t]/.test(text)) return keep('Ambiguous delimited text; use a supported delimited format for value-only protection');
  if (!/[{}<>:=`~|#]/.test(text) && !/^\s*(?:\[|\/\/|\/\*|--|const\b|let\b|var\b|function\b|class\b|SELECT\b|INSERT\b|CREATE\b)/m.test(text)) {
    if (mode === 'discover') { detector.discover(text, key, context); return text; }
    const found = detector.spans(text, true, { key, context }).map(m => { m.row.occurrences++; return { start: m.start, stop: m.end, value: m.row.replacement }; });
    onEdits?.(found); return edits(text, found);
  }
  const changes = [];
  let fence = null;
  // Keys and delimiters are copied literally. This handles plain-text/log
  // assignments without pretending to implement YAML, TOML or source code.
  for (const line of text.matchAll(/[^\r\n]+|\r\n|[\r\n]/g)) {
    const raw = line[0]; if (/^[\r\n]+$/.test(raw)) continue;
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (marker) { fence = fence && marker[1][0] === fence ? null : marker[1][0]; warn('Fenced code copied unchanged'); continue; }
    if (fence) continue;
    // Preserve tables, comments, markup, ambiguous inline objects and code.
    if (/^\s*(?:\||#|\/\/|\/\*|--|<|\[)|^\s*(?:const|let|var|function|class|SELECT|INSERT|CREATE)\b/.test(raw)) { warn('Unparsed structured text copied unchanged'); continue; }
    const credentials = credentialAssignments(raw);
    if (credentials.length && !/[{}]/.test(raw.slice(0, credentials[0].start))) {
      assignedText(raw, credentials, detector, mode, key, context, warn,
        found => changes.push(...found.map(c => ({ ...c, start: line.index + c.start, stop: line.index + c.stop }))), depth);
      continue;
    }
    if (/[{}]/.test(raw)) { warn('Unparsed structured text copied unchanged'); continue; }
    // A compact assignment label is structural. A sentence containing a colon
    // remains prose, including names or other PII before that colon.
    const pair = /^(\s*(?:[-*]\s+)?)([^\s:=\r\n]+)(\s*[:=]\s*)(.*)$/.exec(raw);
    if (pair) {
      const offset = line.index + raw.length - pair[4].length;
      valueText(pair[4], detector, mode, pair[2].trim(), context, warn, found => changes.push(...found.map(c => ({ ...c, start: offset + c.start, stop: offset + c.stop }))), depth + 1);
    } else if (mode === 'discover') detector.discover(raw, key, context);
    else for (const m of detector.spans(raw, true, { key, context })) {
      m.row.occurrences++; changes.push({ start: line.index + m.start, stop: line.index + m.end, value: m.row.replacement });
    }
  }
  if (mode === 'discover') return text;
  onEdits?.(changes);
  return edits(text, changes);
}
