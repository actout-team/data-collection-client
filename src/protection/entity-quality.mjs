import { MODEL, LABELS } from './model-config.mjs';
// Supplemental deterministic recognition stays independent of the model.
// These rules do not gate contextual model predictions.
export const credentialPattern = /\b(?:xox[baprsco]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]+?-----END (?:[A-Z ]*PRIVATE KEY)-----/g;
const labelOnly = /^(?:password|passwd|pwd|secret|token|api[ _-]?key|email|e-mail|name|first|last|ssn|ein|iban|passport|account|number|address|phone|signature|unsubscribe|click|here|login|sign[ -]?in|privacy|policy|help|support)$/i;
const codeLabel = '(?:verification|confirmation|security|authentication|log[ -]?in|sign[ -]?in|one[ -]time|two[ -]factor) code';
const codeValue = '(?<![\\w.-])([0-9]{4,8})(?![\\w-]|\\.\\d)';
const codePatterns = [
  new RegExp(`\\b${codeLabel}\\s*(?::|=|\\bis\\b)\\s*${codeValue}`, 'gi'),
  new RegExp(`${codeValue}\\s+is your (?:[\\p{L}\\p{N}][\\p{L}\\p{N}.-]* ){0,4}${codeLabel}\\b`, 'giu')
];
export function plausibleCredential(value, { explicit = false } = {}) {
  const label = value?.replace(/[.!?]+$/, '');
  if (!value?.trim() || labelOnly.test(label) || /^(?:reset|expired|incorrect|invalid|required|protected|changed|encrypted|missing|none|null|undefined|true|false|redacted|hidden|not|the|your|a|an)$/i.test(label)) return false;
  if (/^(?:https?:)?\/\//i.test(value) || /(?:=\?|\?=|<[^>]+>)/.test(value)) return false;
  if (explicit) return true; // A labelled password can be a weak, ordinary word.
  return value.length >= 8 && !/\s/.test(value) && /[a-z]/i.test(value) && /[\d!@#$%^&*_=+/-]/.test(value);
}
export function credentialAssignments(text) {
  const found = [];
  const pattern = /\b(?:password|passwd|pwd|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token)\s*(?::|=|\bis\b)\s*(?:["']([^"'\r\n]+)["']|([^\s"'<>;,}&]+))/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[1] ?? match[2], quoted = match[1] !== undefined;
    if (plausibleCredential(value, { explicit: quoted || /[:=]/.test(match[0].slice(0, match[0].indexOf(value))) })) {
      const start = match.index + match[0].lastIndexOf(value); found.push({ start, end: start + value.length });
    }
  }
  for (const match of text.matchAll(/\b(?:Bearer|Basic)\s+([A-Za-z0-9+\/_=.-]{8,})/gi)) {
    const start = match.index + match[0].indexOf(match[1]); found.push({ start, end: start + match[1].length });
  }
  // Numeric codes need explicit authentication context, never digit shape alone.
  for (const pattern of codePatterns) for (const match of text.matchAll(pattern)) {
    const start = match.index + match[0].indexOf(match[1]); found.push({ start, end: start + match[1].length });
  }
  // Several rules can recognize the same value. The router requires disjoint,
  // source-ordered ranges before splitting prose around credential assignments.
  let end = -1;
  return found.sort((a, b) => a.start - b.start || b.end - a.end).filter(range => {
    if (range.start < end) return false;
    end = range.end; return true;
  });
}
// Semantic classification belongs to the model. Do not veto a prediction
// because its value lacks an English keyword, prefix, or hand-written shape.
// Structure boundaries, selected categories and public/owner policies are
// enforced separately by the format router and detector.
export function admitModelSpan(span, text) {
  const { start, end, category, score } = span;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= text.length && start < end
    && Object.values(LABELS).includes(category) && Number.isFinite(score) && score >= MODEL.threshold
    && Boolean(text.slice(start, end).trim());
}
