// Export contracts, not PII classifiers. These fields carry relationships or
// protocol structure in our collectors. Unknown fields remain eligible for
// contextual detection. Contracts never apply inside an embedded JSON value.
const contracts = {
  'gmail/messages.jsonl': 'id thread_id smtp_id timestamp labels file bytes content_status original_status attachmentContentStatus contentScope attachments.id attachments.attachment_id attachments.size attachments.mime_type',
  'outlook/folders.jsonl': 'id parentId folderClass distinguishedId totalCount unreadCount',
  'outlook/messages.jsonl': 'id conversationId folderId internetMessageId receivedAt sentAt itemClass body.type *.routingType coverage attachmentContentStatus',
  'slack/users.jsonl': 'id team_id color tz tz_label updated profile.avatar_hash profile.team profile.api_app_id profile.bot_id profile.huddle_state profile.huddle_state_expiration_ts',
  'slack/channels.jsonl': 'id context_team_id creator user members shared_team_ids pending_shared pending_connected_team_ids conversation_host_id parent_conversation created updated frozen_reason purpose.creator purpose.last_set topic.creator topic.last_set properties.**.file_id properties.**.quip_thread_id properties.tabs.id properties.tabs.type properties.tabz.id properties.tabz.type',
  'slack/messages.jsonl': 'channel user team type subtype ts thread_ts event_ts deleted_ts latest_reply last_read client_msg_id bot_id app_id edited.user edited.ts replies.user replies.ts reply_users blocks.**.type blocks.**.block_id blocks.**.user_id blocks.**.channel_id attachments.id attachments.ts attachments.actions.id attachments.actions.name attachments.actions.type attachments.actions.style attachments.blocks.**.type attachments.blocks.**.block_id',
};
const compiled = new Map(Object.entries(contracts).map(([file, fields]) => [file, fields.split(' ').map(field => field.split('.'))]));
function matches(pattern, path) {
  if (!pattern.length) return !path.length;
  if (pattern[0] === '**') return matches(pattern.slice(1), path) || (path.length > 0 && matches(pattern, path.slice(1)));
  return path.length > 0 && (pattern[0] === '*' || pattern[0] === path[0]) && matches(pattern.slice(1), path.slice(1));
}
export function exportStructure(file, depth = 0) {
  const patterns = depth === 0 && compiled.get(file.replaceAll('\\', '/'));
  return path => Boolean(patterns && patterns.some(pattern => matches(pattern, path)));
}

export function serviceRecord(file, record, depth = 0) {
  return depth === 0 && file.replaceAll('\\', '/') === 'slack/users.jsonl'
    && (record?.is_bot === true || record?.id === 'USLACKBOT');
}
export const serviceIdentityField = path => /^(?:name|real_name|profile\.(?:first_name|last_name|real_name|real_name_normalized|display_name|display_name_normalized))$/.test(path.join('.'));
