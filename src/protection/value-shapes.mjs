import { randomInt } from 'node:crypto';
import { namePools, sameScript } from './name-styles.mjs';
export const pick = values => values[randomInt(values.length)];
export function styled(value, original) {
  if (original === original.toUpperCase()) return value.toUpperCase();
  if (original === original.toLowerCase()) return value.toLowerCase();
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(original)) {
    const source = original.match(/[A-Z][a-z]+/g), parts = value.match(/[A-Z][a-z]+/g);
    if (parts?.join('') === value && parts.length === source.length) return value;
    let offset = 0;
    return source.map((part, i) => { const end = i === source.length - 1 ? value.length : Math.max(offset + 1, Math.round((offset + part.length) / original.length * value.length)); const chunk = value.slice(offset, end); offset = end; return chunk ? chunk[0].toUpperCase() + chunk.slice(1).toLowerCase() : ''; }).join('');
  }
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}
const zeros = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10];
export function randomShape(original) {
  return [...original].map((c, i) => {
    const cp = c.codePointAt(0), zero = zeros.find(z => cp >= z && cp <= z + 9);
    if (zero !== undefined) return String.fromCodePoint(zero + randomInt(i === 0 && /^\d+$/.test(original) ? 1 : 0, 10));
    if (!/\p{L}/u.test(c)) return c;
    const data = Object.values(namePools).find(p => sameScript(c, p.alphabet[0]));
    if (data) return styled(pick([...data.alphabet]), c);
    // Unlisted scripts: sample letters in the same Unicode block/script.
    const options = [];
    for (let n = Math.max(0, cp - 32); n < cp + 32; n++) { const v = String.fromCodePoint(n); if (v !== c && /\p{L}/u.test(v) && sameScript(c, v)) options.push(v); }
    return options.length ? pick(options) : c;
  }).join('');
}
// International calling prefixes, not subscriber or carrier identifiers.
const callingCodes = new Set(('1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 800 808 850 852 853 855 856 870 878 880 881 882 883 886 888 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 979 992 993 994 995 996 998').split(' '));
export function phoneShape(original) {
  const ext = /(?:\s*(?:ext\.?|extension|x|#)\s*)(\d+)\s*$/i.exec(original);
  const body = ext ? original.slice(0, ext.index) : original, digits = body.replace(/\D/g, '');
  const international = /^\s*\+/.test(body) ? 0 : /^\s*00/.test(body) ? 2 : null;
  let keep = 0;
  if (international !== null) {
    const code = [1, 2, 3].map(n => digits.slice(international, international + n)).find(c => callingCodes.has(c));
    if (code) {
      keep = international + code.length;
      if (code === '1' && digits.length - international === 11) keep += 3; // NANP area code.
      if (code === '972' && digits.length - keep >= 8) keep += digits[keep] === '5' ? 2 : 1;
    }
  } else {
    const area = /^\s*\(?(\d{2,4})\)?[ .-]+/.exec(body);
    if (area && digits.length - area[1].length >= 6) keep = area[1].length;
    else if (digits.startsWith('0')) keep = 1;
  }
  return { body, digits, keep: Math.min(keep, Math.max(0, digits.length - 4)), extension: ext };
}
export const publicMailDomains = new Set(('gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com yahoo.co.uk yahoo.fr yahoo.de yahoo.co.jp ymail.com rocketmail.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me tutanota.com tuta.com gmx.com gmx.de gmx.net web.de mail.com fastmail.com hey.com zoho.com yandex.com yandex.ru mail.ru bk.ru inbox.ru list.ru rambler.ru qq.com 163.com 126.com naver.com daum.net hanmail.net orange.fr wanadoo.fr laposte.net free.fr outlook.co.il hotmail.co.il walla.co.il walla.com').split(' '));
