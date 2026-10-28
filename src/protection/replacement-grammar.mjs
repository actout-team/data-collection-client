import { sameScript, canonical } from './name-styles.mjs';
// Constrain JSON and script before sampling. Semantic/collision
// validation still runs after generation. Unknown scripts use source blocks.
const scripts = [
  ['Latin',[[65,90],[97,122],[192,687]]], ['Greek',[[880,1023]]],
  ['Cyrillic',[[1024,1327]]], ['Hebrew',[[1488,1514]]],
  ['Arabic',[[1568,1610],[1646,1747],[1749,1791]]], ['Devanagari',[[2304,2431]]],
  ['Thai',[[3584,3711]]], ['Hiragana',[[12353,12438]]], ['Katakana',[[12449,12538]]],
  ['Han',[[13312,40959]]], ['Hangul',[[44032,55203]]],
];
const escape = cp => (cp > 65535 ? '\\U' : '\\u') + cp.toString(16).padStart(cp > 65535 ? 8 : 4,'0');
const letterCache = new Map();
function letterRanges(ranges) {
  const key = JSON.stringify(ranges);
  if (!letterCache.has(key)) {
    const result = [];
    for (const [lo, hi] of ranges) {
      let start;
      for (let cp = lo; cp <= hi + 1; cp++) {
        const letter = cp <= hi && /\p{L}/u.test(String.fromCodePoint(cp));
        if (letter && start === undefined) start = cp;
        if (!letter && start !== undefined) { result.push([start, cp - 1]); start = undefined; }
      }
    }
    if (letterCache.size >= 128) letterCache.delete(letterCache.keys().next().value);
    letterCache.set(key, result);
  }
  return letterCache.get(key);
}
function alphabet(ranges, excluded = []) {
  const points = [...new Set(excluded.flatMap(c => [...c.toLowerCase(), ...c.toUpperCase()]).map(c => c.codePointAt(0)))].sort((a,b)=>a-b);
  const spans = [];
  for (const [lo,hi] of letterRanges(ranges)) {
    let start=lo;
    for(const point of points.filter(p=>p>=lo&&p<=hi)){if(start<point)spans.push([start,point-1]);start=point+1;}
    if(start<=hi)spans.push([start,hi]);
  }
  return '['+spans.map(([a,b])=>escape(a)+(a===b?'':'-'+escape(b))).join('')+']';
}
export function replacementGrammar(tokens, known, category = 'names', suggestions = []) {
  const rules = tokens.flatMap((token,i) => {
    if(known[i])return [`word${i} ::= ${JSON.stringify(JSON.stringify(known[i]))}`];
    const shortlist = category === 'names' ? (suggestions[i] || []).filter(v => /^\p{L}[\p{L}\p{M}]*$/u.test(v) && sameScript(v, token) && canonical(v) !== canonical(token) && !(canonical(v).length >= 3 && canonical(token).length >= 3 && (canonical(v).includes(canonical(token)) || canonical(token).includes(canonical(v)))) && ([...token].length !== 1 || [...v].length === 1)) : [];
    if (shortlist.length) return [`word${i} ::= ${shortlist.map(v => JSON.stringify(JSON.stringify(v))).join(' | ')}`];
    const ranges = scripts.filter(([script])=>new RegExp(`\\p{Script=${script}}`,'u').test(token)).flatMap(([,ranges])=>ranges);
    for(const c of token){const cp=c.codePointAt(0);if(!ranges.some(([lo,hi])=>cp>=lo&&cp<=hi))ranges.push([Math.floor(cp/128)*128,Math.floor(cp/128)*128+127]);}
    const length=[...token].length, exact=length===1 || category==='companies' && /^[A-Z]{2,6}$/.test(token);
    const max=exact?length:Math.min(64,Math.max(8,Math.ceil(length*1.6)));
    if(category==='companies' && /^[A-Z]{2,6}$/.test(token)) return [
      `word${i} ::= "\\\"" ${alphabet([[65,90]],[token[0]])} letter${i}{${length-1},${length-1}} "\\\""`,
      `letter${i} ::= [A-Z]`
    ];
    const min=exact?length:Math.max(1,Math.floor(length*0.6));
    const chars=[...token], rules=[`word${i} ::= "\\\"" prefix${i}x0 "\\\""`, `letter${i} ::= ${alphabet(ranges)}`];
    // Require a changed character before finishing or completing the source
    // prefix. This blocks source+suffix and truncated-source retry loops,
    // while allowing natural replacements with the same initial.
    for(let depth=0;depth<Math.min(length,max);depth++) {
      const options=[];
      if(depth<max) {
        const restMin=Math.max(0,min-depth-1), restMax=max-depth-1;
        options.push(`${alphabet(ranges,depth<length?[chars[depth]]:[])} letter${i}{${restMin},${restMax}}`);
        if(depth+1<length && depth+1<max) {
          const same=[...new Set([...chars[depth].toLowerCase(),...chars[depth].toUpperCase()])].map(c=>escape(c.codePointAt(0))).join('');
          options.push(`[${same}] prefix${i}x${depth+1}`);
        }
      }
      if(options.length) rules.push(`prefix${i}x${depth} ::= ${options.join(' | ')}`);

    }
    return rules;
  });
  return ['root ::= "{" ws "\\\"replacements\\\"" ws ":" ws "[" ws '+tokens.map((_,i)=>`word${i}`).join(' ws "," ws ')+' ws "]" ws "}"', 'ws ::= [ \\t\\n\\r]*', ...rules].join('\n');
}
