// Estimates are deliberately revisable. Only a completed scan reaches 100%.
export function createProgress(ids, window, history = {}, now = Date.now) {
  const start = Date.parse(window.start), end = Date.parse(window.end), span = end - start;
  const rows = Object.fromEntries(ids.map(id => [id, {
    id, status: 'queued', records: 0, units: null, done: 0, started: null,
    unitStarted: null, samples: 0, oldest: Infinity, newest: -Infinity
  }]));
  function begin(id) {
    Object.assign(rows[id], { status: 'running', started: now(), unitStarted: now() });
  }
  function update(id, event) {
    const row = rows[id];
    if (event.units !== undefined) row.units = event.units;
    if (Number.isFinite(event.timestamp) && event.timestamp >= start && event.timestamp < end) {
      row.records++; row.samples++;
      row.oldest = Math.min(row.oldest, event.timestamp);
      row.newest = Math.max(row.newest, event.timestamp);
    }
    if (event.unitDone) {
      row.done++; row.unitStarted = now(); row.samples = 0;
      row.oldest = Infinity; row.newest = -Infinity;
    }
  }
  function finish(id, status, completed) {
    Object.assign(rows[id], { status, completed, ended: now() });
    if (completed) history[id] = { secondsPerDay: Math.max(1, (now() - rows[id].started) / 1000) / (span / 86400000) };
  }
  function snapshot() {
    const apps = Object.values(rows).map(row => {
      const elapsed = row.started === null ? 0 : Math.max(0, ((row.ended ?? now()) - row.started) / 1000);
      const prior = history[row.id]?.secondsPerDay;
      let remaining = Number.isFinite(prior) && prior > 0 ? Math.max(1, prior * span / 86400000 - elapsed) : null;
      let fraction = remaining === null ? 0 : elapsed / (elapsed + remaining);
      const sampleSpan = row.newest - row.oldest;
      const unitElapsed = row.unitStarted === null ? 0 : Math.max(0, (now() - row.unitStarted) / 1000);
      // Timestamp spacing estimates record density, while elapsed time includes
      // API calls, attachments, disk writes, retries, and older-thread scans.
      let currentRemaining = null, currentFraction = 0;
      if (row.samples >= 5 && sampleSpan >= 60000) {
        const estimatedRecords = Math.max(row.samples + 1, (row.samples - 1) * span / sampleSpan);
        currentFraction = Math.min(0.95, row.samples / estimatedRecords);
        currentRemaining = (estimatedRecords - row.samples) * Math.max(0.001, unitElapsed) / row.samples;
      }
      if (row.units !== null && row.units > 0) {
        fraction = Math.min(0.99, (row.done + currentFraction) / row.units);
        if (row.done > 0) {
          const average = Math.max(0.1, (elapsed - unitElapsed) / row.done);
          remaining = Math.max(0, row.units - row.done - 1) * average + (currentRemaining ?? Math.max(1, average - unitElapsed));
        } else if (currentRemaining !== null) remaining = currentRemaining + Math.max(0, row.units - 1) * (unitElapsed + currentRemaining);
      } else if (currentRemaining !== null) {
        remaining = currentRemaining; fraction = currentFraction;
      }
      if (row.status === 'queued') fraction = 0;
      if (row.completed) { fraction = 1; remaining = 0; }
      const running = row.status === 'running';
      return { id: row.id, status: row.status, records: row.records, elapsed,
        percent: row.completed ? 100 : Math.min(99, Math.round(fraction * 100)),
        eta: running || row.status === 'queued' || row.completed ? remaining : null,
        secondsPerRecord: row.records ? elapsed / row.records : null,
        completedUnits: row.done, totalUnits: row.units, completed: !!row.completed };
    });
    const complete = apps.every(a => a.completed);
    const known = apps.every(a => a.eta !== null);
    const weights = apps.map(a => known ? Math.max(1, a.elapsed + a.eta) : 1);
    const percent = apps.reduce((sum, a, i) => sum + a.percent * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
    return { apps, active: apps.some(a => ['running', 'queued'].includes(a.status)), complete,
      // Weight by estimated app duration when known, otherwise by app.
      percent: complete ? 100 : Math.min(99, Math.round(percent)),
      eta: known ? apps.reduce((sum, a) => sum + a.eta, 0) : null,
      history };
  }
  return { begin, update, finish, snapshot, history };
}
