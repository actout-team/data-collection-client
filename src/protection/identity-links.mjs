import { canonical } from './name-styles.mjs';
import { emailSpelling } from './name-profile.mjs';
const words=value=>value.match(/\p{L}[\p{L}\p{M}]*/gu)||[];
export function nameTokens(value) {
 const parse = text => words(text).filter(v=>! /^(?:mr|mrs|ms|dr|prof|sir|jr|sr)$/i.test(v));
 const parts=value.split(',');
 if(parts.length===2 && parse(parts[0]).length && parse(parts[1]).length)return [...parse(parts[1]),...parse(parts[0])];
 return parse(value);
}
// Index finite local-part templates once per discovered name, never all pairs of
// names and email addresses. Explicit bindings take precedence over inference.
export function createIdentityLinks() {
 const names=new Map(), explicit=new Map(), index=new Map(); let indexed=false, linked=0, ambiguous=0;
 function addName(name) {const tokens=nameTokens(name);if(tokens.length<2||tokens.length>8)return;const key=canonical(name);if(names.has(key)||names.size>=100000)return;names.set(key,tokens);indexed=false;}
 function bind(name,email) {
  if(typeof name!=='string'||typeof email!=='string'||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))return;
  addName(name);const tokens=nameTokens(name);if(!tokens.length||tokens.length>8)return;
  const key=canonical(email);if(explicit.size>=100000&&!explicit.has(key))return;if(!explicit.has(key))explicit.set(key,new Map());explicit.get(key).set(canonical(name),tokens);
 }
 function templates(tokens) {
  const first=tokens[0],last=tokens.at(-1),f=emailSpelling(first),l=emailSpelling(last);
  if(!/^[a-z]+$/.test(f+l))return [];
  const forms=[];
  for(const sep of ['','.','_','-']) {
   forms.push([f+sep+l,[[first,false],sep,[last,false]]],[f[0]+sep+l,[[first,true],sep,[last,false]]],[l+sep+f,[[last,false],sep,[first,false]]],[f+sep+l[0],[[first,false],sep,[last,true]]]);
  }
  forms.push([f,[[first,false]]],[l,[[last,false]]]);
  return forms;
 }
 function build() {if(indexed)return;index.clear();for(const [name,tokens]of names)for(const [key,parts]of templates(tokens)){if(!index.has(key))index.set(key,new Map());index.get(key).set(name,parts);}indexed=true;}
 function resolve(email,replacement) {
  const local=email.slice(0,email.lastIndexOf('@')), match=/^([^+\d]+)(\d*)(\+.*)?$/.exec(local);if(!match)return null;
  const stem=match[1].toLowerCase(), bound=explicit.get(canonical(email));let choices;
  if(bound) {choices=[];for(const tokens of bound.values())for(const [key,parts]of templates(tokens))if(key===stem)choices.push(parts);if(bound.size>1){ambiguous++;return null;}}
  else {build();const matches=index.get(stem);if(!matches)return null;if(matches.size>1){ambiguous++;return null;}choices=[...matches.values()];}
  const outputs=new Set();
  for(const parts of choices) {
   let valid=true;
   const output=parts.map(part=>{if(typeof part==='string')return part;const value=replacement(part[0]);if(!value){valid=false;return ''; }const word=emailSpelling(value);if(!/^[a-z]+$/.test(word))valid=false;return part[1]?word.slice(0,1):word;}).join('');
   if(valid && /^[a-z][a-z._-]*$/.test(output))outputs.add(output);
  }
  if(outputs.size!==1)return null;
  linked++;return {stem:[...outputs][0],suffix:match[2]+(match[3]||'')};
 }
 return {addName,bind,resolve,get info(){return {explicitEmails:explicit.size,linkedEmails:linked,ambiguousEmails:ambiguous,method:'explicit-fields-and-unique-local-patterns'};}};
}
