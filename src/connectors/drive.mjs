import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { pause } from '../export.mjs';

export async function collectDrive({ ask, writer, dir, window, signal, progress = () => {}, stats, diagnostic = () => {}, meter = () => {}, wait = pause }) {
  const start = Date.parse(window.start), end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error('Invalid Drive window.');
  const seen = new Set(), cursors = new Set(); let cursor = '', pages = 0, duplicates = 0, outside = 0, missingDates = 0, downloaded = 0, failedFiles = 0, incompleteSearch = false, completed = false;
  stats.warnings.push('Drive exports current accessible file versions modified in the selected window. Deleted files, revision history and shortcut targets are not included. Files over 128 MB and download-restricted files are reported separately.');
  async function readPage() {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      const result = await ask({ op: 'drive-page', body: { ...window, cursor, pageSize: 100 } });
      if (result?.status === 429 || result?.status >= 500) {
        const raw = result.retryAfter;
        const seconds = raw && Number.isFinite(Number(raw)) ? Number(raw) : raw && Number.isFinite(Date.parse(raw)) ? (Date.parse(raw) - Date.now()) / 1000 : 2 ** attempt;
        await wait(Math.min(300000, Math.max(1000, seconds * 1000)), signal); continue;
      }
      if (result?.status !== 200 || !Array.isArray(result.items) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) throw Error('Drive returned an invalid list page.');
      return result;
    }
    throw Error('Drive rate limit or service error persists. Partial files were kept.');
  }
  async function downloadFile(item) {
    const ready = await ask({ op: 'drive-file', body: { item } });
    if (ready?.status === 'skipped') return { status: 'skipped', reason: ready.reason };
    if (ready?.status !== 'ready' || !/^[a-z0-9]{1,10}$/.test(ready.extension || '')) throw Error('Drive returned invalid download metadata.');
    const folder = path.join(dir, 'files'); await mkdir(folder, { recursive: true, mode: 0o700 });
    const filename = `${item.id}.${ready.extension}`, target = path.join(folder, filename);
    const file = await open(target + '.part', 'wx', 0o600); let bytes = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await ask({ op: 'drive-chunk' });
        if (next?.done === true) {
          if (next.bytes !== bytes || (ready.expectedBytes != null && ready.expectedBytes !== bytes)) throw Error('Drive file ended before its expected size.');
          break;
        }
        if (next?.done !== false || typeof next.base64 !== 'string' || next.base64.length > 350000 || next.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(next.base64)) throw Error('Drive returned an invalid file chunk.');
        const buffer = Buffer.from(next.base64, 'base64');
        if (buffer.toString('base64') !== next.base64) throw Error('Drive returned invalid base64 file data.');
        if (!buffer.length || bytes + buffer.length > 128 * 1024 * 1024 || next.bytes !== bytes + buffer.length) throw Error('Drive file size or stream sequence is invalid.');
        // FileHandle.write may perform a short write.
        let offset = 0;
        while (offset < buffer.length) { const result = await file.write(buffer, offset, buffer.length - offset); if (!result.bytesWritten) throw Error('Drive file write made no progress.'); offset += result.bytesWritten; }
        bytes += buffer.length;
      }
    } finally { await file.close(); }
    await rename(target + '.part', target);
    downloaded++;
    return { status: 'downloaded', path: `files/${filename}`, bytes, contentType: ready.contentType };
  }
  try {
    do {
      signal?.throwIfAborted();
      const page = await readPage(); pages++;
      incompleteSearch ||= page.incompleteSearch === true;
      let newItems = 0;
      for (const item of page.items) {
        signal?.throwIfAborted();
        if (!item || typeof item.id !== 'string' || !/^[\w-]{1,200}$/.test(item.id) || typeof item.title !== 'string' || typeof item.mimeType !== 'string') throw Error('Drive file metadata schema changed.');
        if (seen.has(item.id)) { duplicates++; continue; } seen.add(item.id); newItems++;
        const modified = item.modifiedDateMillis == null || item.modifiedDateMillis === '' ? NaN : Number(item.modifiedDateMillis);
        if (!Number.isSafeInteger(modified)) { missingDates++; continue; }
        if (modified < start || modified >= end || item.trashed) { outside++; continue; }
        let content;
        try { content = await downloadFile(item); }
        catch (error) {
          if (signal?.aborted || ['ACCOUNT_CHANGED', 'LOGIN_REQUIRED'].includes(error.code)) throw error;
          failedFiles++; content = { status: 'unavailable', reason: error.message };
          await ask({ op: 'drive-clear' }).catch(() => {});
        }
        if (content.status === 'skipped' && !['folder', 'shortcut'].includes(content.reason)) failedFiles++;
        await writer.append('files.jsonl', { ...item, content }); stats.messages++;
        meter({ timestamp: modified });
        progress(`Google Drive: ${stats.messages} records, ${downloaded} files downloaded.`);
      }
      await writer.append('coverage.jsonl', { page: pages, returned: page.items.length, newItems, saved: stats.messages, downloaded, failedFiles, hasNextPage: !!page.nextCursor, incompleteSearch: page.incompleteSearch === true });
      diagnostic(`Drive page ${pages}: ${page.items.length} returned; ${stats.messages} records and ${downloaded} files saved.`);
      if (page.nextCursor && (!newItems || page.nextCursor === cursor || cursors.has(page.nextCursor))) throw Error('Drive repeated a page or cursor. Partial files were kept.');
      cursor = page.nextCursor || '';
      if (cursor) cursors.add(cursor);
      if (pages >= 10000 && cursor) throw Error('Drive reached its page safety limit. Partial files were kept.');
    } while (cursor);
    completed = true;
  } finally {
    // A fresh bridge request may be needed by the app after cancellation.
    if (!signal?.aborted) await ask({ op: 'drive-clear' }).catch(() => {});
    await writer.append('coverage.jsonl', { window, pages, saved: stats.messages, downloaded, failedFiles, duplicates, outside, missingDates, incompleteSearch, scanComplete: completed && !signal?.aborted, scope: 'current-accessible-files-modified-in-window' });
  }
  if (missingDates) stats.warnings.push(`${missingDates} Drive records had no usable modification timestamp and were excluded.`);
  if (failedFiles) stats.warnings.push(`${failedFiles} Drive files could not be downloaded. Metadata and per-file reasons were retained.`);
  if (incompleteSearch) stats.warnings.push('Drive reported an incomplete search.');
  // Transport validation is not independent proof of complete account coverage.
  stats.warnings.push('Experimental website API: shared-drive completeness and all file types have not been independently validated.');
  return { status: 'partial', scanComplete: !incompleteSearch && !missingDates, unit: 'records', downloaded, failedFiles, coverage: `${stats.messages} metadata records; ${downloaded} file contents downloaded.` };
}
