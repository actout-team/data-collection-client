import { passageKey, textWindows } from './model-context.mjs';
import { createOwnerPolicy } from './account-owners.mjs';
import { publicEntities } from './public-entities.mjs';
import { credentialPattern, credentialAssignments, plausibleCredential } from './entity-quality.mjs';
import { canonical } from './name-styles.mjs';
import { createReplacements } from './replacements.mjs';
import { protectionOptions } from '../../ui/protection-options.mjs';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalized = key => key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const email = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi;
const rules = {
  emails: email,
  phones: /(?:\+\d[\d ().-]{7,}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\(\d{3}\) ?\d{3}[-. ]\d{4})/g,
  secrets: credentialPattern,
  identifiers: /\b\d{3}-\d{2}-\d{4}\b/g
};
export function fieldCategory(key, context, value) {
  key = normalized(key);
  if (/^(?:password|passwd|pwd|secret|client_secret|api_key|apikey|access_token|refresh_token|auth_token|authorization|private_key|cookie|set_cookie)$/.test(key)) return 'secrets';
  if (/^(?:e_?mail|email_address)$/.test(key) || (key === 'address' && value.includes('@'))) return 'emails';
  if (/^(?:(?:mobile|home|work)_?)?(?:phone|telephone|mobile|fax)(?:_?number)?$/.test(key)) return 'phones';
  if (/^(?:first_?name|last_?name|surname|full_?name|real_name|real_name_normalized|display_?name|display_name_normalized|given_?name|family_?name|contact_name|customer_name|employee_name)$/.test(key) || (key === 'name' && /(?:users?|profile|contacts?|people|employees?|customers?|from|to|cc|bcc|sender|recipient)/i.test(context))) return 'names';
  if (/^(?:company|company_name|organization|organization_name|organisation|organisation_name|employer|business_name|legal_name)$/.test(key) || (key === 'name' && /(?:companies|organizations|organisations|employers)/i.test(context))) return 'companies';
  if (/^(?:street|street_address|address|address_line_?[12]|address[12]|postal_address|home_address|billing_address|shipping_address|street_name|city|town|postal_code|zip_code|postcode)$/.test(key)) return 'addresses';
  if (/^(?:ssn|social_security_number|tax_id|national_id|passport(?:_number)?|id_number|credit_card(?:_number)?|card_number|bank_account|account_number|iban|routing_number)$/.test(key)) return 'identifiers';
}
export function createDetector(categories, { observe, namePreference = 'auto', publicPolicy = publicEntities, ownerPolicy = createOwnerPolicy() } = {}) {
  if (!Array.isArray(categories) || !categories.length || new Set(categories).size !== categories.length || categories.some(c => !protectionOptions.some(o => o.id === c))) throw Error('Choose at least one protection option.');
  const selected = new Set(categories), entries = new Map(), replacements = new Map();
  const evidence = new Map(), serviceNames = new Set();
  let observationDepth = 0, activeContext = [];
  const observeValue = text => { if (!observationDepth && !publicPolicy.isEntity(text)) observe?.(text); };
  function withObservation(text, work) {
    observeValue(text);
    observationDepth++;
    try { return work(); } finally { observationDepth--; }
  }
  function withContext(text, work) {
    const previous = activeContext;
    activeContext = [...textWindows(text)].map(passageKey);
    try { return work(); } finally { activeContext = previous; }
  }
  let originalBytes = 0, publicCandidates = 0, guardedMatches = 0;
  const generator = createReplacements({ namePreference, publicPolicy });
  function add(value, category, detection = { source: 'field-or-rule' }, passage) {
    if (!selected.has(category) || value == null) return;
    value = String(value);
    if (!value.trim()) return;
    if (ownerPolicy.matches(category, value)) { ownerPolicy.preserve(); return; }
    if (passage !== undefined && (detection.source === 'model' || category === 'secrets')) {
      if (!evidence.has(value)) evidence.set(value, new Set());
      evidence.get(value).add(passageKey(passage));
    }
    if (entries.has(value)) {
      const row = entries.get(value);
      if (['secrets', 'identifiers'].includes(category) && !['secrets', 'identifiers'].includes(row.category)) { row.category = category; row.detection = detection; }
      if (row.category === category && detection.role === 'person-field') row.detection = { ...row.detection, ...detection };
      return;
    }
    if (['names', 'companies'].includes(category) && (detection.role !== 'person-field' || !detection.nameRole)) {
      if (publicPolicy.isEntity(value)) { publicCandidates++; return; }
      const protectedSpans = publicPolicy.spans(value);
      if (protectedSpans.length) {
        publicCandidates++;
        // Mixed model spans cannot rename the public portion. Discover remaining
        // private names separately, preserving connector words around the brand.
        let end = 0;
        for (const span of [...protectedSpans, { start: value.length, end: value.length }]) {
          const part = value.slice(end, span.start).replace(/^[\s,;:()]+|[\s,;:()]+$/g, '')
            .replace(/^(?:(?:at|from|via|with|for|of|and|the|using)\s+)+|(?:\s+(?:at|from|via|with|for|of|and|the|using))+$/gi, '').trim();
          if (part && !/^(?:at|from|via|with|for|of|and|the|using)$/i.test(part)) add(part, category, detection, passage);
          end = span.end;
        }
        return;
      }
    }
    if (value.length > 16384) throw Error('A sensitive field exceeds the supported size. No protected export was created.');
    originalBytes += Buffer.byteLength(value);
    if (originalBytes > 16 * 1024 * 1024) throw Error('Protection map exceeds 16 MiB of original values. Split the download.');
    if (entries.size >= 100000) throw Error('Protection reached 100,000 unique values. Split the export into smaller downloads.');
    entries.set(value, { category, original: value, replacement: null, occurrences: 0, detection });
  }

  function registerIdentity(record = {}, context = '') {
    const fields = Object.entries(record).filter(([,v]) => typeof v === 'string' && v.length <= 256);
    const find = pattern => fields.find(([key]) => pattern.test(normalized(key)))?.[1]?.trim();
    const first = find(/^(?:first_?name|given_?name)$/), last = find(/^(?:last_?name|family_?name|surname)$/);
    let name = find(/^(?:full_?name|display_?name|real_name|contact_name|customer_name|employee_name)$/);
    const address = find(/^(?:e_?mail|email_address|address)$/);
    name ||= address?.includes('@') ? find(/^name$/) : undefined;
    const full = name || [first, last].filter(Boolean).join(' ');
    ownerPolicy.registerName?.(address, full);
    if (!full || !/^[\p{L}\p{M} .,'’\-]+$/u.test(full) || publicPolicy.isEntity(full)) return;
    generator.registerIdentity({ name, first, last, email: address });
    // Generic sibling name/email records are explicit person records too.
    if (name) add(name, 'names', { source: 'identity-fields', role: 'person-field' });
  }
  function discover(text, key = '', context = '') {
    observeValue(text);
    const category = fieldCategory(key, context, text);
    if (category && !(category === 'names' && normalized(key) === 'name' && publicPolicy.isEntity(text)) && normalized(key) !== 'authorization' && (category !== 'secrets' || plausibleCredential(text, { explicit: true }))) add(text, category, { source: 'field-or-rule', ...(category === 'names' ? { role: 'person-field', ...(/^(?:first_?name|given_?name)$/.test(normalized(key)) ? { nameRole: 'given-name' } : /^(?:last_?name|family_?name|surname)$/.test(normalized(key)) ? { nameRole: 'family-name' } : {}) } : {}) });
    for (const [category, pattern] of Object.entries(rules)) if (selected.has(category)) {
      for (const match of text.matchAll(pattern)) {
        if (category === 'phones' && (match[0].replace(/\D/g, '').length < 9 || match[0].replace(/\D/g, '').length > 15)) continue;
        add(match[0], category, { source: 'field-or-rule' }, text);
      }
    }
    // Read each display-name/mailbox pair separately, including quoted recipients.
    for (const match of text.matchAll(/(?:^|[,;\n])\s*"?([\p{L}\p{M}][\p{L}\p{M} .’'\-]{0,200}?)"?\s*<([^<>\s]+@[^<>\s]+)>/gu)) registerIdentity({ name: match[1].trim(), email: match[2] }, context);
    if (selected.has('secrets')) {
      for (const { start, end } of credentialAssignments(text)) add(text.slice(start, end), 'secrets', { source: 'field-or-rule' }, text);
    }
  }
  let patterns;
  function compile() {
    for (const [value, row] of entries) if (ownerPolicy.matches(row.category, value)) entries.delete(value);
    // Generate after discovery so names inform every email, regardless of file order.
    generator.reserve([...ownerPolicy.reserved, ...entries.values()]);
    const sourceKeys = new Set([...entries.keys()].map(canonical));
    const ordered = [...entries.values()].sort((a, b) => (a.category === 'names' ? 0 : a.category === 'emails' ? 2 : 1) - (b.category === 'names' ? 0 : b.category === 'emails' ? 2 : 1) || b.original.length - a.original.length);
    for (const row of ordered) {
      if (row.replacement) continue;
      for (let attempt = 0; attempt < 100; attempt++) {
        const value = generator.generate(row.category, row.original, attempt);
        if (!sourceKeys.has(canonical(value)) && (!replacements.has(canonical(value)) || canonical(replacements.get(canonical(value))) === canonical(row.original))) { row.replacement = value; replacements.set(canonical(value), row.original); break; }
      }
      if (!row.replacement) throw Error(`Could not generate a unique replacement (${row.category}, ${row.original.length} characters, ${replacements.size} mapped values).`);
    }
    // A generated value must never equal another original discovered later.
    for (const row of entries.values()) if (sourceKeys.has(canonical(row.replacement))) throw Error('Replacement collision. Run protection again.');
    const values = [...entries.keys()].filter(v => v.length >= 3 || (v.length === 2 && entries.get(v).category === 'names' && /\p{L}/u.test(v))).sort((a, b) => b.length - a.length);
    patterns = [];
    for (let i = 0; i < values.length; i += 500) patterns.push(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${values.slice(i, i + 500).map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'gu'));
  }
  function spans(text, exact = false, { key = '', context = '' } = {}) {
    if (!patterns) compile();
    const found = exact && entries.has(text) ? [{ start: 0, end: text.length, row: entries.get(text) }] : [];
    const protectedSpans = publicPolicy.spans(text), ownerSpans = ownerPolicy.spans(text);
    const field = fieldCategory(key, context, text);
    const passages = [...activeContext, ...[...textWindows(text)].map(passageKey)];
    if (!found.length) for (const pattern of patterns) for (const m of text.matchAll(pattern)) found.push({ start: m.index, end: m.index + m[0].length, row: entries.get(m[0]) });
    // A name inside an email local-part is not a separate name occurrence.
    const emailSpans = [...text.matchAll(email)].map(m => ({ start: m.index, end: m.index + m[0].length }));
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = -1, publicIndex = 0, emailIndex = 0;
    return found.filter(m => {
      while (publicIndex < protectedSpans.length && protectedSpans[publicIndex].end <= m.start) publicIndex++;
      while (emailIndex < emailSpans.length && emailSpans[emailIndex].end <= m.start) emailIndex++;
      const protectedSpan = protectedSpans[publicIndex], emailSpan = emailSpans[emailIndex];
      // Credentials remain sensitive even when their literal value is a brand.
      // An email replacement may change its local part, but must keep a public host.
      const credentialValue = field === 'secrets' || credentialAssignments(text).some(s => m.start >= s.start && m.end <= s.end);
      const privateIdentifier = field === 'identifiers';
      // A model decision belongs to the passage that produced it. Reuse the
      // replacement, but do not turn a contextual detection into a global rule.
      const contexts = evidence.get(m.row.original);
      if (contexts && !credentialValue && field !== m.row.category && !passages.some(k => contexts.has(k))) return false;
      if (!credentialValue && !privateIdentifier && serviceNames.has(canonical(text))) return false;
      if (!credentialValue && !privateIdentifier && (ownerPolicy.matches(m.row.category, m.row.original) || ownerSpans.some(s => s.category === 'emails' ? m.start < s.end && m.end > s.start : m.start >= s.start && m.end <= s.end))) { ownerPolicy.preserve(); return false; }
      const personValue = m.row.category === 'names' && field === 'names' && m.row.detection.role === 'person-field';
      const addressValue = m.row.category === 'addresses' && !publicPolicy.isEntity(m.row.original);
      if (!credentialValue && !personValue && !addressValue && protectedSpan && m.end > protectedSpan.start) {
        const at = m.row.original.lastIndexOf('@');
        const publicEmail = ['emails', 'secrets'].includes(m.row.category) && /^[^\s@]+@[^\s@]+$/.test(m.row.original) && at > 0 && publicPolicy.isDomain(m.row.original.slice(at + 1));
        if (!publicEmail || m.row.replacement.slice(m.row.replacement.lastIndexOf('@') + 1) !== m.row.original.slice(at + 1)) { guardedMatches++; return false; }
      }
      if (emailSpan && m.start >= emailSpan.start && m.end <= emailSpan.end && (m.start !== emailSpan.start || m.end !== emailSpan.end)) return false;
      if (m.start < end) return false; end = m.end; return true;
    });
  }
  function replace(text, exact = false) {
    let end = 0, output = '';
    for (const m of spans(text, exact)) { output += text.slice(end, m.start) + m.row.replacement; end = m.end; m.row.occurrences++; }
    return output + text.slice(end);
  }
  function registerService(record) {
    for (const value of [record.name, record.real_name, record.profile?.real_name, record.profile?.display_name]) {
      if (typeof value === 'string' && value.trim()) serviceNames.add(canonical(value));
    }
  }
  return { observeContext: observeValue, withContext, registerService, add, discover, withObservation, registerIdentity, spans, replace, entries, compile, prepare: options => { generator.reserve(ownerPolicy.reserved); return generator.prepare(entries.values(), options); }, get generation() { return generator.info; }, get publicPolicy() { return { ...publicPolicy.info, excludedCandidates: publicCandidates, guardedMatches }; } };
}
