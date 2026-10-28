// First-stage adapters export observed API responses, not a historical scan.
export async function collectSaas({ ask, writer, signal, progress, stats, diagnostic = () => {} }) {
  const snapshot = await ask({ op: 'capture-snapshot' });
  if (!snapshot?.count) throw Error('No eligible read responses captured. Reconnect, then open record lists/details in the selected app tab without refreshing it. This experimental adapter does not scan history automatically.');
  stats.warnings.push('Experimental capture only: pagination, account identity and historical coverage are unverified. Days back is NOT applied. Responses may contain records outside the requested window.');
  if (snapshot.skipped) stats.warnings.push(`${snapshot.skipped} responses were skipped because of size, buffer or parsing limits.`);
  for (let index = 0; index < snapshot.count; index++) {
    signal?.throwIfAborted();
    const record = await ask({ op: 'capture-record', index });
    await writer.append('responses.jsonl', record);
    stats.messages++;
    progress(`Saving captured API responses: ${index + 1}/${snapshot.count}. Historical coverage is unverified.`);
  }
  await writer.append('coverage.jsonl', { mode: 'observed-api-responses', windowApplied: false, complete: false, ...snapshot });
  diagnostic(`Saved ${snapshot.count} API responses, not a count of business records. Reconnect to start a new capture.`);
  await ask({ op: 'capture-clear' });
  return { status: 'partial', scanComplete: false, windowApplied: false, unit: 'api-responses', responses: snapshot.count };
}
