import { accountOwner } from '../src/account-owner.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createProgress } from '../src/progress.mjs';
import { daysBackWindow, downloadStatus } from '../src/export.mjs';

// Exercise the actual IPC download handler through all three automatic collectors without disk I/O.
async function run(days, outcome = { status: 'finished' }) {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function download('), source.indexOf('// Finish evaluating'));
  const windows = [], reports = [], logs = [];
  let started = false;
  const collect = async ({ window }) => { windows.push(window); return outcome; };
  const context = vm.createContext({
    accountOwner, daysBackWindow, downloadStatus, path, days, AbortSignal, createProgress, estimateHistory: {}, estimator: null, estimateFile: null, emit() {},
    getApp: id => ({ name: id }), connections: new Map([['gmail', {}], ['slack', {}], ['hubspot', {}]]),
    begin: () => { started = true; return new AbortController().signal; }, end() {},
    log: (...args) => logs.push(args), progress() {}, identity: async () => {}, mkdir: async () => {},
    outputParent: '/test', state: {}, randomUUID: () => 'fixture',
    jsonFile: async (_, report) => reports.push(structuredClone(report)),
    createWriter: async () => ({ close: async () => {} }), request: () => {},
    getCollector: () => collect, bridge: { ask: async () => {} }
  });
  vm.runInContext(handler, context);
  let error;
  try { await vm.runInContext("download({ids:['gmail','slack','hubspot'],days})", context); }
  catch (e) { error = e; }
  return { windows, reports, logs, started, error };
}
for (const days of [1, 90, 365]) {
  test(`The download handler gives Gmail, Slack and HubSpot the same ${days}-day window`, async () => {
    const result = await run(days);
    assert.equal(result.error, undefined);
    assert.equal(result.windows.length, 3);
    assert.deepEqual(result.windows[0], result.windows[1]);
    assert.deepEqual(result.windows[0], result.windows[2]);
    assert.equal(Date.parse(result.windows[0].end) - Date.parse(result.windows[0].start), days * 86400000);
    assert.equal(result.reports.at(-1).daysBack, days);
    assert.equal(result.reports.at(-1).status, 'finished');
  });
}
test('Invalid days are rejected before a download or filesystem operation starts', async () => {
  const result = await run(0);
  assert.match(result.error.message, /whole number/);
  assert.equal(result.started, false);
  assert.equal(result.reports.length, 0);
});
test('Partial exports explain their coverage limitations in the activity log', async () => {
  const coverage = 'Internal API date-range scan completed. Completeness is not independently verified.';
  const result = await run(14, { status: 'partial', coverage });
  assert.equal(result.error, undefined);
  assert.ok(result.logs.some(([level, app, message]) => level === 'warn' && app === 'gmail' && message === coverage));
  assert.equal(result.reports.at(-1).status, 'partial');
});
