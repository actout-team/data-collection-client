import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/protection/detect.mjs';
import { createIdentityLinks } from '../src/protection/identity-links.mjs';
import { genderStyle, familyPool, emailSpelling } from '../src/protection/name-profile.mjs';
import { namePools } from '../src/protection/name-styles.mjs';
import { csvText, xmlText } from '../src/protection/structured.mjs';
import { jsonText, emailText } from '../src/protection/formats.mjs';
const mapping = (d, value) => d.entries.get(value)?.replacement;
async function protect(value, categories = ['names', 'emails'], options = {}) {
 const source = JSON.stringify(value), d = createDetector(categories, options);
 jsonText(source, d, 'discover'); await d.prepare(); d.compile();
 return { d, output: JSON.parse(jsonText(source, d, 'replace')) };
}
test('Known given-name conventions and native scripts survive pool generation', async () => {
 for (const [source, locale, convention] of [
  ['Alice Reed','en','feminine'], ['John Clark','en','masculine'], ['יעל כהן','he','feminine'],
  ['איתן לוי','he','masculine'], ['Анна Иванова','ru','feminine'], ['Юрий Петров','ru','masculine'],
  ['ليلى منصور','ar','feminine'], ['عمر ناصر','ar','masculine'], ['Lucía García','es','feminine'],
 ]) {
  const { output } = await protect({ full_name: source });
  assert.equal(genderStyle(output.full_name.split(' ')[0], locale), convention);
  assert.notEqual(output.full_name, source);
  if (locale==='ru'&&convention==='feminine') assert.ok(familyPool(locale,'Иванова').includes(output.full_name.split(' ')[1]));
 }
});
test('Standalone surname roles and split first/last fields coordinate with abbreviated email users', async () => {
 const { output } = await protect({ first_name:'Alice', last_name:'Reed', email:'a.reed@gmail.com' });
 assert.ok(namePools.en.last.includes(output.last_name));
 assert.equal(genderStyle(output.first_name,'en'),'feminine');
 assert.equal(output.email,`${output.first_name[0].toLowerCase()}.${output.last_name.toLowerCase()}@gmail.com`);
 const surname = await protect({ surname:'Иванова' });
 assert.ok(familyPool('ru','Иванова').includes(surname.output.surname));
});
test('Explicit sender/recipient binding resolves shared initials without pairing different recipients', async () => {
 const { output } = await protect({ from:{ name:'Alice Reed', address:'areed@gmail.com' }, to:[{ name:'Anna Reed', address:'areed@outlook.com' }] });
 for(const person of [output.from, output.to[0]]) {
  const [first,last]=person.name.toLowerCase().split(' ');
  assert.equal(person.address.split('@')[0],first[0]+last);
 }
 assert.notEqual(output.from.name,output.to[0].name);
});
test('Unambiguous local-part templates preserve order, separators, initials and accent folding', async () => {
 const emails=['jose.garcia@gmail.com','jgarcia@gmail.com','garcia_jose@gmail.com','joseg@gmail.com','jose-garcia17+notes@gmail.com'];
 const { output }=await protect({ full_name:'José García', emails });
 const [first,last]=output.full_name.split(' ').map(emailSpelling);
 assert.deepEqual(output.emails.slice(0,4),[`${first}.${last}@gmail.com`,`${first[0]}${last}@gmail.com`,`${last}_${first}@gmail.com`,`${first}${last[0]}@gmail.com`]);
 assert.match(output.emails[4],new RegExp(`^${first}-${last}\\d{2}\\+[a-z]+@gmail.com$`));
});
test('Known Hebrew native names and ASCII email spellings reuse the same replacement', async () => {
 const { output }=await protect({ full_name:'יעל כהן', email:'yael.cohen@gmail.com' });
 assert.equal(output.email,output.full_name.split(' ').map(emailSpelling).join('.')+'@gmail.com');
});
test('Folded and encoded MIME sender/recipient names link to corresponding email usernames', async () => {
 const source='From: =?UTF-8?B?'+Buffer.from('Alice Reed').toString('base64')+'?= <a.reed@gmail.com>\r\nTo: "Anna Reed"\r\n <areed@outlook.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello.\r\n';
 const d=createDetector(['names','emails']);emailText(source,d,'discover');await d.prepare();d.compile();
 const output=emailText(source,d,'replace');
 for(const [name,email,sep]of [['Alice Reed','a.reed@gmail.com','.'],['Anna Reed','areed@outlook.com','']]) {
  const [first,last]=mapping(d,name).toLowerCase().split(' ');
  assert.equal(mapping(d,email).split('@')[0],first[0]+sep+last);
  assert.ok(output.includes(mapping(d,email)));
 }
 assert.ok(output.endsWith('Hello.\r\n'));assert.ok(output.includes('Content-Type: text/plain; charset=utf-8'));
});
test('Conflicting identities and incomplete mappings never force an identity link', () => {
 const links=createIdentityLinks();links.bind('Alice Reed','areed@gmail.com');links.bind('Anna Reed','areed@gmail.com');
 assert.equal(links.resolve('areed@gmail.com',()=> 'Nora'),null);
 const partial=createIdentityLinks();partial.addName('Alice Reed');
 assert.equal(partial.resolve('alice.reed@gmail.com',word=>word==='Alice'?'Nora':undefined),null);
 const inferred=createIdentityLinks();inferred.addName('Alice Reed');inferred.addName('Anna Reed');
 assert.equal(inferred.resolve('areed@gmail.com',()=> 'Nora'),null);
});
test('Public brands, domains, schema labels and unselected names remain unchanged', async () => {
 const source={ from:{name:'Google',email:'support@gmail.com'}, properties:[{name:'Alice Reed',value:'public label'}], full_name:'Alice Reed',email:'alice.reed@gmail.com' };
 const {output}=await protect(source);
 assert.equal(output.from.name,'Google');assert.equal(output.from.email.split('@')[1],'gmail.com');
 assert.equal(output.properties[0].name,'Alice Reed');assert.deepEqual(Object.keys(output),Object.keys(source));
 const selected=await protect({full_name:'Alice Reed',email:'alice.reed@gmail.com'},['emails']);
 assert.equal(selected.output.full_name,'Alice Reed');assert.notEqual(selected.output.email,'alice.reed@gmail.com');
});
test('Model receives conventions and surname roles; opposing known conventions trigger a retry', async () => {
 const d=createDetector(['names']);d.discover('Alice','first_name');d.discover('Reed','last_name');
 const calls=[];
 await d.prepare({proposer:async input=>{calls.push(input);return [input.original==='Reed'?'Brooks':input.attempt?'Nora':'John'];}});d.compile();
 assert.equal(mapping(d,'Alice'),'Nora');assert.equal(mapping(d,'Reed'),'Brooks');
 assert.deepEqual(calls.find(v=>v.original==='Alice').namingConventions,['feminine']);
 assert.deepEqual(calls.find(v=>v.original==='Reed').roles,['family-name']);
 assert.equal(calls.find(v=>v.original==='Alice'&&v.attempt===1).rejection,'given_name_convention_changed');
});
test('Ambiguous spellings do not assert gender or ethnicity', () => {
 for(const name of ['Alex','Taylor','Sam','Zorvani']) assert.equal(genderStyle(name,'en'),'unknown');
});

