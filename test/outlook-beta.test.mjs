import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installOutlookSession } from '../extension/outlook-session.mjs';
import { outlookItemPage } from '../src/connectors/outlook-protocol.mjs';
import { collectOutlook } from '../src/connectors/outlook.mjs';
import { catalog } from '../ui/catalog.mjs';
import { accountOwner } from '../src/account-owner.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/outlook-schema.json', import.meta.url)));
const clone = v => structuredClone(v);
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const identityData = { WasSuccessful: true, MailboxOptions: { Identity: { DisplayName: 'Example Owner' } } };
const folderRequest = { Header: { RequestServerVersion: 'V2018_01_08' }, Body: { Traversal: 'Deep', ReturnParentFolder: true, ParentFolderIds: [{Id:'root'}], FolderShape: {BaseShape:'IdOnly'} } };
function setup() {
  const calls = []; let answer = () => response(identityData);
  class XHR { open() {} setRequestHeader() {} send() {} addEventListener() {} }
  const target = { location: new URL('https://outlook.live.com/mail/'), XMLHttpRequest: XHR, fetch: async (input, init) => { calls.push({input,init}); return answer(input,init); } };
  installOutlookSession(target);
  async function observe(action, shape, anchor = 'PUID:owner') {
    await target.fetch('https://outlook.live.com/owa/service.svc?action='+action, { method:'POST', headers:{authorization:'Bearer private-session', 'x-anchormailbox':anchor, action, 'x-owa-urlpostdata':encodeURIComponent(JSON.stringify(shape))} });
    await tick(); await tick();
  }
  async function ready() { await observe('GetMailboxByIdentity',{Identity:{RawIdentity:'owner@example.test'}}); await observe('FindFolder',folderRequest); }
  return {target,calls,observe,ready,setAnswer: fn => {answer=fn;}};
}
test('Beta is selectable and only Outlook.com personal mail is enabled', () => {
 const app=catalog.find(a=>a.id==='outlook'); assert.equal(app.maturity,'beta');assert.equal(app.statusLabel,'Beta');assert.deepEqual(app.hosts,['outlook.live.com']);
 assert.equal(catalog.filter(a=>a.id==='outlook').length,1);assert.equal(catalog.find(a=>a.id==='googledrive').maturity,'pending');
});
test('Observer binds authenticated self-profile and never exports credentials', async () => {
 const s=setup();await s.ready();const account=await s.target.__actoutOutlook.read('identity');
 assert.equal(account.email,'owner@example.test');assert.equal(account.authenticated,true);assert.ok(!JSON.stringify(account).includes('private-session'));
 assert.deepEqual(accountOwner('outlook',account).names,['Example Owner']);
 s.setAnswer(()=>response(fixture.folders)); const result=await s.target.__actoutOutlook.read('outlook-folders',{offset:10},account);
 assert.equal(result.status,200);const call=s.calls.at(-1);const shape=JSON.parse(decodeURIComponent(call.init.headers['x-owa-urlpostdata']));
 assert.equal(shape.Body.Paging.Offset,10);assert.ok(shape.Body.FolderShape.AdditionalProperties.some(p=>p.FieldURI==='FolderClass'));
 assert.equal(call.init.headers.authorization,'Bearer private-session');assert.equal(call.init.redirect,'error');
 await assert.rejects(s.target.__actoutOutlook.read('delete',{},account),{code:'OUTLOOK_ARGUMENT'});
 await assert.rejects(s.target.__actoutOutlook.read('outlook-items',{folderId:'root'},null),{code:'LOGIN_REQUIRED'});
});
test('Account switches and unverified identity responses cannot reuse connected state',async()=>{
 const s=setup();await s.ready();const old=await s.target.__actoutOutlook.read('identity');
 await s.observe('GetMailboxByIdentity',{Identity:{RawIdentity:'other@example.test'}},'PUID:other');await s.observe('FindFolder',folderRequest,'PUID:other');
 await assert.rejects(s.target.__actoutOutlook.read('outlook-folders',{},old),{code:'ACCOUNT_CHANGED'});
 const failed=setup();failed.setAnswer(()=>response({WasSuccessful:false}));await failed.ready();await assert.rejects(failed.target.__actoutOutlook.read('identity'),{code:'LOGIN_REQUIRED'});
});
test('Session expiry invalidates state and throttling is returned without response body',async()=>{
 const s=setup();await s.ready();const account=await s.target.__actoutOutlook.read('identity');
 s.setAnswer(()=>new Response('private error',{status:429,headers:{'retry-after':'2'}}));assert.deepEqual(await s.target.__actoutOutlook.read('outlook-items',{folderId:'inbox'},account),{status:429,retryAfter:'2'});
 s.setAnswer(()=>new Response('private error',{status:401}));await assert.rejects(s.target.__actoutOutlook.read('outlook-items',{folderId:'inbox'},account),{code:'LOGIN_REQUIRED'});
 await assert.rejects(s.target.__actoutOutlook.read('identity'),{code:'LOGIN_REQUIRED'});
});
test('Oversized, cross-origin and mid-read account changes fail closed',async()=>{
 const s=setup();await s.ready();const account=await s.target.__actoutOutlook.read('identity');
 s.setAnswer(()=>new Response('x',{headers:{'content-length':String(9*1024*1024)}}));await assert.rejects(s.target.__actoutOutlook.read('outlook-folders',{},account),{code:'OUTLOOK_SIZE'});
 s.target.location=new URL('https://example.test/mail/');await assert.rejects(s.target.__actoutOutlook.read('identity'),{code:'LOGIN_REQUIRED'});
 const m=setup();await m.ready();const old=await m.target.__actoutOutlook.read('identity');let release;
 m.setAnswer(()=>new Promise(resolve=>{release=resolve;}));const inflight=m.target.__actoutOutlook.read('outlook-folders',{},old);
 m.setAnswer(()=>response(identityData));await m.observe('GetMailboxByIdentity',{Identity:{RawIdentity:'new@example.test'}},'PUID:new');await m.observe('FindFolder',folderRequest,'PUID:new');release(response(fixture.folders));
 await assert.rejects(inflight,{code:'ACCOUNT_CHANGED'});
});
function itemPage(items,last=true,next=items.length){return {Body:{ResponseMessages:{Items:[{ResponseClass:'Success',ResponseCode:'NoError',RootFolder:{Items:items,TotalItemsInView:items.length,IndexedPagingOffset:next,IncludesLastItemInRange:last}}]}}};}
const row=(id,date='2026-10-16T10:00:00Z')=>({ItemId:{Id:id},ConversationId:{Id:'synthetic-conversation'},DateTimeReceived:date,Subject:'Synthetic',IsRead:false});
const window={start:'2026-10-01T00:00:00Z',end:'2026-10-17T00:00:00Z'};
function collector(ask,extra={}){const rows=[],stats={messages:0,channels:0,warnings:[]};return {rows,stats,run:()=>collectOutlook({ask,writer:{append:async(file,value)=>rows.push({file,value})},stats,window,signal:new AbortController().signal,wait:async()=>{},...extra})};}
test('Message enumerator honors explicit completion and rejects stalled or duplicate pages',()=>{
 assert.equal(outlookItemPage(itemPage([row('a')],false,1)).nextOffset,1);
 assert.throws(()=>outlookItemPage(itemPage([],false,0)),/pagination progress/);
 assert.throws(()=>outlookItemPage(itemPage([row('a'),row('a')])),/duplicate item/);
 assert.equal(outlookItemPage(itemPage([],true,1),1).hasMore,false);
});
test('Collector pages, filters per message and retains listed metadata if thread omits it',async()=>{
 const extra=clone(fixture.items);const conv=extra.Body.ResponseMessages.Items[0].Conversation;conv.ConversationNodes[0].Items.push({...clone(conv.ConversationNodes[0].Items[0]),ItemId:{Id:'unlisted'}});
 let retries=0;const c=collector(async({op,body})=>{
  if(op==='outlook-folders')return {status:200,data:fixture.folders};
  if(op==='outlook-conversation')return {status:200,data:extra};
  if(retries++===0)return {status:429,retryAfter:'0'};
  return {status:200,data:body.offset===0?itemPage([row('synthetic-message'),row('old','2026-09-01T00:00:00Z')],false,2):itemPage([row('missing-body')],true,3)};
 });const result=await c.run();const saved=c.rows.filter(r=>r.file==='messages.jsonl').map(r=>r.value);
 assert.equal(result.status,'partial');assert.equal(result.scanComplete,true);assert.deepEqual(saved.map(r=>r.id),['synthetic-message','missing-body']);assert.equal(saved[0].body.coverage,'unique-fragment');assert.equal(saved[1].body,null);assert.equal(saved[0].isRead,false);
});
test('Collector aborts account changes, reports incomplete coverage, and rejects repeated pages',async()=>{
 const c=collector(async({op})=>{if(op==='outlook-folders')return {status:200,data:fixture.folders};if(op==='outlook-items')return {status:200,data:itemPage([row('synthetic-message')])};throw Object.assign(Error('Changed'),{code:'ACCOUNT_CHANGED'});});
 await assert.rejects(c.run(),{code:'ACCOUNT_CHANGED'});assert.equal(c.rows.at(-1).value.scanComplete,false);
 const repeated=collector(async({op,body})=>({status:200,data:op==='outlook-folders'?fixture.folders:op==='outlook-items'?itemPage([row('synthetic-message')],false,body.offset+1):fixture.items}));await assert.rejects(repeated.run(),/repeated a message page/);
 const abort=new AbortController();abort.abort();const cancelled=collector(async()=>{throw Error('Should not call');},{signal:abort.signal});await assert.rejects(cancelled.run(),{name:'AbortError'});
});
