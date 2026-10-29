const allowed = new Set(['names', 'emails', 'phones', 'addresses']);
const canonical = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Authenticated owners belong to the download, not to individual files. An
// owner's address in another connector's message is still the same address.
export function createOwnerPolicy(owners = []) {
  const accounts = owners.filter(o => o?.verified === true && o.source === 'authenticated-self-profile' && /^[a-z0-9-]+$/.test(o.app) && typeof o.accountKey === 'string');
  const values = new Map(), patterns = [], reserved = [];
  let preserved = 0, linkedNames = 0;
  function reserve(category, value) {
    if (typeof value !== 'string' || value.trim().length < 2 || value.length > 256) return;
    const key = category === 'phones' ? value.replace(/\D/g, '') : canonical(value);
    if (!key || values.get(category)?.has(key)) return;
    if (!values.has(category)) values.set(category, new Set());
    values.get(category).add(key);
    reserved.push({ category, original: value });
    const pattern = category === 'phones' ? '\\+?' + key.split('').join('[\\s().+\\-]*') : value.trim().split(/\s+/).map(escape).join('\\s+');
    // An owner mailbox is not a prefix exemption for a different mailbox.
    const boundary = category === 'emails' ? '\\p{L}\\p{N}_@.+\\-' : '\\p{L}\\p{N}_';
    const after = category === 'emails' ? '(?![\\p{L}\\p{N}_@+\\-]|\\.[\\p{L}\\p{N}])' : `(?![${boundary}])`;
    // A leading @ or Hebrew "to" can be joined to a verified mailbox in
    // rendered contact text. Keep all other local-part/domain boundaries.
    const wrapper = category === 'emails' ? '(?:@|אל)?' : '';
    patterns.push({ category, pattern: new RegExp(`(?<![${boundary}])${wrapper}(${pattern})${after}`, 'giu') });
  }
  for (const account of accounts) for (const category of allowed) for (const value of account[category] || []) reserve(category, value);
  return {
    registerName(email, name) {
      if (typeof email === 'string' && values.get('emails')?.has(canonical(email))) {
        const count = reserved.length;
        reserve('names', name);
        linkedNames += reserved.length - count;
      }
    },
    matches(category, value) {
      if (!allowed.has(category)) return false;
      return values.get(category)?.has(category === 'phones' ? value.replace(/\D/g, '') : canonical(value)) || false;
    },
    spans(text) { return patterns.flatMap(({ category, pattern }) => [...text.matchAll(pattern)].map(m => ({ category, start: m.index + m[0].length - m[1].length, end: m.index + m[0].length }))); },
    preserve() { preserved++; },
    get reserved() { return reserved; },
    get info() { return { policy: 'verified-owner-contact-values-v4', linkedNames, scope: 'whole-export', accounts: accounts.length, scopes: [...new Set(accounts.map(o => o.app))], preservedDecisions: preserved, sensitiveCategoriesExempt: false, missingProfileScopes: accounts.filter(o => !o.names?.length).map(o => o.app) }; },
  };
}
