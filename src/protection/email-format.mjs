import { valueText } from './content.mjs';
import { htmlText, csvText, validateOutput } from './structured.mjs';
const editableHeader = /^(?:from|to|cc|bcc|reply-to|sender|subject|comments)$/i;
const utf8 = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer);
function isAttachment(headers) {
  const disposition = /^content-disposition:([^\r\n]*)/im.exec(headers)?.[1] || '';
  const contentType = /^content-type:([^\r\n]*)/im.exec(headers)?.[1] || '';
  return /^\s*attachment(?:\s*;|\s*$)/i.test(disposition) ||
    /;\s*filename(?:\*\d+)?\*?\s*=/i.test(disposition) || /;\s*name(?:\*\d+)?\*?\s*=/i.test(contentType);
}
function qpDecode(text) {
  const bytes = [];
  const raw = Buffer.from(text, 'utf8');
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 61 && raw[i + 1] === 13 && raw[i + 2] === 10) { i += 2; continue; }
    if (raw[i] === 61 && raw[i + 1] === 10) { i++; continue; }
    const hex = raw.subarray(i + 1, i + 3).toString('ascii');
    if (raw[i] === 61 && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(raw[i]);
  }
  return Buffer.from(bytes);
}
function qpEncode(text, newline) {
  return text.split(/\r\n|\n/).map(line => {
    let output = '', column = 0;
    for (const byte of Buffer.from(line)) {
      const token = byte >= 33 && byte <= 126 && byte !== 61 ? String.fromCharCode(byte) : '=' + byte.toString(16).toUpperCase().padStart(2, '0');
      if (column + token.length > 72) { output += '=' + newline; column = 0; }
      output += token; column += token.length;
    }
    return output;
  }).join(newline);
}
function encodedWords(text, detector, mode, warn, isName = false) {
  return text.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, encoding, content) => {
    if (!/^(?:utf-8|us-ascii)$/i.test(charset)) { warn('Unsupported encoded header charset'); return whole; }
    let decoded;
    try { decoded = utf8(encoding.toLowerCase() === 'b' ? Buffer.from(content, 'base64') : qpDecode(content.replace(/_/g, ' '))); }
    catch { warn('Invalid encoded header'); return whole; }
    if (mode === 'discover') { detector.discover(decoded); if (isName) detector.add(decoded, 'names'); return whole; }
    const changed = detector.replace(decoded, true);
    if (changed === decoded) return whole;
    const chunks = []; let chunk = '';
    for (const char of changed) {
      if (Buffer.byteLength(chunk + char) > (encoding.toLowerCase() === 'b' ? 36 : 18)) { chunks.push(chunk); chunk = ''; }
      chunk += char;
    }
    if (chunk) chunks.push(chunk);
    return chunks.map(part => `=?${charset}?${encoding}?${encoding.toLowerCase() === 'b' ? Buffer.from(part).toString('base64') : qpEncode(part, '').replaceAll('?', '=3F').replaceAll('_', '=5F')}?=`).join('\r\n ');
  });
}
function headerText(headers, detector, mode, warn) {
  // Keep MIME boundaries and transfer/content metadata byte-for-byte unchanged.
  return headers.replace(/(^|\r?\n)([^\s:]+):([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/g, (whole, newline, key, value) => {
    if (!editableHeader.test(key)) return whole;
    if (mode === 'discover') {
      detector.discover(value, key);
      if (/^(?:from|to|cc|bcc|reply-to|sender)$/i.test(key)) {
        const decoded = value.replace(/\r?\n[ \t]+/g, ' ').replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, encoding, content) => {
          if (!/^(?:utf-8|us-ascii)$/i.test(charset)) return whole;
          try { return utf8(encoding.toLowerCase() === 'b' ? Buffer.from(content, 'base64') : qpDecode(content.replace(/_/g, ' '))); } catch { return whole; }
        });
        detector.discover(decoded, key);
      }
      if (/^(?:from|to|cc|bcc|reply-to|sender)$/i.test(key)) {
        for (const match of value.matchAll(/(?:^|,)\s*"?([^"<>\r\n]+?)"?\s*<[^>]+>/g)) {
          if (!match[1].includes('=?')) detector.add(match[1].trim(), 'names');
        }
      }
    }
    let changed = encodedWords(value, detector, mode, warn, /^(?:from|to|cc|bcc|reply-to|sender)$/i.test(key));
    // Encoded words must be handled only after decoding, never as raw base64.
    if (mode !== 'discover') changed = changed.split(/(=\?[^?]+\?[bq]\?[^?]*\?=)/gi).map(part => /^=\?/.test(part) ? part : detector.replace(part)).join('');
    return newline + key + ':' + changed;
  });
}
function transformEmail(text, detector, mode, warn, depth = 0) {
  if (depth > 30) { warn('MIME nesting exceeds 30 levels'); return text; }
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator) { warn('Email has no header separator'); return text; }
  const headers = text.slice(0, separator.index), body = text.slice(separator.index + separator[0].length);
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const type = /^content-type:\s*([^;\r\n]+)/im.exec(unfolded)?.[1].trim().toLowerCase() || 'text/plain';
  if (/^(?:dkim-signature|arc-seal|arc-message-signature):/im.test(headers)) warn('Email signatures retained but may be invalid after replacement');
  const changedHeaders = headerText(headers, detector, mode, warn);
  const finish = value => changedHeaders.replace(/^(content-length:[ \t]*)\d+[ \t]*$/gim, (_, prefix) => prefix + Buffer.byteLength(value)) + separator[0] + value;
  if (isAttachment(unfolded)) { warn('Attachment content excluded from analysis and copied unchanged'); return finish(body); }
  if (type.startsWith('multipart/')) {
    const boundary = /boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(unfolded);
    if (!boundary) { warn('Multipart boundary missing'); return finish(body); }
    const marker = '--' + (boundary[1] || boundary[2]);
    const lines = [...body.matchAll(/^--[^\r\n]+(?:\r?\n|$)/gm)].filter(m => m[0].trimEnd() === marker || m[0].trimEnd() === marker + '--');
    if (lines.length < 2 || lines.at(-1)[0].trimEnd() !== marker + '--') { warn('Incomplete MIME boundaries'); return finish(body); }
    let output = body.slice(0, lines[0].index);
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]; output += line[0];
      output += transformEmail(body.slice(line.index + line[0].length, lines[i + 1].index), detector, mode, warn, depth + 1);
    }
    return finish(output + body.slice(lines.at(-1).index));
  }
  if (type === 'message/rfc822') return finish(transformEmail(body, detector, mode, warn, depth + 1));
  if (!/^text\/(?:plain|html|csv)$/.test(type)) { warn('Non-text MIME part copied unchanged'); return finish(body); }
  const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(unfolded)?.[1] || 'utf-8';
  if (!/^(?:utf-8|us-ascii)$/i.test(charset)) { warn('Unsupported MIME charset'); return finish(body); }
  const encoding = /^content-transfer-encoding:\s*([^\r\n]+)/im.exec(unfolded)?.[1].trim().toLowerCase() || '8bit';
  let decoded;
  try {
    if (encoding === 'base64') {
      if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) throw Error();
      decoded = utf8(Buffer.from(body.replace(/\s/g, ''), 'base64'));
    } else if (encoding === 'quoted-printable') decoded = utf8(qpDecode(body));
    else if (['7bit', '8bit', 'binary'].includes(encoding)) decoded = body;
    else { warn('Unsupported MIME transfer encoding'); return finish(body); }
  } catch { warn('Undecodable MIME text'); return finish(body); }
  let changed;
  if (type === 'text/html') changed = htmlText(decoded, detector, mode, warn);
  else if (type === 'text/csv') changed = csvText(decoded, detector, mode);
  else changed = valueText(decoded, detector, mode, '', 'email/body', warn);
  if (mode === 'discover') return text;
  if (changed === decoded) return finish(body);
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  if (encoding === 'base64') {
    const width = Math.min(76, Math.max(4, body.split(/\r?\n/)[0].length || 76));
    const encoded = Buffer.from(changed).toString('base64');
    return finish(encoded.match(new RegExp(`.{1,${width}}`, 'g'))?.join(newline) + (/\r?\n$/.test(body) ? newline : ''));
  }
  return finish(encoding === 'quoted-printable' ? qpEncode(changed, newline) : changed);
}
// Compare MIME topology and immutable headers, including exact binary payloads.
function layout(text, depth = 0) {
  if (depth > 30) return ['opaque', text];
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator) return ['opaque', text];
  const head = text.slice(0, separator.index), body = text.slice(separator.index + separator[0].length);
  const headers = [...head.matchAll(/(^|\r?\n)([^\s:]+):([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/g)].map(m => [m[2], editableHeader.test(m[2]) || /^content-length$/i.test(m[2]) ? null : m[3]]);
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const type = /^content-type:\s*([^;\r\n]+)/im.exec(unfolded)?.[1].trim().toLowerCase() || 'text/plain';
  if (isAttachment(unfolded)) return [headers, body];
  if (type.startsWith('multipart/')) {
    const boundary = /boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(unfolded);
    if (!boundary) return [headers, body];
    const marker = '--' + (boundary[1] || boundary[2]);
    const lines = [...body.matchAll(/^--[^\r\n]+(?:\r?\n|$)/gm)].filter(m => [marker, marker + '--'].includes(m[0].trimEnd()));
    if (!lines.length) return [headers, body];
    return [headers, body.slice(0, lines[0].index), lines.map(m => m[0]), lines.slice(0, -1).map((line, i) => layout(body.slice(line.index + line[0].length, lines[i + 1].index), depth + 1)), body.slice(lines.at(-1).index)];
  }
  return [headers, type === 'message/rfc822' ? layout(body, depth + 1) : /^text\/(?:plain|html|csv)$/.test(type) ? null : body];
}
export function emailText(text, detector, mode, warn = () => {}) {
  const output = transformEmail(text, detector, mode, warn);
  if (mode !== 'discover') validateOutput(() => { if (JSON.stringify(layout(text)) !== JSON.stringify(layout(output))) throw Error(); });
  return output;
}
