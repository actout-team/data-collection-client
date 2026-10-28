import { getApp } from '../../extension/catalog.mjs';
import { collectGmail } from './gmail.mjs';
import { collectSlack } from './slack.mjs';
import { collectHubspot } from './hubspot.mjs';
import { collectOutlook } from './outlook.mjs';
import { collectSaas } from './saas.mjs';

const collectors = new Map([
  ['gmail', collectGmail],
  ['slack', collectSlack],
  ['hubspot', collectHubspot],
  ['outlook', collectOutlook]
]);

export function getCollector(id) {
  const app = getApp(id);
  if (!app) throw Error(`Unknown or disabled connector: ${id}`);
  const collect = collectors.get(id) || (app.mode === 'capture' ? collectSaas : null);
  if (!collect) throw Error(`No collector registered for ${id}`);
  return collect;
}
