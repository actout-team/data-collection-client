import test from 'node:test';
import assert from 'node:assert/strict';
import { apps } from '../extension/catalog.mjs';
import { catalog } from '../ui/catalog.mjs';
import { getCollector } from '../src/connectors/index.mjs';
import { collectSaas } from '../src/connectors/saas.mjs';

test('Every active app has a collector; only capture apps use the capture fallback', () => {
  for (const app of apps) {
    assert.equal(typeof getCollector(app.id), 'function', app.id);
    assert.equal(getCollector(app.id) === collectSaas, app.mode === 'capture', app.id);
  }
});

test('Pending, disabled and unknown apps cannot dispatch a collector', () => {
  const disabled = catalog.filter(app => app.maturity === 'pending').map(app => app.id);
  for (const id of [...disabled, 'unknown', '__proto__', 'constructor']) {
    assert.throws(() => getCollector(id), /Unknown or disabled connector/);
  }
});
