import { modelError } from './diagnostics.mjs';
const send = message => process.send(message);
const log = (level, message) => send({ log: { level, message } });
process.on('disconnect', () => process.exit());
process.once('message', async ({ init }) => {
  let model;
  try {
    log('info', `Worker started: Node ${process.versions.node}, Electron ${process.versions.electron || 'none'}, ${process.platform}/${process.arch}.`);
    const { loadModel } = await import('./model-runtime.mjs');
    model = await loadModel(init.directory, init.categories, { preference: init.preference, modelFile: init.modelFile, profileRoot: init.profileRoot, log });
    const started = performance.now();
    await model.detect('Alice Reed lives at 45 Maple Road, Boston, MA 02110. Email alice.reed@example.com, phone +1 202 555 0198, password OrangeMoon99!, SSN 123-45-6789.');
    const acceleration = await model.verify();
    log('info', `Model inference self-check passed (${model.backend}, ${Math.round(performance.now() - started)} ms).`);
    send({ ready: true, backend: model.backend, acceleration });
  } catch (error) { if (model) await model.close().catch(() => {}); send({ error: modelError(error, 'Model startup') }); return; }
  process.on('message', async ({ text, close }) => {
    try {
      if (close) { await model.close(); send({ closed: true }); return; }
      const spans = await model.detect(text);
      send({ spans, backend: model.backend });
    } catch (error) { send({ error: modelError(error, 'Model inference') }); }
  });
});
