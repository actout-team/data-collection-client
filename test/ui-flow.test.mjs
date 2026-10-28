import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { catalog, appPage, stepBlock, canReview } from '../ui/catalog.mjs';
import { getApp, hostPermissions } from '../extension/catalog.mjs';

test('Tested connectors stay first and pagination handles large catalogs without duplicates', () => {
  const large = [...catalog, ...Array.from({ length: 250 }, (_, n) => ({ id: `future-${n}`, name: `Future ${n}`, category: 'Other', detail: '', maturity: 'pending' }))];
  assert.deepEqual(appPage(large).items.slice(0, 2).map(a => a.id), ['slack', 'gmail']);
  const rows = [];
  for (let p = 1; p <= appPage(large).pages; p++) rows.push(...appPage(large, '', p).items);
  assert.equal(rows.length, large.length);
  assert.equal(new Set(rows.map(a => a.id)).size, large.length);
  assert.equal(appPage(large, '', 999).page, appPage(large).pages);
});
test('Search is case-insensitive, searches categories, and safely handles no results', () => {
  assert.equal(appPage(catalog, ' HUBSPOT ', 3).items[0].id, 'hubspot');
  assert.equal(appPage(catalog, 'accounting').total, 2);
  assert.equal(appPage(catalog, 'not-a-real-app', 9).total, 0);
  assert.equal(appPage(catalog, 'not-a-real-app', 9).page, 1);
});
test('Pending listings cannot be selected for download and add no bridge permission', () => {
  for (const app of catalog.filter(a => a.maturity === 'pending')) {
    assert.equal(getApp(app.id), undefined);
    assert.ok(stepBlock(1, { browserConnected: true, apps: { [app.id]: { connected: true } } }, new Set([app.id])));
  }
  assert.equal(hostPermissions.some(h => h.includes('trello')), false);
});
test('Next step requires browser pairing, selection and connected accounts', () => {
  const selected = new Set(['slack']);
  assert.ok(stepBlock(0, {}, selected));
  assert.equal(stepBlock(0, { browserConnected: true }, selected), '');
  assert.ok(stepBlock(1, { browserConnected: true }, new Set()));
  assert.ok(stepBlock(1, { browserConnected: true }, selected));
  assert.equal(stepBlock(1, { browserConnected: true, apps: { slack: { connected: true } } }, selected), '');
  assert.ok(stepBlock(1, { busy: true }, selected));
});
test('Failed or still-running downloads cannot be presented as an export', () => {
  assert.equal(canReview({}), false);
  assert.equal(canReview({ downloadResult: { status: 'failed', saved: 0 } }), false);
  assert.equal(canReview({ busy: true, downloadResult: { status: 'finished', saved: 1 } }), false);
  assert.equal(canReview({ downloadResult: { status: 'cancelled', saved: 0 } }), false);
  assert.equal(canReview({ downloadResult: { status: 'cancelled', saved: 4 } }), true);
  assert.equal(canReview({ downloadResult: { status: 'partial', saved: 4 } }), true);
  assert.equal(canReview({ downloadResult: { status: 'finished', saved: 0 } }), true);
});
test('Every listed app has a bundled icon and metadata', async () => {
  for (const app of catalog) {
    await access(new URL(`../ui/icons/${app.id}.svg`, import.meta.url));
    assert.ok(app.detail && app.category);
  }
});
test('Step markup has unique IDs and all five content panels', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...html.matchAll(/data-step="(\d)"/g)].map(m => m[1]), ['0', '1', '2', '3', '4']);
});
