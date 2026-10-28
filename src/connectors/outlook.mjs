import { outlookFolders, outlookItemPage, outlookConversationItems, outlookMessagesInWindow } from './outlook-protocol.mjs';
import { pause } from '../export.mjs';

export async function collectOutlook({ ask, writer, window, signal, stats, progress = () => {}, meter = () => {}, wait = pause }) {
  outlookMessagesInWindow([], window);
  const folders = new Set(), messages = new Set();
  const detailCache = new Map(); // Bounded to avoid retaining an entire mailbox in RAM.
  let folderPages = 0, itemPages = 0, scanned = 0, skippedFolders = 0, missingDates = 0, missingBodies = 0, detailFailures = 0, completed = false;
  stats.warnings.push('Beta: Outlook.com personal mail only. HTML body fragments may omit quoted content. MIME/EML originals and attachment files are not downloaded.');
  async function read(op, body) {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      const response = await ask({ op, body });
      signal?.throwIfAborted();
      if (response?.status === 429 || response?.status >= 500) {
        if (attempt === 3) throw Error('Outlook remained throttled or unavailable. Saved data was kept.');
        const raw = response.retryAfter;
        const seconds = raw && Number.isFinite(Number(raw)) ? Number(raw) : raw && Number.isFinite(Date.parse(raw)) ? (Date.parse(raw) - Date.now()) / 1000 : 2 ** attempt;
        await wait(Math.max(1000, Math.min(30000, seconds * 1000)), signal); continue;
      }
      if (response?.status !== 200 || !response.data) throw Error('Outlook returned an invalid response.');
      return response.data;
    }
  }
  async function enrich(record) {
    if (!record.conversationId) return record;
    let details = detailCache.get(record.conversationId);
    if (!details) {
      try { details = outlookConversationItems(await read('outlook-conversation', { conversationId: record.conversationId }), record.conversationId); }
      catch (error) {
        if (signal?.aborted || ['ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'OUTLOOK_SCOPE_CHANGED'].includes(error.code)) throw error;
        detailFailures++; details = { messages: [], nodesComplete: false, failed: true };
      }
      if (detailCache.size >= 10) detailCache.delete(detailCache.keys().next().value);
      detailCache.set(record.conversationId, details);
    }
    const message = details.messages.find(item => item.id === record.id);
    // Never export extra thread members, even when a conversation spans folders/dates.
    return message ? { ...record, ...message, folderId: record.folderId, receivedAt: record.receivedAt, sentAt: record.sentAt, coverage: 'conversation-fragment', conversationNodesComplete: details.nodesComplete } : { ...record, bodyUnavailable: true };
  }
  try {
    let folderOffset = 0;
    while (true) {
      signal?.throwIfAborted();
      if (++folderPages > 10000) throw Error('Outlook folder page limit reached.');
      const page = outlookFolders(await read('outlook-folders', { offset: folderOffset }), folderOffset);
      let newFolders = 0;
      for (const folder of page.records) {
        if (folders.has(folder.id)) continue;
        folders.add(folder.id); newFolders++;
        await writer.append('folders.jsonl', folder);
        if (folder.folderClass !== 'IPF.Note') { skippedFolders++; continue; }
        stats.channels++;
        let offset = 0, pages = 0; const listed = new Set();
        while (true) {
          if (++pages > 10000) throw Error('Outlook message page limit reached.');
          const items = outlookItemPage(await read('outlook-items', { folderId: folder.id, offset }), offset); itemPages++;
          let fresh = 0;
          for (const record of items.records) {
            if (!listed.has(record.id)) { listed.add(record.id); fresh++; }
            if (messages.has(record.id)) continue;
            messages.add(record.id); scanned++;
            if (scanned > 1000000) throw Error('Outlook message safety limit reached.');
            const selection = outlookMessagesInWindow([record], window);
            missingDates += selection.missingDates.length;
            if (!selection.selected.length) continue;
            signal?.throwIfAborted();
            const message = await enrich({ ...record, folderId: folder.id });
            if (!message.body) missingBodies++;
            await writer.append('messages.jsonl', message); stats.messages++;
            meter({ timestamp: Date.parse(message.receivedAt || message.sentAt) });
            progress(`Outlook: ${stats.messages} messages saved, ${stats.channels} mail folders scanned.`);
          }
          if (!items.hasMore) break;
          if (!fresh) throw Error('Outlook repeated a message page. Partial export was kept.');
          offset = items.nextOffset;
        }
      }
      if (!page.hasMore) break;
      if (!newFolders) throw Error('Outlook repeated a folder page. Partial export was kept.');
      folderOffset = page.nextOffset;
    }
    completed = true;
  } finally {
    detailCache.clear();
    await writer.append('coverage.jsonl', { maturity: 'beta', window, folderPages, itemPages, scanned, saved: stats.messages, mailFolders: stats.channels, skippedFolders, missingDates, missingBodies, detailFailures, scanComplete: completed, scope: 'accessible-IPF.Note-folders', bodyCoverage: 'unique-fragments', mime: 'not-collected', attachmentContent: 'not-collected' });
  }
  if (missingDates) stats.warnings.push(`${missingDates} records had no usable message timestamp and were excluded.`);
  if (missingBodies || detailFailures) stats.warnings.push(`${missingBodies} messages have metadata only; ${detailFailures} conversation reads failed.`);
  return { status: 'partial', scanComplete: completed && missingDates === 0, coverage: `${stats.messages} messages saved from ${stats.channels} mail folders. Beta: body fragments only; MIME and attachment files not collected.` };
}
