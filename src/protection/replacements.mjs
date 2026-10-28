import { genderStyle, givenPool, familyPool } from './name-profile.mjs';
import { createIdentityLinks } from './identity-links.mjs';
import { publicEntities } from './public-entities.mjs';
import { randomInt } from 'node:crypto';
import { canonical as canon, namePools, nameStyle, nameStyleOptions, sameScript } from './name-styles.mjs';
import { pick, styled, randomShape, phoneShape } from './value-shapes.mjs';
export { styled, randomShape } from './value-shapes.mjs';
const letters = n => Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const words = value => [...value.matchAll(/\p{L}[\p{L}\p{M}]*/gu)];
const street = 'Willow Cedar Aspen Birch Juniper Laurel Meadow Orchard Brook Harbor Valley Forest Summit Garden Grove Autumn Spring River Silver Golden Amber Copper Hazel'.split(' ');
const legal = /(?:\s|^)(?:Inc\.?|Incorporated|LLC|LLP|LP|Ltd\.?|Limited|Corp\.?|Corporation|PLC|GmbH|AG|BV|NV|SARL|SAS|SA|S\.A\.|S\.r\.l\.|Pty\.?\s+Ltd\.?|Pte\.?\s+Ltd\.?|בע[״"׳']?מ|有限公司|株式会社)\s*$/iu;
const functional = /^(?:labs?|technologies|technology|tech|systems|solutions|consulting|group|holdings|partners|ventures|capital|studio|studios|digital|software|services|industries|and|the|of|de|del|da|dos|van|von)$/i;
const companyWords = 'Cedar Harbor Summit Meadow Silver Beacon Grove River Amber Orchard Copper Alpine Willow Meridian Northstar Bright Mosaic Flint Birch Clover Juniper'.split(' ');
// Compose pronounceable brands from a large space; the old 10 x 10 pool
// exhausted during ordinary exports with hundreds of company tokens.
const brandConsonants = [...'bcdfghklmnprstvz'];
const brandVowels = [...'aeiou'];
const distinctSpelling = (a, b) => {
  a = canon(a); b = canon(b);
  return a !== b && !(a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)));
};
const title = /^(?:mr|mrs|ms|dr|prof|sir|sr|jr)$/i;
// Choose a replacement format, never whether to accept a model detection.
// A model's email span can be a fragment or an obfuscated address.
const mailboxParts = value => /^([^\s@<>]+)@([^\s@<>]+\.[^\s@<>]+)$/u.exec(value);
function pieces(original, category) {
  const suffix = category === 'companies' ? legal.exec(original) : null;
  return words(original).filter(m => (!suffix || m.index < suffix.index) && !(category === 'companies' ? functional : title).test(m[0]));
}
function assemble(original, tokens, values) {
  let output = '', end = 0;
  tokens.forEach((m, i) => { output += original.slice(end, m.index) + styled(values[i], m[0]); end = m.index + m[0].length; });
  return output + original.slice(end);
}
export function createReplacements({ namePreference = 'auto', publicPolicy = publicEntities } = {}) {
  if (!nameStyleOptions.some(([id]) => id === namePreference)) throw Error('Unknown replacement name style.');
  const components = new Map(), componentStyles = new Map(), domains = new Map(), locations = new Map(), phones = new Map(), companies = new Map(), companyComponents = new Map();
  const forbidden = new Set(), usedComponents = new Set(), usedCompanies = new Set(), usedBrandTokens = new Set(), usedDomains = new Set(), sourceDomains = new Set(), brandDomains = new Map();
  const notes = new Set(), componentRoles = new Map(), identities = createIdentityLinks();
  function registerIdentity({ name, first, last, email } = {}) {
    const full = name || [first, last].filter(Boolean).join(' ');
    if (!full) return;
    const style = nameStyle(full, namePreference);
    for (const part of pieces(full, 'names')) if (!componentStyles.has(canon(part[0]))) componentStyles.set(canon(part[0]), style.locale);
    for (const [value, role] of [[first, 'given-name'], [last, 'family-name']]) if (value) for (const part of pieces(value, 'names')) componentRoles.set(canon(part[0]), role);
    identities.addName(full); if (email) identities.bind(full, email);
  }
  const roleFor = (word, i, count) => componentRoles.get(canon(word)) || (i === count - 1 && count > 1 ? 'family-name' : 'given-name');
  const poolFor = (word, surname, locale) => surname ? familyPool(locale, word) : givenPool(locale, genderStyle(word, locale));
  const stats = { modelEntities: 0, poolEntities: 0, fallbackEntities: 0, emailFallbackEntities: 0, expandedValues: 0 };
  const emailFallbacks = new Set();
  function noteEmailFallback(original) {
    if (!emailFallbacks.has(original)) { emailFallbacks.add(original); stats.emailFallbackEntities++; }
    notes.add('Some email detections were fragments or nonstandard addresses. They received synthetic text replacements and are marked for review; mailbox format and name/email correlation are unverified.');
  }
  const available = (v, used) => !publicPolicy.isEntity(v) && !forbidden.has(canon(v)) && !used.has(canon(v)) && !usedBrandTokens.has(canon(v));
  function component(word, surname = false, locale = 'en') {
    const key = canon(word);
    if (!components.has(key)) {
      locale = componentStyles.get(key) || locale;
      surname = componentRoles.has(key) ? componentRoles.get(key) === 'family-name' : surname;
      const data = namePools[locale] || namePools.en;
      const list = poolFor(word, surname, locale);
      const near = list.filter(n => Math.abs([...n].length - [...word].length) <= 2 && sameScript(n, word) && distinctSpelling(n, word) && available(n, usedComponents));
      let value;
      for (let i = 0; i < 1024; i++) {
        if ([...word].length === 1 && i < 64) value = randomShape(word);
        else if (i < 32 && near.length) value = pick(near);
        else if (list.some(n => sameScript(n, word) && distinctSpelling(n, word) && available(n, usedComponents))) value = pick(list.filter(n => sameScript(n, word) && distinctSpelling(n, word) && available(n, usedComponents)));
        else if (sameScript(word, data.alphabet[0])) {
          // Grow pronounceable pools from local spelling fragments, without numeric suffixes.
          const a = [...pick(list)], b = [...pick(list)];
          value = a.slice(0, Math.max(1, Math.ceil(a.length / 2))).join('') + b.slice(Math.floor(b.length / 2)).join('');
          if (i > 128) value += pick([...data.alphabet]) + pick([...data.alphabet]);
        } else value = randomShape(word);
        if (available(value, usedComponents) && distinctSpelling(value, word)) break;
        value = null;
      }
      if (!value) throw Error('Name replacement space exhausted. Choose the local model or a different spelling style.');
      if ([...word].length === 1 && [...value].length > 1) { notes.add('Some initials expanded because no unused one-letter replacement remained.'); stats.expandedValues++; }
      components.set(key, value); usedComponents.add(canon(value));
    }
    return styled(components.get(key), word);
  }
  function name(original) {
    const tokens = pieces(original, 'names'), style = nameStyle(original, namePreference);
    return assemble(original, tokens, tokens.map((m, i) => component(m[0], roleFor(m[0], i, tokens.length) === 'family-name', style.locale)));
  }
  function companyToken(word, pending, sourceTokens) {
    const key = canon(word), known = companyComponents.get(key) || pending.get(key);
    if (known) return styled(known, word);
    for (let retry = 0; retry < 1024; retry++) {
      const generate = part => {
        const near = companyWords.filter(w => Math.abs(w.length - part.length) <= 2 && distinctSpelling(w, part) && available(w, usedComponents));
        if (retry < 16 && near.length) return styled(pick(near), part);
        const syllables = Math.min(6, 3 + Math.floor(retry / 128));
        return styled(Array.from({ length: syllables }, () => pick(brandConsonants) + pick(brandVowels)).join(''), part);
      };
      const camel = word.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g);
      const value = /^[A-Z]{2,6}$/.test(word) || /[^\p{Script=Latin}\p{M}]/u.test(word)
        ? randomShape(word)
        : camel?.join('') === word && camel.length > 1 ? camel.map(generate).join('') : generate(word);
      if (available(value, usedComponents) && ![...pending.values()].some(v => canon(v) === canon(value)) && sourceTokens.every(t => distinctSpelling(value, t[0]))) {
        pending.set(key, value); return value;
      }
    }
    throw Error('No distinct company token fits the required script and shape. No protected copy was published.');
  }
  function rememberCompany(original, tokens, values) {
    const value = assemble(original, tokens, values);
    companies.set(canon(original), value); usedCompanies.add(canon(value));
    tokens.forEach((m, i) => { companyComponents.set(canon(m[0]), values[i]); usedBrandTokens.add(canon(values[i])); });
    return value;
  }
  function company(original) {
    let tokens = pieces(original, 'companies');
    // Generic labels ("Tech", "Group") are not sufficient to retain an identity.
    if (!tokens.length) tokens = words(original).slice(0, 1);
    if (!tokens.length) {
      const key = canon(original);
      if (!companies.has(key)) companies.set(key, randomShape(original));
      return companies.get(key);
    }
    const pending = new Map();
    const values = tokens.map(m => companyToken(m[0], pending, tokens));
    // Assemble from this occurrence so whitespace, case and punctuation stay exact.
    return rememberCompany(original, tokens, values);
  }
  function domainReplacement(domain) {
    const key = canon(domain);
    if (publicPolicy.isDomain(key)) return domain;
    if (!domains.has(key)) {
      const labels = key.split('.');
      const multiSuffix = /^(?:co|com|org|net|ac|gov)\.[a-z]{2}$/;
      const suffixLength = multiSuffix.test(labels.slice(-2).join('.')) ? 2 : 1;
      let suffix = labels.slice(-suffixLength).join('.');
      if (['invalid', 'test', 'example', 'localhost'].includes(suffix)) suffix = pick(['com', 'net', 'org', 'io', 'co']);
      const stem = labels.slice(0, -suffixLength).join('');
      const matches = brandDomains.get(stem);
      const brand = matches?.size === 1 ? [...matches][0] : null;
      let value;
      for (let attempt = 0; attempt < 512; attempt++) {
        const label = !attempt && brand ? brand : Array.from({ length: attempt < 32 ? 2 : attempt < 128 ? 3 : 4 }, () => pick(companyWords)).join('').toLowerCase();
        value = `${label.slice(0, 63)}.${suffix}`;
        if (!sourceDomains.has(value) && !usedDomains.has(value) && value !== key && !publicPolicy.isDomain(value)) break;
        value = null;
      }
      if (!value) throw Error('Unique email domain space exhausted.');
      domains.set(key, value); usedDomains.add(value);
    }
    return domains.get(key);
  }
  function email(original) {
    const mailbox = mailboxParts(original);
    if (!mailbox) { noteEmailFallback(original); return randomShape(original); }
    const [, local, domain] = mailbox;
    const rewrite = value => value.replace(/[A-Za-z]+/g, token => {
      const key = canon(token); if (components.has(key)) return styled(components.get(key), token);
      if (!publicPolicy.isDomain(domain) && /^(?:info|support|sales|hello|contact|office|admin|billing|noreply)$/i.test(token)) return token;
      return component(token, false, 'en');
    });
    const linked = identities.resolve(original, token => components.get(canon(token)));
    let result = (linked ? styled(linked.stem, local.slice(0, local.length - linked.suffix.length)) + rewrite(linked.suffix) : rewrite(local)).replace(/\d/g, () => String(randomInt(10)));
    if (!result || (result === local && publicPolicy.isDomain(domain))) result = randomShape(local);
    if (!result || result === local && publicPolicy.isDomain(domain)) result = 'user' + letters(10);
    if (result.length > 64) { result = result.slice(0, 48).replace(/\.+$/, '') + letters(8); notes.add('Long email local parts were shortened to remain valid; exact name/email spelling correlation may be reduced.'); }
    return `${result}@${domainReplacement(domain)}`;
  }
  function phone(original) {
    const shape = phoneShape(original), { body, digits, keep, extension } = shape;
    if (!digits) return randomShape(original);
    const key = digits.replace(/^00/, '') + ':' + keep;
    if (!phones.has(key)) {
      let value; do { value = digits.slice(0, keep) + digits.slice(keep).replace(/\d/g, () => String(randomInt(10))); } while (value === digits || (/^[1-9]\d*$/.test(original) && value[0] === '0'));
      phones.set(key, value);
    }
    let i = 0, result = body.replace(/\d/g, () => phones.get(key)[i++]);
    if (extension) {
      const extKey = 'ext:' + digits + ':' + extension[1];
      if (!phones.has(extKey)) { let value; do { value = extension[1].replace(/\d/g, () => String(randomInt(10))); } while (value === extension[1]); phones.set(extKey, value); }
      result += extension[0].replace(extension[1], phones.get(extKey));
    }
    return result;
  }
  function address(original) {
    const structural = /^(?:n|s|e|w|ne|nw|se|sw|ste|pkwy|parkway|hwy|highway|terrace|terr|place|pl|circle|cir|building|bldg|street|st|road|rd|avenue|ave|lane|ln|drive|dr|blvd|boulevard|way|court|ct|apt|apartment|suite|unit|floor|north|south|east|west)$/i;
    const region = /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|USA|US|UK)$/;
    return original.replace(/\d+(?:st|nd|rd|th)\b|\p{L}+|\d+/gu, token => {
      if (region.test(token)) return token;
      if (/^\d+(?:st|nd|rd|th)$/.test(token)) {
        const key = 'ordinal:' + token;
        if (!locations.has(key)) { let n; do { n = randomInt(1, 100); } while (n === parseInt(token)); const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'); locations.set(key, n + tail); }
        return locations.get(key);
      }
      if (/^\d+$/.test(token)) { const key = 'number:' + token; if (!locations.has(key)) { let value; do { value = randomShape(token); } while (value === token); locations.set(key, value); } return locations.get(key); }
      if (structural.test(token)) return token;
      const key = canon(token);
      if (!locations.has(key)) locations.set(key, token.length <= 2 || !/^[A-Za-z]+$/.test(token) ? randomShape(token) : pick(street.filter(n => canon(n) !== key && !forbidden.has(canon(n))).length ? street.filter(n => canon(n) !== key && !forbidden.has(canon(n))) : ['Elmwood' + randomInt(100, 10000)]));
      const v = locations.get(key);
      return token === token.toUpperCase() ? v.toUpperCase() : token === token.toLowerCase() ? v.toLowerCase() : v[0].toUpperCase() + v.slice(1).toLowerCase();
    });
  }
  function generate(category, original, attempt = 0) {
    if (category === 'companies' && publicPolicy.isEntity(original)) return original;
    let value;
    if (category === 'names') value = name(original);
    else if (category === 'companies') value = company(original);
    else if (category === 'emails' || category === 'secrets' && mailboxParts(original)) value = email(original);
    else if (category === 'addresses') value = address(original);
    else if (category === 'phones') { if (attempt) phones.delete(phoneShape(original).digits.replace(/^00/, '') + ':' + phoneShape(original).keep); value = phone(original); }
    else if (['identifiers', 'secrets'].includes(category)) {
      if (/^[a-f0-9-]+$/i.test(original) && /[a-f]/i.test(original) && original.length >= 16) value = original.replace(/[a-f0-9]/gi, () => original === original.toUpperCase() ? randomInt(16).toString(16).toUpperCase() : randomInt(16).toString(16));
      else value = randomShape(original);
    }
    else throw Error('Unknown protection category.');
    if (value === original) value = randomShape(original);
    if (attempt && ['names', 'addresses', 'emails', 'companies'].includes(category) && !/^\d+$/.test(original)) {
      const suffix = letters(5);
      value = category === 'emails' && mailboxParts(original) ? value.replace('@', `+${suffix}@`) : value + '-' + suffix;
      notes.add('A replacement needed an extra suffix to avoid a collision.'); stats.expandedValues++;
    }
    if (/^\d+$/.test(original) && (attempt || value === original)) value = randomShape(original + '0'.repeat(Math.floor(attempt / 8)));
    else if (!(category === 'emails' && mailboxParts(original)) && category !== 'phones' && (value === original || attempt > 8)) value += letters(6 + Math.floor(attempt / 8));
    return value;
  }
  function reserve(entries) {
    const rows = [...entries].sort((a, b) => b.original.length - a.original.length);
    for (const row of rows) {
      forbidden.add(canon(row.original));
      if (row.category === 'emails') {
        const mailbox = mailboxParts(row.original.toLowerCase());
        if (mailbox) { const [, local, domain] = mailbox; sourceDomains.add(domain); for (const token of local.match(/[a-z]+/g) || []) forbidden.add(canon(token)); }
        else { row.generation = 'synthetic-fallback'; noteEmailFallback(row.original); }
      }
      if (row.category === 'names' || row.category === 'companies') for (const part of pieces(row.original, row.category)) forbidden.add(canon(part[0]));
      if (row.category === 'names') {
        const style = nameStyle(row.original, namePreference);
        identities.addName(row.original);
        const comma = row.original.indexOf(','), parts = pieces(row.original, 'names');
        if (comma >= 0 && parts.some(m => m.index < comma) && parts.some(m => m.index > comma) && row.original.indexOf(',', comma + 1) < 0) {
          for (const part of parts) if (!componentRoles.has(canon(part[0]))) componentRoles.set(canon(part[0]), part.index < comma ? 'family-name' : 'given-name');
        }
        if (row.detection?.nameRole) for (const part of pieces(row.original, 'names')) componentRoles.set(canon(part[0]), row.detection.nameRole);
        for (const part of pieces(row.original, 'names')) if (!componentStyles.has(canon(part[0]))) componentStyles.set(canon(part[0]), style.locale);
      }
    }
  }
  function candidateRejection(original, category, candidates) {
    const tokens = pieces(original, category);
    if (!Array.isArray(candidates) || candidates.length !== tokens.length || !tokens.length) return 'wrong_token_count_or_incomplete_response';
    const seen = new Map(), bySource = new Map();
    for (const [i, v] of candidates.entries()) {
      const word = tokens[i][0], key = canon(word);
      if (typeof v !== 'string' || !/^\p{L}[\p{L}\p{M}]*$/u.test(v)) return 'letters_only_required';
      if (v.length > Math.max(24, word.length * 2)) return 'replacement_too_long';
      if (!sameScript(word, v)) return 'writing_script_changed';
      if (publicPolicy.isEntity(v)) return 'public_entity_replacement';
      if (category === 'names' && !components.has(key)) {
        const locale = componentStyles.get(key) || nameStyle(original, namePreference).locale;
        if (roleFor(word, i, tokens.length) === 'given-name') {
          const sourceStyle = genderStyle(word, locale), targetStyle = genderStyle(v, locale);
          if (sourceStyle !== 'unknown' && targetStyle !== 'unknown' && sourceStyle !== targetStyle) return 'given_name_convention_changed';
        } else if ((locale === 'ru' && /(?:ова|ева|ина)$/iu.test(word) && /(?:ов|ев|ин)$/iu.test(v)) || (locale === 'ru_latn' && /(?:ova|eva|ina)$/i.test(word) && /(?:ov|ev|in)$/i.test(v))) return 'surname_inflection_changed';
      }
      if (canon(v) === key || forbidden.has(canon(v))) return 'source_value_reused';
      if (['names', 'companies'].includes(category) && key.length >= 3 && canon(v).length >= 3 && (canon(v).includes(key) || key.includes(canon(v)))) return 'source_spelling_too_similar';
      if ([...word].length === 1 && [...v].length !== 1) return 'initial_length_changed';
      if (/^[A-Z]{2,6}$/.test(word) && category === 'companies' && v.length !== word.length) return 'acronym_length_changed';
      if (seen.has(canon(v)) && seen.get(canon(v)) !== key) return 'different_sources_share_replacement';
      if (bySource.has(key) && bySource.get(key) !== canon(v)) return 'repeated_source_inconsistent';
      bySource.set(key, canon(v)); seen.set(canon(v), key);
      if (category === 'companies' && (companyComponents.has(key) ? canon(companyComponents.get(key)) !== canon(v) : usedComponents.has(canon(v)) || usedBrandTokens.has(canon(v)))) return 'existing_mapping_conflict';
      if (category === 'names' && usedBrandTokens.has(canon(v))) return 'existing_mapping_conflict';
      if (category === 'names' && (components.has(key) ? canon(components.get(key)) !== canon(v) : usedComponents.has(canon(v)))) return 'existing_mapping_conflict';
    }
    return null;
  }
  async function prepare(entries, { proposer, signal, progress = () => {}, log = () => {} } = {}) {
    const rows = [...entries].sort((a, b) => b.original.length - a.original.length); reserve(rows);
    const entities = rows.filter(r => ['names', 'companies'].includes(r.category) && (r.detection?.role === 'person-field' || !publicPolicy.isEntity(r.original)));
    let count = 0;
    for (const row of entities) {
      signal?.throwIfAborted();
      const tokens = pieces(row.original, row.category);
      if (row.category === 'companies' && companies.has(canon(row.original))) { count++; progress({ completed: count, total: entities.length }); continue; }
      if (proposer && tokens.length) {
        const known = tokens.map(m => (row.category === 'names' ? components : companyComponents).get(canon(m[0])) || null);
        if (known.some(v => !v)) {
          let accepted = false, rejection;
          // Mappings do not change between retries. Rank once, and only inspect
          // scripts until the bounded prompt has enough useful examples.
          const ranked = [...new Set([...forbidden, ...usedComponents, ...usedBrandTokens, ...usedCompanies])]
            .filter(v => /^[\p{L}\p{M}]+$/u.test(v))
            .map(value => ({ value, distance: Math.min(...tokens.map(t => Math.abs(t[0].length - value.length))) }))
            .sort((a, b) => a.distance - b.distance);
          const avoid = [];
          for (const { value } of ranked) {
            if (tokens.some(t => sameScript(t[0], value))) avoid.push(value);
            if (avoid.length === 64) break;
          }
          for (let attempt = 0; attempt < 3; attempt++) {
            const style = nameStyle(row.original, namePreference);
            const suggestions = tokens.map((m, i) => {
              if (row.category !== 'names' || known[i]) return [];
              const locale = componentStyles.get(canon(m[0])) || style.locale;
              if (style.basis === 'fallback' && genderStyle(m[0], locale) === 'unknown') return [];
              const pool = poolFor(m[0], roleFor(m[0], i, tokens.length) === 'family-name', locale).filter(v => available(v, usedComponents) && sameScript(v, m[0]) && distinctSpelling(v, m[0]));
              const choices = []; while (pool.length && choices.length < 8) choices.push(pool.splice(randomInt(pool.length), 1)[0]); return choices;
            });
            const candidates = await proposer({ avoid, suggestions, roles: tokens.map((m, i) => row.category === 'companies' ? 'brand' : roleFor(m[0], i, tokens.length)), namingConventions: tokens.map((m, i) => row.category === 'names' && roleFor(m[0], i, tokens.length) === 'given-name' ? genderStyle(m[0], componentStyles.get(canon(m[0])) || style.locale) : 'unknown'), category: row.category, original: row.original, tokens: tokens.map(m => m[0]), known, namePreference: row.category === 'names' ? (style.basis === 'fallback' ? 'auto' : style.locale) : namePreference, attempt, rejection, signal });
            signal?.throwIfAborted();
            rejection = candidateRejection(row.original, row.category, candidates);
            if (rejection) { log('info', `Replacement validation: ${row.category}, entity ${count + 1}/${entities.length}, ${tokens.length} tokens, attempt ${attempt + 1}/3: ${rejection}.`); continue; }
            if (row.category === 'names') {
              tokens.forEach((m, i) => { components.set(canon(m[0]), candidates[i]); usedComponents.add(canon(candidates[i])); });
            } else {
              const value = assemble(row.original, tokens, candidates);
              if (forbidden.has(canon(value)) || publicPolicy.isEntity(value)) { rejection = 'company_mapping_conflict'; continue; }
              rememberCompany(row.original, tokens, candidates);
            }
            accepted = true; stats.modelEntities++; break;
          }
          if (!accepted) {
            // Replace through the existing script-aware, collision-checked generator.
            // Never leave an original unchanged merely because the LLM rejected a name.
            stats.fallbackEntities++;
            row.generation = 'synthetic-fallback';
            notes.add('Some names or companies required synthetic spelling fallbacks after local-model validation failed. Review their spelling style; regional fidelity is unverified.');
            log('warn', `Replacement fallback: ${row.category}, entity ${count + 1}/${entities.length}, reason ${rejection}. A synthetic replacement will be used and marked for review.`);
          }
        }
      } else { if (proposer && row.category === 'companies') { stats.fallbackEntities++; row.generation = 'synthetic-fallback'; notes.add('A company without a distinct brand token required a synthetic spelling fallback.'); } stats.poolEntities++; if (row.category === 'names' && nameStyle(row.original, namePreference).basis === 'fallback') notes.add('Unrecognized or ambiguous Latin names used the international spelling pool; country matching is unverified.'); }
      generate(row.category, row.original);
      count++; progress({ completed: count, total: entities.length });
    }
    // Corporate domains only link when the entire brand stem matches uniquely.
    for (const row of entities.filter(r => r.category === 'companies')) {
      const stem = pieces(row.original, 'companies').map(m => m[0]).join('').toLowerCase();
      const replacement = pieces(companies.get(canon(row.original)), 'companies').map(m => m[0]).join('').toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (stem && replacement) { if (!brandDomains.has(stem)) brandDomains.set(stem, new Set()); brandDomains.get(stem).add(replacement); }
    }
  }
  return { generate, reserve, prepare, registerIdentity, get info() { return { method: 'style-preserving-substitution', namePreference, identityLinks: identities.info, namingPolicy: 'Known spelling conventions only; no verified gender or ethnicity inference.', ...stats, notes: [...notes] }; } };
}
