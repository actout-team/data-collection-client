import { readFile, writeFile } from 'node:fs/promises';
import { observers } from '../extension/observers.mjs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const manifestURL = new URL('extension/manifest.json', root);
const manifest = JSON.parse(await readFile(manifestURL, 'utf8'));

// Chrome needs classic scripts. These helpers intentionally have no imports.
for (const observer of Object.values(observers)) {
  const source = await readFile(new URL(`extension/${observer.source}`, root), 'utf8');
  const body = source.replace(/^export (?=function )/gm, '');
  if (/^\s*(?:import|export)\s/m.test(body)) throw Error(`${observer.source} is not a standalone browser helper.`);
  const call = `${observer.install}(window, ${JSON.stringify(version)});`;
  const install = observer.errorProperty
    ? `try { ${call} window.${observer.errorProperty} = null; } catch { window.${observer.errorProperty} = '${observer.name} helper could not initialize. Reload the extension and refresh the tab.'; }`
    : call;
  const bundle = `(() => {\n'use strict';\n${body}\n${install}\n})();\n`;
  await writeFile(new URL(`extension/${observer.bundle}`, root), bundle);
}

manifest.version = version;
await writeFile(manifestURL, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built browser helpers and extension manifest for ${version}.`);
