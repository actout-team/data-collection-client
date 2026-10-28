// Outlook.com response decoders derived from an in-app-browser HAR, 2026-10-16.
// Pure decoders shared by the Outlook.com Beta collector.
const error = (field, code = 'OUTLOOK_SCHEMA') => Object.assign(Error(`Outlook response invalid at ${field}.`), { code });
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(field);
  return value;
}
function text(value, field, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max) throw error(field);
  return value;
}
function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(field);
  return value;
}
function list(value, field, max = 10000) {
  if (!Array.isArray(value) || value.length > max) throw error(field);
  return value;
}
function success(value, field) {
  object(value, field);
  if (value.ResponseClass !== 'Success' || value.ResponseCode !== 'NoError') throw error(field, 'OUTLOOK_API_ERROR');
  return value;
}
function responseMessage(data) {
  const body = object(object(data, 'response').Body, 'Body');
  const items = list(object(body.ResponseMessages, 'ResponseMessages').Items, 'ResponseMessages.Items');
  if (items.length !== 1) throw error('ResponseMessages.Items.length');
  return success(items[0], 'ResponseMessages.Items[0]');
}
function id(value, field) { return text(object(value, field).Id, `${field}.Id`); }
function timestamp(value, field, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw error(field);
  return value;
}
function mailboxes(values, field) {
  if (values == null) return [];
  return list(values, field, 10000).map((v, i) => {
    const mailbox = object(v.Mailbox || v, `${field}[${i}]`);
    return { name: typeof mailbox.Name === 'string' ? mailbox.Name : '', email: typeof mailbox.EmailAddress === 'string' ? mailbox.EmailAddress : '', routingType: typeof mailbox.RoutingType === 'string' ? mailbox.RoutingType : '' };
  });
}

