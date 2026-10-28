import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { accountOwner } from '../src/account-owner.mjs';
import { createOwnerPolicy } from '../src/protection/account-owners.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import { jsonText } from '../src/protection/formats.mjs';
import { protectExport } from '../src/protection/index.mjs';
const owner={app:'gmail',accountKey:'owner@gmail.com',verified:true,source:'authenticated-self-profile',names:['Alice Reed','Alice','Reed'],emails:['owner@gmail.com'],phones:['+1 (202) 555-0187'],addresses:['42 Cedar Road']};
test('Owner discovery rejects capture sessions and binds Slack profiles to authenticated user IDs',()=>{
 assert.equal(accountOwner('asana',{mode:'capture',account:'owner@gmail.com'}),null);
 const auth={ok:true,team_id:'T1',user_id:'U1'};
 assert.deepEqual(accountOwner('slack',auth,{id:'U2',profile:{real_name:'Someone Else',email:'other@gmail.com'}}).names,[]);
 const result=accountOwner('slack',auth,{id:'U1',profile:{real_name:'Alice Reed',email:'owner@gmail.com',phone:'+1 (202) 555-0187',password:'not-an-exemption'}});
 assert.deepEqual(result.names,['Alice Reed']);assert.deepEqual(result.emails,['owner@gmail.com']);assert.ok(!JSON.stringify(result).includes('not-an-exemption'));
 assert.equal(accountOwner('gmail',{account:'owner@gmail.com'}).accountKey,'owner@gmail.com');
});
test('Owner exemptions preserve contact values across connectors while credentials and identifiers still change',async()=>{
 const policy=createOwnerPolicy([owner]);const d=createDetector(['names','emails','phones','addresses','secrets','identifiers'],{ownerPolicy:policy});
 const data={full_name:'Alice Reed',email:'owner@gmail.com',phone:'+1 202 555 0187',street_address:'42 Cedar Road',password:'owner@gmail.com',account_number:'12025550187',credit_card_number:'4111111111111111',other:{full_name:'Alice Brown',email:'other@gmail.com'}};
 const source=JSON.stringify(data); jsonText(source,d,'discover');
 // The same verified owner stays intact in every downloaded connector.
 jsonText(source,d,'discover');await d.prepare();d.compile();
 const out=JSON.parse(jsonText(source,d,'replace'));
 for(const key of ['full_name','email','phone','street_address']) assert.equal(out[key],data[key],key);
 for(const key of ['password','account_number','credit_card_number']) assert.notEqual(out[key],data[key],key);
 assert.notEqual(out.other.full_name,data.other.full_name);assert.notEqual(out.other.email,data.other.email);
 const other=JSON.parse(jsonText(source,d,'replace'));assert.equal(other.full_name,data.full_name);assert.equal(other.email,data.email);
});
test('Owner spans protect names inside prose without preserving unrelated full names or secret assignments',async()=>{
 const policy=createOwnerPolicy([owner]),d=createDetector(['names','emails','secrets'],{ownerPolicy:policy});
 d.add('Alice Reed','names');d.add('Alice Brown','names');d.add('owner@gmail.com','emails');
 d.discover('password: owner@gmail.com');await d.prepare();d.compile();
 assert.equal(d.replace('Alice Reed <owner@gmail.com>'),'Alice Reed <owner@gmail.com>');
 assert.notEqual(d.replace('Alice Brown'),'Alice Brown');
 assert.notEqual(d.replace('password: owner@gmail.com'),'password: owner@gmail.com');
});
test('Full export preserves verified owners across every connector and both passes',async t=>{
 const root=await mkdtemp('/tmp/collect-owner-');t.after(()=>rm(root,{recursive:true,force:true}));
 const source=root+'/source';await mkdir(source+'/gmail',{recursive:true});await mkdir(source+'/slack');
 const input='{"full_name":"Alice Reed","email":"owner@gmail.com","password":"OrangeMoon99!"}';
 await writeFile(source+'/gmail/data.json',input);await writeFile(source+'/slack/data.json',input);
 const result=await protectExport({source,categories:['names','emails','secrets'],accountOwners:[owner]});
 const gmail=JSON.parse(await readFile(result.output+'/gmail/data.json','utf8')),slack=JSON.parse(await readFile(result.output+'/slack/data.json','utf8'));
 assert.equal(gmail.full_name,'Alice Reed');assert.equal(gmail.email,'owner@gmail.com');assert.notEqual(gmail.password,'OrangeMoon99!');assert.equal(slack.email,'owner@gmail.com');
 assert.equal(result.ownerPolicy.accounts,1);assert.equal(result.ownerPolicy.sensitiveCategoriesExempt,false);
 assert.equal(await readFile(source+'/gmail/data.json','utf8'),input);
});

test('Owner contact matching is exact and accepts generic authenticated profile names',()=>{
 const profile=accountOwner('outlook',{authenticated:true,accountId:'account-1',ownerProfile:{name:'Alice Reed',email:'owner@example.net'}});
 assert.deepEqual(profile.names,['Alice Reed']);
 const policy=createOwnerPolicy([profile]);
 assert.equal(policy.matches('emails','OWNER@example.net'),true);
 assert.equal(policy.matches('secrets','owner@example.net'),false);
 assert.equal(policy.spans('owner@example.net.evil.test').length,0);
 assert.equal(policy.spans('other-owner@example.net').length,0);
 assert.equal(policy.spans('<owner@example.net>').length,1);
 assert.equal(policy.spans('Contact owner@example.net.').length,1);
});

test('Owner email is retained in an oversized model span and still changes in a credential field',()=>{
 const d=createDetector(['secrets'],{ownerPolicy:createOwnerPolicy([owner])});
 const value='Contact owner@gmail.com';d.add(value,'secrets',{source:'model',label:'password',score:0.8});d.add('owner@gmail.com','secrets');d.compile();
 assert.equal(d.replace(value),value);
 const input=JSON.stringify({password:'owner@gmail.com'});
 assert.notEqual(JSON.parse(jsonText(input,d,'replace')).password,'owner@gmail.com');
});
test('Reports expose detections with no applied replacement',async t=>{
 const root=await mkdtemp('/tmp/collect-unapplied-');t.after(()=>rm(root,{recursive:true,force:true}));
 const source=root+'/source';await mkdir(source);await writeFile(source+'/data.txt','Public content.');
 const neural={discover(_text,d){d.add('unmatched-candidate','secrets',{source:'model',label:'password',score:0.8});},close(){}};
 const result=await protectExport({source,categories:['secrets'],neural});
 assert.equal(result.status,'partial');assert.equal(result.unappliedValues,1);
 const report=JSON.parse(await readFile(result.report,'utf8'));
 assert.ok(report.warnings.some(w=>w.file==='(detection mapping)'));
});
