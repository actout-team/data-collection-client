export async function collectGmail({ ask, window, writer, signal, progress, stats, meter = () => {}, diagnostic = () => {} }) {
  const start = Math.floor(Date.parse(window.start) / 1000), end = Math.ceil(Date.parse(window.end) / 1000);
  const seen = new Set(), threads = new Set();
  for await (const result of searchPages({ ask, start, end, signal, progress, stats, diagnostic })) {
    for (const thread of result.threads) {
      signal?.throwIfAborted();
      if (!/^thread-[af]:[A-Za-z0-9_-]{1,128}$/.test(thread.id) || !Array.isArray(thread.messageIds)) throw Error('Invalid Gmail thread descriptor.');
      if (threads.has(thread.id)) continue; // Date subdivisions can return the same conversation.
      threads.add(thread.id);
      progress(`Gmail: ${stats.messages} saved. Reading conversation ${threads.size} via API…`);
      const detail = await ask({ op: 'gmail-thread', body: { id: thread.id } });
      if (!Array.isArray(detail?.messages) || !Array.isArray(detail.allIds) || thread.messageIds.some(id => !detail.allIds.includes(id))) throw Error('Gmail thread response omitted messages from the search results.');
      const messages = [...new Map(detail.messages.filter(message =>
        /^msg-[af]:[A-Za-z0-9_-]{1,128}$/.test(message.id) && !seen.has(message.id) &&
        Number.isFinite(message.timestamp) && message.timestamp >= Date.parse(window.start) && message.timestamp < Date.parse(window.end)
      ).map(message => [message.id, message])).values()];
      stats.discovered = (stats.discovered || 0) + messages.length;
      for (const message of messages) {
        signal?.throwIfAborted();
        if (message.content_status !== 'readable') stats.warnings.push(`Message ${message.id}: readable body unavailable. Original MIME and attachment contents are excluded from this version.`);
        // Original MIME bundles attachments. Do not request it, even when the
        // message metadata reports no attachments: it is not a content guarantee.
        await writer.append('messages.jsonl', {
          ...message,
          original_status: 'not-collected',
          attachmentContentStatus: 'not-collected',
          contentScope: 'message-body-and-metadata'
        });
        seen.add(message.id); stats.messages++; meter({ timestamp: message.timestamp });
        progress(`Gmail: ${stats.messages} saved / ${stats.discovered} found so far. Message body and metadata saved.`);
        if (stats.messages % 10 === 0) diagnostic(`${stats.messages} emails saved locally so far.`);
      }
    }
    diagnostic(`API page downloaded. ${stats.messages} emails saved in total. Continuing search.`);
  }
  return { status: 'partial', coverage: 'Internal API date-range scan completed. Unofficial API completeness is not independently verified. Spam and Trash excluded. Separately encrypted content is not decrypted. Original MIME and attachment contents are not collected.' };
}

// Recover broken offset pagination by bisecting the search interval. Never treat
// an omitted broad-search continuation as proof the mailbox was downloaded.
// Recovery ranges must return fewer than 50 conversations before accepting
// Gmail's omitted empty field. This is a conservative heuristic, not a coverage guarantee.
async function* searchPages({ ask, start, end, signal, progress, stats, diagnostic }) {
  const pending = [{ start, end, precise: false }];
  let requests = 0;
  while (pending.length) {
    const range = pending.pop(), signatures = new Set();
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (++requests > 10000) throw Error('Gmail reached the 10,000 search-request limit. Coverage is incomplete.');
      progress(`Gmail: ${stats.messages} saved. Requesting API page ${requests}…`);
      const result = await ask({ op: 'gmail-page', body: { ...range, offset } });
      if (!Array.isArray(result?.threads) || typeof result.done !== 'boolean' || result.done !== (result.threads.length === 0)) throw Error('Invalid Gmail search response.');
      const repeated = result.signature && signatures.has(result.signature);
      if (repeated || (result.ambiguous && (offset >= 50 || !range.precise))) {
        const middle = Math.floor((range.start + range.end) / 2);
        if (middle <= range.start) throw Error('Gmail pagination is incomplete even for a one-second interval. Saved emails retained.');
        diagnostic(`Gmail continuation unavailable at offset ${offset}. Splitting date range and continuing via API.`);
        pending.push({ start: range.start, end: middle, precise: true }, { start: middle, end: range.end, precise: true });
        break;
      }
      if (result.done) break;
      if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset !== offset + result.threads.length || !result.signature) throw Error('Invalid Gmail pagination offset.');
      signatures.add(result.signature);
      stats.pages = (stats.pages || 0) + 1;
      diagnostic(`API page ${requests}: ${result.threads.length} conversations (offset ${offset}).`);
      yield result;
      offset = result.nextOffset;
    }
  }
}
