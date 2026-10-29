import test from 'node:test';
import assert from 'node:assert/strict';
import { refineModelSpan } from '../src/protection/entity-quality.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import { createOwnerPolicy } from '../src/protection/account-owners.mjs';
import { valueText } from '../src/protection/content.mjs';
import { htmlText } from '../src/protection/structured.mjs';

const owners=[{app:'gmail',accountKey:'synthetic-owner',verified:true,source:'authenticated-self-profile',emails:['owner@example.org']}];
const span=(text,category='secrets')=>({start:0,end:text.length,category,label:'password',score:0.9});

test('Model labels, markup fragments and unsupported ordinary-word secrets are rejected',()=>{
  for(const text of ['API key','verification code','passwords','gmail_quote','</div','logo@2x.png','dashboard','בחינם','יצירת קשר']) {
    assert.equal(refineModelSpan(span(text),text),undefined,text);
  }
});

test('Short-number admission is unchanged and credential evidence preserves alphabetic values',()=>{
  for(const text of ['5','11','556','244864','TCN-WLQ','qZmxVbRt']) assert.ok(refineModelSpan(span(text),text),text);
  for(const text of ['The password is violet','סיסמה: שיטה','Use violet to log in']) {
    const value=text.includes('שיטה')?'שיטה':'violet',start=text.indexOf(value);
    assert.ok(refineModelSpan({...span(text),start,end:start+value.length},text),text);
  }
});

test('Greeting trimming preserves a private name and leaves field rules independent',()=>{
  for(const [text,name] of [['Hi Morgan','Morgan'],['היי דנה','דנה'],['תודה דנה','דנה']]) {
    const refined=refineModelSpan(span(text,'names'),text);
    assert.equal(text.slice(refined.start,refined.end),name);
    const d=createDetector(['names']);d.add(name,'names',{source:'model'},text);d.compile();
    const result=d.replace(text);assert.ok(result.startsWith(text.slice(0,text.indexOf(name))));assert.ok(!result.endsWith(name));
  }
  const d=createDetector(['secrets']);valueText('dashboard',d,'discover','password');d.compile();
  assert.notEqual(valueText('dashboard',d,'replace','password'),'dashboard');
});

test('Email model spans isolate each mailbox and preserve verified owners inside wrappers',()=>{
  const d=createDetector(['emails'],{ownerPolicy:createOwnerPolicy(owners)});
  for(const text of ['אלowner@example.org','@owner@example.org','owner@example.org\nother@example.org']) d.add(text,'emails',{source:'model'},text);
  d.compile();assert.deepEqual([...d.entries.keys()],['other@example.org']);
  assert.equal(d.replace('אלowner@example.org'),'אלowner@example.org');
  assert.equal(d.replace('@owner@example.org'),'@owner@example.org');
  const output=d.replace('owner@example.org\nother@example.org');assert.ok(output.startsWith('owner@example.org\n'));assert.ok(!output.endsWith('other@example.org'));
});

test('Owner wrapper normalization does not exempt different mailboxes or secret fields',()=>{
  const policy=createOwnerPolicy(owners);
  for(const text of ['אלowner@example.org','@owner@example.org']) assert.equal(policy.spans(text).length,1);
  for(const text of ['notowner@example.org','other@owner@example.org','owner+other@example.org','owner@example.org.evil.test','דנהowner@example.org']) assert.equal(policy.spans(text).length,0,text);
  for(const text of ['דנהowner@example.org','owner@example.orgאחר','other@owner@example.org']) {
    const emailDetector=createDetector(['emails'],{ownerPolicy:policy});
    emailDetector.add(text,'emails',{source:'model'},text);emailDetector.compile();
    assert.notEqual(emailDetector.replace(text,true),text,text);
  }
  const d=createDetector(['secrets'],{ownerPolicy:policy});
  for(const text of ['אלowner@example.org','@owner@example.org']) d.add(text,'secrets',{source:'model'},text);
  const url='https://login.example/confirm?email=owner@example.org&token=private-test-token';
  valueText(url,d,'discover','access_token');d.compile();
  assert.equal(d.replace('@owner@example.org'),'@owner@example.org');
  let edits=[];valueText(url,d,'replace','access_token','',()=>{},found=>edits=found);
  assert.equal(edits.length,1);assert.equal(edits[0].start,0);assert.equal(edits[0].stop,url.length);
});

test('Mailto contact fields stay protected when the same mailbox has model evidence elsewhere',()=>{
  const d=createDetector(['emails']);
  d.add('person@example.org','emails',{source:'model'},'Contact person@example.org today.');
  const html='<a href="mailto:person@example.org">Contact</a>';
  htmlText(html,d,'discover');d.compile();
  assert.equal(htmlText(html,d,'replace'),html.replace('person@example.org',d.entries.get('person@example.org').replacement));
});
