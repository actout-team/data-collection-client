import { pause } from '../export.mjs';
import { safeLogText } from '../log.mjs';

export const hubspotTypes = ['contacts', 'companies', 'deals'];
const time = value => {
  value = value && typeof value === 'object' ? value.value : value;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) && result > 0 && result <= 8640000000000000 ? result : null;
};
// Website readers must supply current records with original properties intact.
// This selects created/modified records, not historical point-in-time snapshots.
function dates(record) {
  const properties = record?.properties;
  const p = Array.isArray(properties) ? Object.fromEntries(properties.filter(v => v && typeof v.name === 'string').map(v => [v.name, v.value])) : properties || {};
  const created = [record?.createdAt, record?.createdate, p.createdate, p.hs_createdate];
  const modified = [record?.updatedAt, record?.lastmodifieddate, p.lastmodifieddate, p.hs_lastmodifieddate];
  return {
    created: created.map(time).filter(v => v !== null), modified: modified.map(time).filter(v => v !== null),
    invalid: [...created, ...modified].filter(v => v !== undefined && v !== null && v !== '' && time(v) === null).length,
    properties: Array.isArray(properties) ? 'arrays' : properties && typeof properties === 'object' ? 'objects' : 'missing',
  };
}
export function hubspotTimes(record) {
  const d = dates(record);
  return [...new Set([...d.created, ...d.modified])];
}
const dateStats = () => ({ oldest: null, newest: null, withCreated: 0, withModified: 0, matchedCreated: 0, matchedModified: 0, matchedBoth: 0, beforeStart: 0, atOrAfterEnd: 0, straddlesWindow: 0, missing: 0, invalidFields: 0, properties: { arrays: 0, objects: 0, missing: 0 } });
function observeDates(record, summary, start, end) {
  const d = dates(record), timestamps = [...d.created, ...d.modified], inWindow = t => t >= start && t < end;
  summary.properties[d.properties]++; summary.invalidFields += d.invalid;
  if (d.created.length) summary.withCreated++;
  if (d.modified.length) summary.withModified++;
  const created = d.created.some(inWindow), modified = d.modified.some(inWindow);
  if (created) summary.matchedCreated++;
  if (modified) summary.matchedModified++;
  if (created && modified) summary.matchedBoth++;
  for (const t of timestamps) {
    summary.oldest = summary.oldest === null ? t : Math.min(summary.oldest, t);
    summary.newest = summary.newest === null ? t : Math.max(summary.newest, t);
  }
  if (!timestamps.length) summary.missing++;
  else if (!created && !modified) {
    if (timestamps.every(t => t < start)) summary.beforeStart++;
    else if (timestamps.every(t => t >= end)) summary.atOrAfterEnd++;
    else summary.straddlesWindow++;
  }
  return { selected: timestamps.filter(inWindow), hasDates: timestamps.length > 0 };
}
const cursorLabel = value => value == null ? 'none' : /^\d{1,9}$/.test(String(value)) ? String(value) : `opaque-${typeof value}`;
const iso = t => t === null ? 'none' : new Date(t).toISOString();
function pageIds(result) {
  if (!Array.isArray(result?.records) || typeof result.hasMore !== 'boolean' || result.records.length > 1000) throw Error('HubSpot returned an unsupported page format. Coverage is incomplete.');
  return result.records.map(row => {
    const id = row?.id ?? row?.objectId ?? row?.vid;
    if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && !Number.isSafeInteger(id)) || !/^\d{1,30}$/.test(String(id))) throw Error('HubSpot returned a record without a valid ID.');
    return String(id);
  });
}
const fatal = (error, signal) => signal?.aborted || ['ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'INVALID_REQUEST', 'UNSUPPORTED'].includes(error.code);

// The browser adapter normalizes only the page envelope to
// { records, hasMore, nextCursor }. Do not guess private endpoint or cursor shapes
// here. Its request must be a verified, account-bound website read.
export async function collectHubspot({ ask, window, writer, signal, stats, progress = () => {}, diagnostic = () => {}, meter = () => {}, wait = pause }) {
  const start = Date.parse(window?.start), end = Date.parse(window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error('Invalid HubSpot date window.');
  const coverage = { mode: 'website-api', window, windowApplied: true, selection: 'created-or-last-modified', snapshot: 'current-record-values', complete: false, auditPolicy: { fullScanUpTo: 500, largerTypes: 'one-page-recently-modified-sample', endpoint: 'same-crm-search', excludes: ['deleted', 'inaccessible', 'other-object-types', 'activities', 'attachments', 'intermediate-property-history'] }, types: {} };
  let completed = 0;
  stats.unit = 'records';
  async function trace(message, emit = true) {
    const safe = safeLogText(message);
    if (emit) diagnostic(safe);
    await writer.append('diagnostics.jsonl', { time: new Date().toISOString(), source: 'hubspot', message: safe });
  }
  async function page(type, cursor, range, scope = 'window') {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      const result = await ask({ op: 'hubspot-page', body: { type, window: range, cursor: cursor ?? 0, ...(scope === 'all' ? { scope } : {}) } });
      if (Array.isArray(result?.diagnostics)) for (const message of result.diagnostics.slice(0, 16)) if (typeof message === 'string') await trace(message, false);
      signal?.throwIfAborted();
      if (result?.status !== 429) return result;
      if (attempt === 4) throw Error('HubSpot rate limit persists. Saved records were retained.');
      const retry = Number(result.retryAfter);
      const seconds = Number.isFinite(retry) && retry > 0 ? retry : Math.min(30, 2 ** (attempt + 1));
      // Do not shorten a server-requested delay and keep cancellation responsive.
      if (seconds > 300) throw Error('HubSpot requested a long rate-limit delay. Try again later. Saved records were retained.');
      await trace(`HubSpot ${type}: ${scope} query rate limited. Retrying in ${seconds}s.`);
      await wait(seconds * 1000, signal);
    }
  }
  async function auditType(type, count, filteredIds, writtenIds) {
    const audit = count.audit = { status: 'running', scope: 'unfiltered-api-visible', pages: 0, received: 0, unique: 0, totalFirst: null, totalLast: null, totalMax: 0, totalChanges: 0, duplicates: 0, inWindow: 0, recovered: 0, absentFromFiltered: 0, dates: dateStats() };
    const ids = new Set(), cursors = new Set();
    let cursor = 0;
    try {
      await trace(`HubSpot ${type}: auditing without date filters. Fully check up to 500 API-visible records; larger types use one recently-modified page.`);
      for (;;) {
        signal?.throwIfAborted();
        if (audit.pages >= 10) throw Error('HubSpot audit page budget reached. Coverage check is incomplete.');
        const result = await page(type, cursor, window, 'all'), rowIds = pageIds(result);
        if (!Number.isSafeInteger(result.total) || result.total < 0) throw Error('HubSpot audit did not return a valid unfiltered total.');
        if (audit.totalLast !== null && audit.totalLast !== result.total) audit.totalChanges++;
        audit.totalFirst ??= result.total; audit.totalLast = result.total; audit.totalMax = Math.max(audit.totalMax, result.total);
        audit.pages++; audit.received += rowIds.length;
        const before = ids.size;
        for (let i = 0; i < rowIds.length; i++) {
          signal?.throwIfAborted();
          const id = rowIds[i], record = result.records[i];
          if (ids.has(id)) { audit.duplicates++; continue; }
          ids.add(id); audit.unique = ids.size;
          const { selected } = observeDates(record, audit.dates, start, end);
          if (!selected.length) continue;
          audit.inWindow++;
          if (!filteredIds.has(id)) audit.absentFromFiltered++;
          if (writtenIds.has(id)) continue;
          await writer.append(`${type}.jsonl`, record);
          writtenIds.add(id); audit.recovered++; count.saved++; stats.messages++; meter({ timestamp: Math.max(...selected) });
        }
        audit.unique = ids.size;
        await trace(`HubSpot ${type} audit page ${audit.pages}: API total=${result.total}, received=${rowIds.length}, unique=${audit.unique}, in-window=${audit.inWindow}, recovered=${audit.recovered}, hasMore=${result.hasMore}.`);
        if (!result.hasMore) {
          if (ids.size < audit.totalMax) throw Error('HubSpot unfiltered audit ended before its reported total.');
          audit.filteredOnly = [...filteredIds].filter(id => !ids.has(id)).length;
          audit.status = audit.totalChanges || audit.filteredOnly ? 'unstable' : 'full';
          if (audit.filteredOnly) stats.warnings.push(`HubSpot ${type}: ${audit.filteredOnly} filtered records were absent from the full audit. Records or permissions may have changed during collection.`);
          break;
        }
        if (audit.totalMax > 500 || audit.received >= 500) { audit.status = 'sampled'; break; }
        if (ids.size === before) throw Error('HubSpot audit repeated records without progress.');
        const next = result.nextCursor;
        if (!['string', 'number'].includes(typeof next) || !String(next).length || String(next).length > 4096 || String(next) === String(cursor) || cursors.has(String(next))) throw Error('HubSpot audit continuation is missing or repeated.');
        cursors.add(String(next)); cursor = next;
      }
      if (audit.recovered) stats.warnings.push(`HubSpot ${type}: recovered ${audit.recovered} in-window records from the unfiltered audit. ${audit.absentFromFiltered} were absent from the filtered results. Filters or changing records may have caused omissions.`);
      if (audit.totalChanges) stats.warnings.push(`HubSpot ${type}: unfiltered API totals changed ${audit.totalChanges} times during the audit. This is not a stable snapshot.`);
      if (audit.dates.missing) stats.warnings.push(`HubSpot ${type}: ${audit.dates.missing} audited records had no usable dates; date-window eligibility could not be determined.`);
    } catch (error) {
      audit.status = 'failed'; audit.error = safeLogText(error.message);
      if (fatal(error, signal)) throw error;
      stats.warnings.push(`HubSpot ${type} audit: ${audit.error}`);
    }
    await trace(`HubSpot ${type} audit ${audit.status}: API-visible total=${audit.totalLast ?? 'unknown'}, checked=${audit.unique}, in-window=${audit.inWindow}, outside=${audit.dates.beforeStart + audit.dates.atOrAfterEnd + audit.dates.straddlesWindow}, undated=${audit.dates.missing}, recovered=${audit.recovered}.`);
    await trace(`HubSpot ${type} audit dates: ${iso(audit.dates.oldest)} to ${iso(audit.dates.newest)}. Before start=${audit.dates.beforeStart}, at/after end=${audit.dates.atOrAfterEnd}, straddling=${audit.dates.straddlesWindow}. ${audit.status === 'sampled' ? 'Remainder not audited.' : 'Same endpoint and permissions; hidden/deleted records remain unverified.'}`);
  }
  try {
    for (const type of hubspotTypes) {
      const count = coverage.types[type] = { pages: 0, received: 0, saved: 0, duplicates: 0, outsideWindow: 0, missingTimestamp: 0, scanComplete: false };
      const seen = new Set(), written = new Set();
      count.dates = dateStats(); count.ranges = []; count.unique = 0;
      const ranges = [{ start, end }];
      count.partitions = 0;
      try {
        while (ranges.length) {
          if (++count.partitions > 10000) throw Error('HubSpot reached the date-partition limit. Coverage is incomplete.');
          const range = ranges.pop(), cursors = new Set(), signatures = new Set();
          const queryWindow = count.partitions === 1 ? window : { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() };
          const rangeReport = { window: queryWindow, pages: 0, received: 0, unique: 0, totalFirst: null, totalLast: null, totalMax: null, totalChanges: 0, scanComplete: false };
          count.ranges.push(rangeReport);
          let cursor = null;
          const rangeIds = new Set();
          for (;;) {
            signal?.throwIfAborted();
            if (count.pages >= 10000) throw Error('HubSpot reached the page limit. Coverage is incomplete.');
            progress(`HubSpot: reading ${type}, page ${count.pages + 1}. ${stats.messages} records saved.`);
            const result = await page(type, cursor, queryWindow);
            if (result?.splitRequired) {
              if (cursor !== null || range.end - range.start <= 1) throw Error('HubSpot search limit reached in the smallest date range. Coverage is incomplete.');
              const middle = Math.floor((range.start + range.end) / 2);
              ranges.push({ start: middle, end: range.end }, { start: range.start, end: middle });
              rangeReport.split = true;
              await trace(`HubSpot ${type}: large result set; splitting ${queryWindow.start} to ${queryWindow.end}.`);
              break;
            }
            const ids = pageIds(result);
            if (Number.isSafeInteger(result.total)) {
              if (rangeReport.totalLast !== null && rangeReport.totalLast !== result.total) rangeReport.totalChanges++;
              rangeReport.totalFirst ??= result.total; rangeReport.totalLast = result.total;
              rangeReport.totalMax = Math.max(rangeReport.totalMax ?? 0, result.total);
            }
            count.pages++; count.received += ids.length;
            rangeReport.pages++; rangeReport.received += ids.length;
            for (const id of ids) rangeIds.add(id);
            rangeReport.unique = rangeIds.size;
            const signature = [...new Set(ids)].sort().join(',');
            if (ids.length && signatures.has(signature)) throw Error('HubSpot repeated a page. Pagination is incomplete.');
            if (ids.length) signatures.add(signature);
            const pageSaved = count.saved;
            for (let i = 0; i < result.records.length; i++) {
              signal?.throwIfAborted();
              const id = ids[i], record = result.records[i];
              if (seen.has(id)) { count.duplicates++; continue; }
              seen.add(id); count.unique = seen.size;
              const { selected, hasDates } = observeDates(record, count.dates, start, end);
              if (!hasDates) { count.missingTimestamp++; continue; }
              if (!selected.length) { count.outsideWindow++; continue; }
              await writer.append(`${type}.jsonl`, record);
              written.add(id); count.saved++; stats.messages++; meter({ timestamp: Math.max(...selected) });
            }
            await trace(`HubSpot ${type}: page ${count.pages}, ${count.received} received, ${count.saved} saved, ${count.outsideWindow} outside window, ${count.missingTimestamp} missing dates.`);
            await trace(`HubSpot ${type} pagination: range=${count.partitions}, requested=${cursorLabel(cursor ?? 0)}, next=${cursorLabel(result.nextCursor)}, hasMore=${result.hasMore}, API total=${result.total ?? 'unknown'}, range unique=${rangeIds.size}, page saved=${count.saved - pageSaved}, duplicates=${count.duplicates}.`);
            if (!result.hasMore) {
              if (rangeReport.totalMax !== null && rangeIds.size < rangeReport.totalMax) throw Error('HubSpot ended pagination before the reported total. Coverage is incomplete.');
              rangeReport.scanComplete = true;
              break;
            }
            const next = result.nextCursor;
            if (!['string', 'number'].includes(typeof next) || !String(next).length || String(next).length > 4096 || String(next) === String(cursor) || cursors.has(String(next))) throw Error('HubSpot continuation is missing or repeated. Coverage is incomplete.');
            cursors.add(String(next)); cursor = next;
          }
        }
        count.scanComplete = true; completed++;
      } catch (error) {
        if (fatal(error, signal)) throw error;
        count.error = error.message;
        stats.warnings.push(`HubSpot ${type}: ${error.message}`);
        await trace(`HubSpot ${type}: scan incomplete: ${error.message}`);
      }
      if (count.missingTimestamp) stats.warnings.push(`HubSpot ${type}: ${count.missingTimestamp} records lacked usable creation/modification dates and were not exported.`);
      const changed = count.ranges.reduce((sum, r) => sum + r.totalChanges, 0);
      if (changed) stats.warnings.push(`HubSpot ${type}: filtered API totals changed ${changed} times. Records or permissions may have changed during collection.`);
      if (count.outsideWindow) stats.warnings.push(`HubSpot ${type}: the server returned ${count.outsideWindow} records outside the requested window. Local date filtering excluded them.`);
      count.filteredSaved = count.saved;
      await trace(`HubSpot ${type} filtered dates: ${iso(count.dates.oldest)} to ${iso(count.dates.newest)}. Matched creation=${count.dates.matchedCreated}, modification=${count.dates.matchedModified}, both=${count.dates.matchedBoth}; before=${count.dates.beforeStart}, at/after end=${count.dates.atOrAfterEnd}, undated=${count.dates.missing}, invalid fields=${count.dates.invalidFields}.`);
      await trace(`HubSpot ${type} schema: properties arrays=${count.dates.properties.arrays}, objects=${count.dates.properties.objects}, missing=${count.dates.properties.missing}; records with creation dates=${count.dates.withCreated}, modification dates=${count.dates.withModified}.`);
      if (count.scanComplete) await auditType(type, count, seen, written);
      else count.audit = { status: 'skipped', reason: 'filtered-scan-incomplete' };
      await trace(`HubSpot ${type} summary: filtered unique=${count.unique}, filtered saved=${count.filteredSaved}, audit=${count.audit.status}, recovered=${count.audit.recovered || 0}, total saved=${count.saved}, scanComplete=${count.scanComplete}.`);
    }
    if (!completed && !stats.messages) throw Error('HubSpot could not read any record type. Check the connection and coverage report.');
    return {
      status: 'partial', scanComplete: completed === hubspotTypes.length, windowApplied: true, unit: 'records',
      coverage: 'Current contacts, companies and deals created or last modified in the selected date window. Website API completeness is unverified. Deleted records, full property-change history, activities and attachments are not included.',
    };
  } finally {
    // Retain explicit per-type coverage even when cancellation or an error stops
    // collection. The existing export writer keeps already saved records.
    coverage.scanComplete = completed === hubspotTypes.length;
    coverage.saved = stats.messages;
    coverage.warnings = [...stats.warnings];
    const audits = Object.values(coverage.types).map(t => t.audit);
    await trace(`HubSpot audit summary: full=${audits.filter(a => a?.status === 'full').length}, sampled=${audits.filter(a => a?.status === 'sampled').length}, unstable=${audits.filter(a => a?.status === 'unstable').length}, failed=${audits.filter(a => a?.status === 'failed').length}, skipped=${audits.filter(a => !a || a.status === 'skipped').length}, recovered=${audits.reduce((n, a) => n + (a?.recovered || 0), 0)}. Details: coverage.jsonl and diagnostics.jsonl.`);
    await trace(`HubSpot summary: filtered scans=${completed}/${hubspotTypes.length}, saved=${stats.messages}, audits full=${Object.values(coverage.types).filter(t => t.audit?.status === 'full').length}, sampled=${Object.values(coverage.types).filter(t => t.audit?.status === 'sampled').length}. Deleted/inaccessible records, other object types, activities, attachments and full property history are outside this scan.`);
    await writer.append('coverage.jsonl', coverage);
  }
}
