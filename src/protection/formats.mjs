import { exportStructure, serviceRecord, serviceIdentityField } from './export-schema.mjs';
import { valueText } from './content.mjs';
import { fieldCategory } from './detect.mjs';
import { edits, validateOutput } from './structured.mjs';
// Edit scalar spans rather than stringify JSON: whitespace, key order and all
// bytes outside the replaced values stay intact, including existing escapes.
function stringOffsets(raw) {
  const offsets = [1];
  let i = 1;
  while (i < raw.length - 1) {
    if (raw[i] === '\\') i += raw[i + 1] === 'u' ? 6 : 2;
    else i++;
    offsets.push(i);
  }
  return offsets;
}
function scalars(text, onObject, structural = () => false) {
  JSON.parse(text); // Refuse malformed input rather than damaging it.
  const tokens = [...text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g)];
  let i = 0; const values = [];
  function value(path, key, depth) {
    if (depth > 256) throw Error('JSON nesting exceeds 256 levels.');
    const token = tokens[i++], raw = token[0];
    if (raw === '{') {
      const first = values.length, members = [];
      while (tokens[i][0] !== '}') {
        const name = JSON.parse(tokens[i++][0]); i++; const begin = values.length; value([...path, name], name, depth + 1);
        members.push({ name, begin, stop: values.length });
        if (tokens[i][0] === ',') i++;
      }
      // Name/value pairs encode field names as scalars (CRM properties, email
      // headers, generic custom fields). Treat those names as schema in both passes.
      const descriptor = members.some(m => /^(?:value|values|text_value|display_value)$/i.test(m.name));
      const normalize = name => name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      const schemaContext = /(?:^|\/)(?:schema|fields|custom_fields|headers)(?:\/|$)/i.test(path.join('/'))
        || (/(?:^|\/)properties(?:\/|$)/i.test(path.join('/')) && members.some(p => /^(?:type|field_type|data_type)$/.test(normalize(p.name))));
      const names = members.filter(m => /^(?:field_name|property_name|column_name)$/.test(normalize(m.name))
        || ((descriptor || schemaContext) && /^(?:name|key|field|property|column|label)$/.test(normalize(m.name))));
      for (const member of names) for (let n = member.begin; n < member.stop; n++) values[n].schema = true;
      const label = names.flatMap(m => values.slice(m.begin, m.stop)).find(p => p.string)?.value;
      if (descriptor && label) for (let n = first; n < values.length; n++) if (/^(?:value|values|text_value|display_value)$/.test(values[n].key)) values[n].key = label;
      if (onObject && !descriptor && !schemaContext) {
        const record = Object.create(null);
        for (const member of members) {
          const part = values[member.begin];
          if (member.stop === member.begin + 1 && part?.string && !part.schema && part.path.length === path.length + 1) record[member.name] = part.value;
        }
        onObject(record, path);
      }
      i++; return;
    }
    if (raw === '[') {
      while (tokens[i][0] !== ']') { value(path, key, depth + 1); if (tokens[i][0] === ',') i++; }
      i++; return;
    }
    if (raw.startsWith('"') || /^-?\d/.test(raw)) values.push({ raw, start: token.index, end: token.index + raw.length, value: raw.startsWith('"') ? JSON.parse(raw) : raw, key, path, schema: structural(path), string: raw.startsWith('"') });
  }
  value([], '', 0); return values;
}
export function jsonText(text, detector, mode, context = '', warn = () => {}, onEdits, depth = 0) {
  if (!text.trim()) { onEdits?.([]); return text; }
  const contract = exportStructure(context, depth);
  const record = JSON.parse(text), service = serviceRecord(context, record, depth);
  if (service && mode === 'discover') detector.registerService?.(record);
  const structural = path => contract(path) || (service && serviceIdentityField(path));
  const parts = scalars(text, mode === 'discover' ? (record, path) => detector.registerIdentity?.(record, context + '/' + path.join('/')) : undefined, structural), changes = [];
  for (const part of parts) {
    if (part.schema) continue;
    const location = context + '/' + part.path.join('/');
    if (part.string) {
      const offsets = stringOffsets(part.raw);
      valueText(part.value, detector, mode, part.key, location, warn, found => {
        changes.push(...found.map(c => ({ start: part.start + offsets[c.start], stop: part.start + offsets[c.stop], value: JSON.stringify(c.value).slice(1, -1) })));
      }, depth);
    } else if (mode === 'discover') detector.discover(part.value, part.key, location);
    else {
      const matches = detector.spans(part.value, true, { key: part.key, context: location });
      if (fieldCategory(part.key, location, part.value) && matches.length === 1 && matches[0].start === 0 && matches[0].end === part.raw.length && /^\d+$/.test(matches[0].row.replacement)) {
        changes.push({ start: part.start, stop: part.end, value: matches[0].row.replacement }); matches[0].row.occurrences++;
      }
    }
  }
  if (mode === 'discover') return text;
  const output = edits(text, changes);
  // Schema-valued scalars are part of the immutable skeleton too.
  const skeleton = (value, spans) => edits(value, spans.filter(p => !p.schema).map(p => ({ start: p.start, stop: p.end, value: p.string ? '""' : '0' })));
  validateOutput(() => { if (skeleton(text, parts) !== skeleton(output, scalars(output, undefined, structural))) throw Error(); });
  onEdits?.(changes);
  return output;
}
export { emailText } from './email-format.mjs';
