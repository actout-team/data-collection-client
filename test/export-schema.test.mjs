import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/protection/detect.mjs';
import { jsonText } from '../src/protection/formats.mjs';

const cases = [
  ['outlook/messages.jsonl', { id:'OpaqueRecord42', body:{type:'HTML',content:'Enter sunshine when the login screen asks for the secret.'}, from:[{email:'alice@example.net',routingType:'SMTP'}], folderId:'OpaqueFolder42' }, ['OpaqueRecord42','HTML','SMTP','OpaqueFolder42']],
  ['outlook/folders.jsonl', {id:'OpaqueFolder42',parentId:'OpaqueParent42',folderClass:'IPF.Note',name:'Alice Reed'}, ['OpaqueFolder42','OpaqueParent42','IPF.Note']],
  ['slack/messages.jsonl', {channel:'C00EXAMPLE',user:'U00EXAMPLE',ts:'1729183602.000001',blocks:[{type:'rich_text',block_id:'OpaqueBlock42',elements:[{type:'text',text:'Enter sunshine when the login screen asks for the secret.'}]}]}, ['C00EXAMPLE','U00EXAMPLE','1729183602.000001','rich_text','OpaqueBlock42','text']],
  ['slack/channels.jsonl', {id:'C00EXAMPLE',creator:'U00EXAMPLE',properties:{canvas:{file_id:'F00EXAMPLE'},tabs:[{type:'canvas',id:'TABEXAMPLE'}]},topic:{value:'Alice Reed',creator:'U00EXAMPLE'}}, ['C00EXAMPLE','U00EXAMPLE','F00EXAMPLE','canvas','TABEXAMPLE']],
  ['slack/users.jsonl', {id:'U00EXAMPLE',color:'9f69e7',profile:{real_name:'Alice Reed',team:'T00EXAMPLE',huddle_state:'default_unset',email:'alice@example.net'}}, ['U00EXAMPLE','9f69e7','T00EXAMPLE','default_unset']],
];
for (const [file, input, metadata] of cases) test(`Export contract preserves ${file} metadata during discovery and replacement`, () => {
  const observed = [], d=createDetector(['names','emails','secrets'],{observe:text=>observed.push(text)});
  const source=JSON.stringify(input);
  jsonText(source,d,'discover',file);
  for(const value of metadata) assert.ok(!observed.includes(value), 'Structural scalar reached the model');
  // Even a detection from another document cannot rewrite this field.
  for(const value of metadata) d.add(value,'secrets',{source:'model',label:'password',score:0.8});
  d.add('sunshine','secrets',{source:'model',label:'password',score:0.8});d.add('Alice Reed','names');d.compile();
  const output=jsonText(source,d,'replace',file);
  for(const value of metadata) assert.ok(output.includes(JSON.stringify(value)), 'Structural scalar was rewritten');
  if(source.includes('sunshine')) assert.ok(!output.includes('sunshine'));
  if(source.includes('Alice Reed')) assert.ok(!output.includes('Alice Reed'));
  if(source.includes('alice@example.net')) assert.ok(!output.includes('alice@example.net'));
});
test('Contracts do not exempt unknown fields, private IDs, other files, or embedded payloads', () => {
  const d=createDetector(['secrets','identifiers']);
  const source=JSON.stringify({ channel:'record-value', private_note:'hidden-value', passport_number:'A12345678', text:JSON.stringify({id:'embedded-value'}) });
  for(const value of ['record-value','hidden-value','embedded-value']) d.add(value,'secrets');
  d.discover('A12345678','passport_number');d.compile();
  const known=JSON.parse(jsonText(source,d,'replace','slack/messages.jsonl'));
  assert.equal(known.channel,'record-value');assert.notEqual(known.private_note,'hidden-value');assert.notEqual(known.passport_number,'A12345678');
  assert.notEqual(JSON.parse(known.text).id,'embedded-value');
  const unknown=JSON.parse(jsonText(source,d,'replace','other/messages.jsonl'));
  assert.notEqual(unknown.channel,'record-value');
});