test('CSV rows and XML sibling fields bind identities without changing headers or tag names', async () => {
 for (const [transform, source] of [
  [csvText, 'first_name,last_name,email\nAlice,Reed,a.reed@gmail.com\nAnna,Reed,areed@outlook.com\n'],
  [xmlText, '<contacts><contact><first_name>Alice</first_name><last_name>Reed</last_name><email>a.reed@gmail.com</email></contact><contact first_name="Anna" last_name="Reed" email="areed@outlook.com"/></contacts>'],
 ]) {
  const d=createDetector(['names','emails']);transform(source,d,'discover');await d.prepare();d.compile();
  const out=transform(source,d,'replace');
  for(const [first,email,sep] of [['Alice','a.reed@gmail.com','.'],['Anna','areed@outlook.com','']]) assert.equal(mapping(d,email).split('@')[0],mapping(d,first)[0].toLowerCase()+sep+mapping(d,'Reed').toLowerCase());
  assert.ok(out.includes('first_name')); assert.ok(!out.includes('Alice')); assert.ok(out.includes('@gmail.com'));
 }
});

test('Release regressions reject company source extensions and preserve public brands in generic display fields', async () => {
 const d=createDetector(['companies']);d.add('Marelux Labs','companies');const rejections=[];
 await d.prepare({proposer:async input=>{rejections.push(input.rejection);return input.attempt?['Veltora']:['Mareluxbeco'];}});d.compile();
 assert.equal(mapping(d,'Marelux Labs'),'Veltora Labs');assert.equal(rejections[1],'source_spelling_too_similar');
 for(const label of ['Slack','Stripe','HubSpot','Google Workspace','ChatGPT','Google','Google Drive','notion','Notion']) {
  const {output}=await protect({display_name:label,full_name:label});assert.equal(output.display_name,label);assert.equal(output.full_name,label);
 }
});

test('Surname-first comma display names retain order and link to given-name email initials', async () => {
 const {output}=await protect({full_name:'Reed, Henry',email:'h.reed@gmail.com'});
 const [last,first]=output.full_name.split(', ');
 assert.ok(namePools.en.last.includes(last));assert.equal(genderStyle(first,'en'),'masculine');
 assert.equal(output.email,`${first[0].toLowerCase()}.${last.toLowerCase()}@gmail.com`);
});
test('Unrecognized name traditions are not constrained to English model shortlists', async () => {
 const d=createDetector(['names']);d.add('Zorvani Melqueth','names');
 await d.prepare({proposer:async input=>{assert.equal(input.namePreference,'auto');assert.deepEqual(input.suggestions,[[],[]]);return ['Talvori','Renquath'];}});d.compile();
});
