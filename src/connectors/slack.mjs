import { accountOwner } from '../account-owner.mjs';
import { slackApi } from '../export.mjs';

export async function collectSlack({ ask, window, writer, signal, progress, stats, meter = () => {}, diagnostic = () => {} }) {
  const oldest = Date.parse(window.start) / 1000, latest = Date.parse(window.end) / 1000;
  if (!Number.isFinite(oldest) || !Number.isFinite(latest) || oldest >= latest) throw Error('Invalid Slack date window.');
  const newScan = () => ({ received: 0, beforeWindow: 0, atOrAfterEnd: 0, duplicates: 0, invalidTimestamp: 0, oldestReceived: null, newestReceived: null });
  const total = stats.filter = newScan();
  const describe = scan => `${scan.received} message records received (including repeats); ${scan.beforeWindow} before start, ${scan.atOrAfterEnd} at/after end, ${scan.duplicates} in-window duplicates, ${scan.invalidTimestamp} invalid timestamps. Returned timestamp range: ${scan.oldestReceived || 'none'} to ${scan.newestReceived || 'none'}.`;
  diagnostic(`Saving messages from ${window.start} (inclusive) to ${window.end} (exclusive). Older history is scanned for recent thread replies.`);
  const call = (method, body) => slackApi(ask, method, body, signal, diagnostic);
  async function* pages(method, body, field) {
    let cursor = '', page = 0; const seen = new Set();
    do {
      const data = await call(method, { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data[field])) throw Error(`Slack ${method}: unexpected response.`);
      diagnostic(`${method}: page ${++page}, ${data[field].length} records received.`);
      yield data[field];
      cursor = data.response_metadata?.next_cursor || '';
      if (data.has_more && !cursor) throw Error(`Slack ${method}: more records exist but no cursor was returned.`);
      if (cursor && seen.has(cursor)) throw Error('Slack pagination repeated.');
      seen.add(cursor);
    } while (cursor);
  }
  try {
    for await (const users of pages('users.list', {}, 'members')) for (const user of users) {
      if (user.id === stats.account?.user_id) stats.owner = accountOwner('slack', stats.account, user);
      await writer.append('users.jsonl', user);
    }
  } catch (error) {
    if (signal?.aborted || error.code === 'ACCOUNT_CHANGED' || error.code === 'LOGIN_REQUIRED') throw error;
    stats.warnings.push(`User directory: ${error.message}`);
  }
  const visited = new Set();
  stats.channelsCompleted = 0; stats.channelsPartial = 0;
  const channelPages = [];
  for await (const channels of pages('conversations.list', { types: 'public_channel,private_channel,im,mpim', exclude_archived: false }, 'channels')) channelPages.push(channels);
  meter({ units: new Set(channelPages.flat().map(channel => channel.id)).size });
  for (const channels of channelPages) {
    for (const channel of channels) {
      signal?.throwIfAborted();
      if (!/^[CDG][A-Z0-9]+$/.test(channel.id)) throw Error('Slack returned an invalid conversation ID.');
      if (visited.has(channel.id)) continue;
      visited.add(channel.id);
      await writer.append('channels.jsonl', channel); stats.channels++;
      const before = stats.messages, failures = [], filter = newScan();
      diagnostic(`Scanning ${channel.id}: retained history and recent replies, including archived conversations.`);
      progress(`Slack: ${channel.name || channel.id} — ${stats.messages} messages`);
      const seen = new Set();
      async function save(message) {
        const time = typeof message?.ts === 'number' || (typeof message?.ts === 'string' && /^\d+(?:\.\d+)?$/.test(message.ts)) ? Number(message.ts) : NaN;
        const date = new Date(time * 1000);
        let reason;
        if (!Number.isFinite(time) || !Number.isFinite(date.getTime())) reason = 'invalidTimestamp';
        else if (time < oldest) reason = 'beforeWindow';
        else if (time >= latest) reason = 'atOrAfterEnd';
        else if (seen.has(message.ts)) reason = 'duplicates';
        for (const scan of [filter, total]) {
          scan.received++;
          if (reason) scan[reason]++;
          if (reason !== 'invalidTimestamp') {
            const iso = date.toISOString();
            if (!scan.oldestReceived || iso < scan.oldestReceived) scan.oldestReceived = iso;
            if (!scan.newestReceived || iso > scan.newestReceived) scan.newestReceived = iso;
          }
        }
        if (reason) return;
        await writer.append('messages.jsonl', { channel: channel.id, ...message });
        seen.add(message.ts); stats.messages++; meter({ timestamp: time * 1000 });
      }
      try {
        // Scan older roots too: a recent reply can belong to a years-old thread.
        for await (const messages of pages('conversations.history', { channel: channel.id, latest: String(latest), inclusive: false }, 'messages')) {
          for (const message of messages) {
            await save(message);
            if (message?.reply_count > 0 && (!message.latest_reply || !Number.isFinite(Number(message.latest_reply)) || Number(message.latest_reply) >= oldest)) {
              try {
                for await (const replies of pages('conversations.replies', { channel: channel.id, ts: message.ts, oldest: String(oldest), latest: String(latest), inclusive: true }, 'messages')) {
                  for (const reply of replies) await save(reply);
                }
              } catch (error) {
                if (signal?.aborted || ['ACCOUNT_CHANGED', 'LOGIN_REQUIRED'].includes(error.code)) throw error;
                failures.push(`Thread ${message.ts}: ${error.message}`);
              }
            }
          }
        }
      } catch (error) {
        if (signal?.aborted || ['ACCOUNT_CHANGED', 'LOGIN_REQUIRED'].includes(error.code)) throw error;
        // Record a channel's failure and continue the other accessible conversations.
        failures.push(error.message);
      }
      if (filter.invalidTimestamp) failures.push(`${filter.invalidTimestamp} message records had invalid timestamps and could not be checked against the selected dates.`);
      const status = failures.length ? 'partial' : 'finished';
      stats[failures.length ? 'channelsPartial' : 'channelsCompleted']++;
      for (const error of failures) stats.warnings.push(`${channel.id}: ${error}`);
      await writer.append('coverage.jsonl', { channel: channel.id, start: window.start, end: window.end, status, messages: stats.messages - before, filter, errors: failures });
      meter({ unitDone: true });
      diagnostic(`${channel.id}: ${status}, ${stats.messages - before} messages saved. ${stats.channelsCompleted} conversations completed, ${stats.channelsPartial} partial.`);
      diagnostic(`${channel.id}: ${describe(filter)}`);
    }
  }
  diagnostic(`Scan summary: ${stats.channels} conversation metadata records saved; ${stats.messages} messages saved. ${describe(total)}`);
  if (!stats.messages) diagnostic('No messages were saved in the selected date window. See the filter counts above; conversation metadata is in channels.jsonl. This does not independently verify that Slack returned all accessible history.');
  return { status: stats.warnings.length ? 'partial' : 'finished', coverage: 'Accessible retained messages only. Slack plan retention, permissions and attachment binaries are outside this export.' };
}
