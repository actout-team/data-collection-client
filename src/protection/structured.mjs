import { valueText } from './content.mjs';
import { parse, parseFragment } from 'parse5';
import { SaxesParser } from 'saxes';
import { parse as parseCsv } from 'csv-parse/sync';
import { decodeHTMLStrict, decodeXML } from 'entities';

export function validateOutput(check) {
  try { check(); } catch { throw Error('Protected file failed format validation. No protected copy was published.'); }
}
export function edits(text, changes) {
  let end = 0, output = '';
  for (const { start, stop, value } of changes.sort((a, b) => a.start - b.start)) {
    if (start < end) throw Error('Overlapping structured text edits.');
    output += text.slice(end, start) + value; end = stop;
  }
  return output + text.slice(end);
}
const escapeMarkup = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Map decoded entities back to their exact source spans. Unchanged escapes stay exact.
function decodedMarkup(raw, xml = false) {
  let value = '', offsets = [0];
  for (let i = 0; i < raw.length;) {
    const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/.exec(raw.slice(i));
    const source = entity?.[0] || raw[i], decoded = (xml ? decodeXML : decodeHTMLStrict)(source);
    value += decoded;
    for (let j = 1; j <= decoded.length; j++) offsets.push(i + (j === decoded.length ? source.length : 0));
    i += source.length;
  }
  return { value, offsets };
}
function markupValue(raw, detector, mode, key, context, xml = false, unquoted = false, onEdits, warn = () => {}, depth = 0) {
  const { value, offsets } = decodedMarkup(raw, xml);
  let inner = [];
  valueText(value, detector, mode, key, context, warn, found => { inner = found; }, depth);
  if (mode === 'discover') return raw;
  const changes = inner.map(match => {
    let replacement = escapeMarkup(match.value);
    if (unquoted) replacement = replacement.replace(/[\s=`]/g, c => `&#${c.codePointAt(0)};`);
    return { start: offsets[match.start], stop: offsets[match.stop], value: replacement };
  });
  onEdits?.(changes);
  return edits(raw, changes);
}
const htmlTree = text => (/<(?:!doctype|html|head|body)\b/i.test(text) ? parse : parseFragment)(text, { sourceCodeLocationInfo: true });
const excludedHtml = /^(?:script|style|xmp|iframe|noembed|noframes|plaintext)$/;
const blockHtml = /^(?:address|article|aside|blockquote|br|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)$/;
const children = node => [...(node.childNodes || []), ...(node.content ? [node.content] : [])];
function htmlShape(node) {
  return [node.nodeName, node.namespaceURI, node.attrs?.map(a => [a.name, a.namespace, a.prefix]), children(node).filter(child => child.nodeName !== '#text').map(htmlShape)];
}
export function htmlText(text, detector, mode, warn = () => {}, onEdits, depth = 0) {
  const tree = htmlTree(text), changes = [];
  // Read contiguous inline text as one contextual passage. Keep source offsets
  // for every decoded node so predictions can be applied without touching tags.
  let run = [], length = 0;
  const flush = () => {
    if (!run.length) return;
    const joined = run.map(item => item.value).join('');
    valueText(joined, detector, mode, '', 'html', warn, found => {
      for (const change of found) {
        const parts = run.filter(item => change.start < item.start + item.value.length && change.stop > item.start);
        const replacement = [...change.value];
        let consumed = 0, previous = 0;
        for (const item of parts) {
          const start = Math.max(change.start, item.start) - item.start;
          const stop = Math.min(change.stop, item.start + item.value.length) - item.start;
          consumed += stop - start;
          const end = Math.round(replacement.length * consumed / (change.stop - change.start));
          changes.push({ start: item.sourceStart + item.offsets[start], stop: item.sourceStart + item.offsets[stop], value: escapeMarkup(replacement.slice(previous, end).join('')) });
          previous = end;
        }
      }
    }, depth);
    run = []; length = 0;
  };
  function collect(node) {
    if (excludedHtml.test(node.tagName || '')) { flush(); return; }
    const boundary = blockHtml.test(node.tagName || '');
    if (boundary) flush();
    const location = node.sourceCodeLocation;
    if (node.nodeName === '#text' && location) {
      const raw = text.slice(location.startOffset, location.endOffset);
      if (/<[a-zA-Z!/?]/.test(raw)) { flush(); warn('Ambiguous HTML text location copied unchanged'); }
      else { const decoded = decodedMarkup(raw); run.push({ ...decoded, start: length, sourceStart: location.startOffset }); length += decoded.value.length; }
    }
    for (const child of children(node)) collect(child);
    if (boundary) flush();
  }
  // Preserve visible document context across block boundaries for semantic
  // detection, retaining local passages too: model recall depends on context
  // size. Apply decisions only through the original node offsets.
  const visible = [];
  function context(node) {
    if (excludedHtml.test(node.tagName || '')) return;
    if (node.nodeName === '#text') visible.push(node.value);
    const block = blockHtml.test(node.tagName || '');
    if (block) visible.push('\n');
    for (const child of children(node)) context(child);
    if (block) visible.push('\n');
  }
  context(tree);
  const passage = visible.join(''), scan = () => { collect(tree); flush(); };
  if (mode === 'discover') {
    detector.observeContext?.(passage);
    scan();
  }
  else if (detector.withContext) detector.withContext(passage, scan);
  else scan();
  const editContent = (start, stop, key = '', unquoted = false) => markupValue(text.slice(start, stop), detector, mode, key, 'html', false, unquoted, values => changes.push(...values.map(v => ({ start: start + v.start, stop: start + v.stop, value: v.value }))), warn, depth);
  function visit(node, excluded = false) {
    excluded ||= excludedHtml.test(node.tagName || '');
    if (excluded && node.value?.trim()) warn('Embedded scripts or styles copied unchanged');
    const location = node.sourceCodeLocation;
    if (!excluded) for (const attr of node.attrs || []) {
      if (!/^(?:alt|title|aria-label|placeholder|value)$/.test(attr.name) && !(attr.name === 'href' && /^mailto:/i.test(attr.value))) continue;
      const position = location?.attrs?.[attr.name]; if (!position) continue;
      const raw = text.slice(position.startOffset, position.endOffset), match = /=\s*(?:"([\s\S]*)"|'([\s\S]*)'|([^\s>]*))$/.exec(raw);
      if (!match) continue;
      const content = match[1] ?? match[2] ?? match[3], quoted = match[3] === undefined;
      const start = position.endOffset - content.length - (quoted ? 1 : 0);
      const field = attr.name === 'value' ? (node.attrs.some(a => a.name === 'type' && a.value.toLowerCase() === 'password') ? 'password' : node.attrs.find(a => a.name === 'name')?.value || attr.name) : attr.name;
      editContent(start, start + content.length, field, !quoted);
    }
    for (const child of children(node)) visit(child, excluded);
  }
  visit(tree);
  if (mode === 'discover') return text;
  const output = edits(text, changes);
  validateOutput(() => { if (JSON.stringify(htmlShape(tree)) !== JSON.stringify(htmlShape(htmlTree(output)))) throw Error(); });
  onEdits?.(changes);
  return output;
}
function xmlShape(text, onRecord) {
  const shape = [], parser = new SaxesParser({ xmlns: true });
  const records = [];
  parser.on('opentag', tag => {
    shape.push(['open', tag.name, tag.uri, Object.values(tag.attributes).map(a => [a.name, a.uri])]);
    if (onRecord) {
      if (records.length) records.at(-1).nested = true;
      records.push({ name: tag.local, text: '', nested: false, fields: Object.fromEntries(Object.values(tag.attributes).filter(a => !a.prefix && a.value.length <= 256).map(a => [a.local, a.value])) });
    }
  });
  const content = value => { if (onRecord && records.length && records.at(-1).text.length <= 256) records.at(-1).text += value; };
  parser.on('text', content); parser.on('cdata', content);
  parser.on('closetag', tag => {
    shape.push(['close', tag.name]);
    if (!onRecord) return;
    const item = records.pop();
    if (!/^(?:property|field|header|column|schema)$/.test(item.name) && !Object.hasOwn(item.fields, 'value')) onRecord(item.fields, records.map(r => r.name).concat(item.name).join('/'));
    if (records.length && !item.nested && item.text.length <= 256) {
      const parent = records.at(-1);
      // Repeated siblings are separate records, never an arbitrary chosen identity.
      parent.fields[item.name] = Object.hasOwn(parent.fields, item.name) ? null : item.text.trim();
    }
  });
  parser.on('error', () => { throw new SyntaxError('Invalid XML'); });
  parser.write(text).close(); return JSON.stringify(shape);
}
export function xmlText(text, detector, mode, warn = () => {}, onEdits, depth = 0) {
  if (/<!DOCTYPE\b/i.test(text)) throw new SyntaxError('XML with a DTD is unsupported');
  const before = xmlShape(text, mode === 'discover' ? (record, context) => detector.registerIdentity?.(record, context) : undefined), changes = [], stack = [];
  const isSchema = () => stack.some((name, i) => /^(?:key|field_name|property_name)$/.test(name.split(':').at(-1)) || (name.split(':').at(-1) === 'name' && /^(?:property|field|header|column)$/.test((stack[i - 1] || '').split(':').at(-1))));
  for (const match of text.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'">])*?>|[^<]+/g)) {
    const raw = match[0], start = match.index;
    if (raw.startsWith('<!--') || raw.startsWith('<?')) continue;
    if (raw.startsWith('<![CDATA[')) {
      const value = raw.slice(9, -3);
      if (!isSchema()) valueText(value, detector, mode, stack.at(-1)?.split(':').at(-1), stack.join('/'), warn, found => changes.push(...found.map(c => ({ ...c, start: start + 9 + c.start, stop: start + 9 + c.stop }))), depth);
    } else if (raw.startsWith('</')) stack.pop();
    else if (raw.startsWith('<')) {
      const name = /^<([^\s/>]+)/.exec(raw)[1];
      for (const attr of raw.matchAll(/([^\s=<>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
        if (/^xmlns(?::|$)/.test(attr[1]) || /^(?:key|field|property|field_name|property_name)$/.test(attr[1]) || (attr[1] === 'name' && /^(?:property|field|header|column)$/.test(name.split(':').at(-1)))) continue;
        const offset = start + attr.index + attr[0].length - attr[3].length - 1;
        const descriptor = /^(?:property|field|header|column)$/.test(name.split(':').at(-1)) ? /\s(?:name|key|field_name|property_name)\s*=\s*(["'])([\s\S]*?)\1/.exec(raw)?.[2] : undefined;
        const field = attr[1] === 'value' && descriptor ? decodeXML(descriptor) : attr[1].split(':').at(-1);
        changes.push({ start: offset, stop: offset + attr[3].length, value: markupValue(attr[3], detector, mode, field, [...stack, name].join('/'), true, false, undefined, warn, depth) });
      }
      if (!raw.endsWith('/>')) stack.push(name);
    } else if (!isSchema()) changes.push({ start, stop: start + raw.length, value: markupValue(raw, detector, mode, stack.at(-1)?.split(':').at(-1), stack.join('/'), true, false, undefined, warn, depth) });
  }
  if (mode === 'discover') return text;
  const output = edits(text, changes);
  validateOutput(() => { if (xmlShape(output) !== before) throw Error(); });
  onEdits?.(changes.filter(c => text.slice(c.start, c.stop) !== c.value));
  return output;
}
export function csvText(text, detector, mode, warn = () => {}, onEdits) {
  let rows;
  try { rows = parseCsv(text, { relax_column_count: true }); } catch { throw new SyntaxError('Invalid CSV'); }
  if (mode === 'discover' && new Set(rows[0]).size === rows[0]?.length) for (const row of rows.slice(1)) detector.registerIdentity?.(Object.fromEntries((rows[0] || []).map((key, i) => [key, row[i]])), 'csv');
  const changes = [], cell = /("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n|\n|\r|$)/gy;
  let row = 0, column = 0, match;
  while ((match = cell.exec(text)) && match[0]) {
    const raw = match[1], quoted = raw.startsWith('"'), value = quoted ? raw.slice(1, -1).replaceAll('""', '"') : raw;
    // Export CSVs have a header row. Column names are schema, not data.
    if (row > 0) {
      if (mode === 'discover') valueText(value, detector, mode, rows[0]?.[column] || '', 'csv', warn);
      else {
        const changed = valueText(value, detector, mode, rows[0]?.[column] || '', 'csv', warn);
        if (changed !== value) changes.push({ start: match.index, stop: match.index + raw.length, value: quoted || /[",\r\n]/.test(changed) ? '"' + changed.replaceAll('"', '""') + '"' : changed });
      }
    }
    if (match[2] === ',') column++; else { row++; column = 0; }
  }
  if (mode === 'discover') return text;
  const output = edits(text, changes);
  validateOutput(() => {
    const after = parseCsv(output, { relax_column_count: true });
    if (JSON.stringify(rows.map(r => r.length)) !== JSON.stringify(after.map(r => r.length)) || JSON.stringify(rows[0]) !== JSON.stringify(after[0])) throw Error();
  });
  onEdits?.(changes);
  return output;
}
