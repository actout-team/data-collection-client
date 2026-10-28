import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { outlookIdentity, outlookFolders, outlookConversations, outlookConversationItems, outlookMessagesInWindow } from '../src/connectors/outlook-protocol.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/outlook-schema.json', import.meta.url)));
const clone = key => structuredClone(fixture[key]);
const root = data => data.Body.ResponseMessages.Items[0].RootFolder;
const conversation = data => data.Body.ResponseMessages.Items[0].Conversation;

test('Startup identity binds the mailbox and excludes session fields', () => {
  const startup = clone('startup'); startup.owaUserConfig.SessionSettings.DownloadToken = 'secret';
  const identity = outlookIdentity(startup);
  assert.equal(identity.email, 'owner@example.test');
  assert.ok(!JSON.stringify(identity).includes('secret'));
  assert.deepEqual(outlookIdentity(startup, identity), identity);
  assert.throws(() => outlookIdentity(startup, {...identity, accountId:'other'}), {code:'ACCOUNT_CHANGED'});
  assert.throws(() => outlookIdentity(startup, {...identity, email:'other@example.test'}), {code:'ACCOUNT_CHANGED'});
});
test('Folder completion uses the explicit server flag, including offset equal to total', () => {
  assert.equal(outlookFolders(fixture.folders).hasMore, false);
  const data = clone('folders'); root(data).IncludesLastItemInRange = false;
  assert.equal(outlookFolders(data).nextOffset, 1);
  assert.throws(() => outlookFolders(data, 1), /pagination progress/);
  delete root(data).IncludesLastItemInRange;
  assert.throws(() => outlookFolders(data), /IncludesLastItemInRange/);
});
test('Empty folder pages must explicitly finish and duplicate IDs are rejected', () => {
  const data = clone('folders'); root(data).Folders = []; root(data).IndexedPagingOffset = 0; root(data).TotalItemsInView = 0;
  assert.equal(outlookFolders(data).records.length, 0);
  root(data).IncludesLastItemInRange = false;
  assert.throws(() => outlookFolders(data), /pagination progress/);
  const duplicate = clone('folders'); root(duplicate).Folders.push(root(duplicate).Folders[0]);
  assert.throws(() => outlookFolders(duplicate), /duplicate folder/);
});
test('Conversation lists expose view-only coverage and reject stalled pages', () => {
  assert.equal(outlookConversations(fixture.conversations).coverage,'selected-view-only');
  const data = clone('conversations'); data.Body.TotalConversationsInView = 2;
  assert.equal(outlookConversations(data).nextOffset,1);
  data.Body.Conversations=[]; data.Body.IndexedOffset=0;
  assert.throws(() => outlookConversations(data), /pagination progress/);
});
test('API failures and malformed counts never look like empty success', () => {
  const data = clone('folders'); data.Body.ResponseMessages.Items[0].ResponseCode='ErrorAccessDenied';
  assert.throws(() => outlookFolders(data), {code:'OUTLOOK_API_ERROR'});
  const other = clone('conversations'); other.Body.TotalConversationsInView='1';
  assert.throws(() => outlookConversations(other), /TotalConversationsInView/);
  assert.throws(() => outlookFolders({}), /Body/);
});
test('Observed thread bodies remain explicitly incomplete unique fragments', () => {
  const result = outlookConversationItems(fixture.items,'synthetic-conversation');
  assert.equal(result.messages[0].body.coverage,'unique-fragment');
  assert.equal(result.complete,false); assert.equal(result.nodesComplete,true);
  const data = clone('items'); conversation(data).TotalConversationNodesCount = 21;
  assert.equal(outlookConversationItems(data,'synthetic-conversation').nodesComplete,false);
});
test('Thread binding rejects different conversations, including mismatched items', () => {
  assert.throws(() => outlookConversationItems(fixture.items,'other'), {code:'OUTLOOK_SCOPE_CHANGED'});
  const data=clone('items'); conversation(data).ConversationNodes[0].Items[0].ConversationId.Id='other';
  assert.throws(() => outlookConversationItems(data,'synthetic-conversation'), {code:'OUTLOOK_SCOPE_CHANGED'});
});
test('Recipient and body truncation and unavailable attachments stay explicit', () => {
  const data=clone('items'), item=conversation(data).ConversationNodes[0].Items[0];
  item.RecipientCounts.ToRecipientsCount=40; item.UniqueBody.IsTruncated=true; item.HasAttachments=true;
  const result=outlookConversationItems(data,'synthetic-conversation').messages[0];
  assert.equal(result.recipientsTruncated,true); assert.equal(result.body.truncated,true);
  assert.equal(result.attachmentContentStatus,'not-collected');
});
test('Missing bodies remain missing and oversized bodies fail without content in errors', () => {
  const data=clone('items'), item=conversation(data).ConversationNodes[0].Items[0];
  delete item.UniqueBody;
  assert.equal(outlookConversationItems(data,'synthetic-conversation').messages[0].body,null);
  item.UniqueBody={BodyType:'Text',Value:'x'.repeat(2*1024*1024+1),IsTruncated:false};
  assert.throws(() => outlookConversationItems(data,'synthetic-conversation'), /body size/);
});
test('Duplicate messages are counted once', () => {
  const data=clone('items'), node=conversation(data).ConversationNodes[0]; node.Items.push(node.Items[0]);
  const result=outlookConversationItems(data,'synthetic-conversation');
  assert.equal(result.messages.length,1); assert.equal(result.duplicates,1);
});
test('Date filtering applies to individual messages with inclusive start and exclusive end', () => {
  const window={start:'2026-10-01T00:00:00Z',end:'2026-10-17T00:00:00Z'};
  const result=outlookMessagesInWindow([{id:'start',receivedAt:window.start},{id:'end',receivedAt:window.end},{id:'old',receivedAt:'2026-09-01T00:00:00Z'},{id:'sent',sentAt:window.start},{id:'missing'}],window);
  assert.deepEqual(result.selected.map(v=>v.id),['start','sent']);
  assert.deepEqual(result.missingDates,['missing']);
  assert.throws(()=>outlookMessagesInWindow([{id:'bad',receivedAt:'invalid'}],window), /timestamp/);
});

test('Calendar and contacts folders can omit unread counts without becoming zero', () => {
  const data=clone('folders'); delete root(data).Folders[0].UnreadCount;
  root(data).Folders[0].FolderClass='IPF.Appointment';
  assert.equal(outlookFolders(data).records[0].unreadCount,null);
});