export function outlookIdentity(startup, expected = null) {
  const session = object(object(object(startup, 'startup').owaUserConfig, 'owaUserConfig').SessionSettings, 'SessionSettings');
  const accountId = text(session.MailboxGuid, 'MailboxGuid');
  const email = text(session.UserEmailAddress, 'UserEmailAddress', 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error('UserEmailAddress');
  const name = typeof session.UserDisplayName === 'string' ? session.UserDisplayName : '';
  if (expected && (expected.accountId !== accountId || expected.email?.toLowerCase() !== email.toLowerCase())) throw error('account binding', 'ACCOUNT_CHANGED');
  // Deliberately exclude download tokens, proxy addresses, session IDs and config.
  return { accountId, email, name, ownerProfile: { email, name } };
}

export function outlookFolders(data, offset = 0) {
  count(offset, 'requested offset');
  const root = object(responseMessage(data).RootFolder, 'RootFolder');
  const records = list(root.Folders, 'Folders').map(folder => ({
    id: id(folder.FolderId, 'FolderId'),
    parentId: folder.ParentFolderId ? id(folder.ParentFolderId, 'ParentFolderId') : null,
    name: typeof folder.DisplayName === 'string' ? folder.DisplayName : null,
    folderClass: typeof folder.FolderClass === 'string' ? folder.FolderClass : null,
    distinguishedId: typeof folder.DistinguishedFolderId === 'string' ? folder.DistinguishedFolderId : null,
    totalCount: count(folder.TotalCount, 'TotalCount'),
    unreadCount: folder.UnreadCount == null ? null : count(folder.UnreadCount, 'UnreadCount')
  }));
  const next = count(root.IndexedPagingOffset, 'IndexedPagingOffset');
  const total = count(root.TotalItemsInView, 'TotalItemsInView');
  if (typeof root.IncludesLastItemInRange !== 'boolean') throw error('IncludesLastItemInRange');
  const hasMore = !root.IncludesLastItemInRange;
  // The capture includes offset == total with IncludesLastItemInRange false.
  // The server flag is authoritative. Never infer completion from total alone.
  if (hasMore && (next <= offset || !records.length)) throw error('folder pagination progress');
  if (new Set(records.map(v => v.id)).size !== records.length) throw error('duplicate folder IDs');
  return { records, total, hasMore, nextOffset: hasMore ? next : null };
}

export function outlookConversations(data, offset = 0) {
  count(offset, 'requested offset');
  const body = success(object(object(data, 'response').Body, 'Body'), 'Body');
  const records = list(body.Conversations, 'Conversations').map(conversation => ({
    id: id(conversation.ConversationId, 'ConversationId'),
    topic: typeof conversation.ConversationTopic === 'string' ? conversation.ConversationTopic : '',
    lastDelivery: timestamp(conversation.LastDeliveryTime, 'LastDeliveryTime', true),
    itemIds: list(conversation.ItemIds, 'ItemIds').map(v => id(v, 'ItemId')),
    globalItemIds: list(conversation.GlobalItemIds, 'GlobalItemIds').map(v => id(v, 'GlobalItemId'))
  }));
  const total = count(body.TotalConversationsInView, 'TotalConversationsInView');
  const next = count(body.IndexedOffset, 'IndexedOffset');
  const hasMore = next < total;
  if (next < offset || next < offset + records.length || (hasMore && (!records.length || next <= offset))) throw error('conversation pagination progress');
  if (new Set(records.map(v => v.id)).size !== records.length) throw error('duplicate conversation IDs');
  // Completion applies only to this view (e.g. Focused inbox), not the mailbox.
  return { records, total, hasMore, nextOffset: hasMore ? next : null, coverage: 'selected-view-only' };
}

export function outlookConversationItems(data, expectedId) {
  text(expectedId, 'expected conversation ID');
  const conversation = object(responseMessage(data).Conversation, 'Conversation');
  if (id(conversation.ConversationId, 'ConversationId') !== expectedId) throw error('conversation binding', 'OUTLOOK_SCOPE_CHANGED');
  const nodes = list(conversation.ConversationNodes, 'ConversationNodes');
  const totalNodes = count(conversation.TotalConversationNodesCount, 'TotalConversationNodesCount');
  if (nodes.length > totalNodes) throw error('conversation node count');
  const messages = [], seen = new Set(); let duplicates = 0;
  for (const node of nodes) for (const item of list(node.Items, 'ConversationNode.Items')) {
    const messageId = id(item.ItemId, 'ItemId');
    if (seen.has(messageId)) { duplicates++; continue; }
    seen.add(messageId);
    if (item.ConversationId && id(item.ConversationId, 'Item.ConversationId') !== expectedId) throw error('item conversation binding', 'OUTLOOK_SCOPE_CHANGED');
    const body = item.Body || item.UniqueBody;
    if (body && (!['Text', 'HTML'].includes(body.BodyType) || typeof body.Value !== 'string' || typeof body.IsTruncated !== 'boolean')) throw error('message body');
    if (body && body.Value.length > 2 * 1024 * 1024) throw error('message body size');
    const to = mailboxes(item.ToRecipients, 'ToRecipients'), cc = mailboxes(item.CcRecipients, 'CcRecipients'), bcc = mailboxes(item.BccRecipients, 'BccRecipients');
    const counts = item.RecipientCounts || {};
    const recipientsTruncated = [['ToRecipientsCount', to], ['CcRecipientsCount', cc], ['BccRecipientsCount', bcc]].some(([key, rows]) => counts[key] != null && count(counts[key], key) > rows.length);
    messages.push({ id: messageId, conversationId: expectedId, folderId: id(item.ParentFolderId, 'ParentFolderId'),
      itemClass: typeof item.ItemClass === 'string' ? item.ItemClass : '',
      subject: typeof item.Subject === 'string' ? item.Subject : '',
      internetMessageId: typeof item.InternetMessageId === 'string' ? item.InternetMessageId : '',
      receivedAt: timestamp(item.DateTimeReceived, 'DateTimeReceived', true), sentAt: timestamp(item.DateTimeSent, 'DateTimeSent', true),
      from: mailboxes(item.From ? [item.From] : [], 'From'), sender: mailboxes(item.Sender ? [item.Sender] : [], 'Sender'), to, cc, bcc,
      body: body ? { type: body.BodyType, content: body.Value, truncated: body.IsTruncated, coverage: item.Body ? 'body' : 'unique-fragment' } : null,
      recipientsTruncated, hasAttachments: item.HasAttachments === true,
      attachmentContentStatus: item.HasAttachments === true ? 'not-collected' : 'none-reported'
    });
  }
  return { messages, duplicates, returnedNodes: nodes.length, totalNodes, nodesComplete: nodes.length === totalNodes,
    // Captured request: MaxItemsToReturn=20, CalculateOnlyFirstBody=true,
    // BodyShape=UniqueFragment, Action=ReturnRootNode. Do not claim full mail.
    complete: false, coverage: 'captured-conversation-fragments' };
}

export function outlookMessagesInWindow(messages, window) {
  const start = Date.parse(window?.start), end = Date.parse(window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw error('date window');
  const selected = [], missingDates = [];
  for (const message of messages) {
    // Use received time when present, otherwise sent time. Never use the thread
    // timestamp as the date of all messages in the conversation.
    const date = message.receivedAt ?? message.sentAt;
    if (!date) { missingDates.push(message.id); continue; }
    timestamp(date, 'message timestamp');
    const time = Date.parse(date);
    if (time >= start && time < end) selected.push(message);
  }
  return { selected, missingDates };
}

// FindItem is the mailbox enumerator. Conversation reads only enrich listed IDs.
export function outlookItemPage(data, offset = 0) {
  count(offset, 'requested offset');
  const root = object(responseMessage(data).RootFolder, 'RootFolder');
  const records = list(root.Items, 'Items').map(item => ({
    id: id(item.ItemId, 'ItemId'), conversationId: item.ConversationId ? id(item.ConversationId, 'ConversationId') : null,
    subject: typeof item.Subject === 'string' ? item.Subject : '',
    internetMessageId: typeof item.InternetMessageId === 'string' ? item.InternetMessageId : '',
    receivedAt: timestamp(item.DateTimeReceived, 'DateTimeReceived', true), sentAt: timestamp(item.DateTimeSent, 'DateTimeSent', true),
    from: mailboxes(item.From ? [item.From] : [], 'From'), isRead: typeof item.IsRead === 'boolean' ? item.IsRead : null,
    body: null, hasAttachments: item.HasAttachments === true, attachmentContentStatus: item.HasAttachments === true ? 'not-collected' : 'none-reported', coverage: 'metadata-only'
  }));
  const next = count(root.IndexedPagingOffset, 'IndexedPagingOffset'), total = count(root.TotalItemsInView, 'TotalItemsInView');
  if (typeof root.IncludesLastItemInRange !== 'boolean') throw error('IncludesLastItemInRange');
  const hasMore = !root.IncludesLastItemInRange;
  if (next < offset || (hasMore && (next <= offset || !records.length))) throw error('item pagination progress');
  if (new Set(records.map(v => v.id)).size !== records.length) throw error('duplicate item IDs');
  return { records, total, hasMore, nextOffset: hasMore ? next : null };
}
