import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
const actions = new Set(['obfuscate', 'retain-owner', 'retain-public', 'ignore', 'review']);
const categories = new Set(['names', 'companies', 'emails', 'phones', 'addresses', 'secrets', 'identifiers']);
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

// Binary detection uses one labeled region per trial and any edit overlap as
// a positive prediction. Complete sensitive coverage is a separate safety gate.
function detectionRates({ TP, FP, TN, FN }) {
  return {
    unit: 'labeled-region', prediction: 'any-edit-overlap', TP, FP, TN, FN,
    TPR: ratio(TP, TP + FN), FPR: ratio(FP, FP + TN),
    TNR: ratio(TN, TN + FP), FNR: ratio(FN, FN + TP)
  };
}

export function validateDataset(data) {
  if (data.version !== 1 || !data.id || !Array.isArray(data.cases) || !data.cases.length) throw Error('Invalid benchmark dataset.');
  const ids = new Set();
  for (const c of data.cases) {
    if (!c.id || ids.has(c.id) || !c.group || !c.cohort || !c.provenance
      || !['json', 'html', 'xml', 'csv', 'text'].includes(c.format)
      || typeof c.input !== 'string' || !Array.isArray(c.regions) || !c.regions.length
      || c.exhaustive !== true) throw Error('Incomplete or duplicate benchmark case.');
    ids.add(c.id);
    if (c.inputSha256 !== hash(c.input)) throw Error(`Input hash mismatch: ${c.id}`);
    const regions = new Set(), entities = new Map();
    let end = 0;
    for (const r of [...c.regions].sort((a, b) => a.start - b.start)) {
      if (!r.id || regions.has(r.id) || !actions.has(r.action) || !r.reason
        || !Number.isInteger(r.start) || !Number.isInteger(r.end)
        || r.start < end || r.end <= r.start || r.end > c.input.length
        || r.textSha256 !== hash(c.input.slice(r.start, r.end))) throw Error(`Invalid annotation: ${c.id}`);
      if (r.action === 'obfuscate') {
        if (!categories.has(r.category)) throw Error(`Missing sensitive category: ${c.id}`);
        const entity = r.entity || r.id;
        if (entities.has(entity) && entities.get(entity) !== r.category) throw Error(`Inconsistent entity category: ${c.id}`);
        entities.set(entity, r.category);
      }
      regions.add(r.id);
      end = r.end;
    }
    const invariants = new Set();
    for (const item of c.literalInvariants || []) {
      if (!item.id || invariants.has(item.id) || typeof item.literal !== 'string'
        || !item.literal || !c.input.includes(item.literal)) throw Error(`Invalid invariant: ${c.id}`);
      invariants.add(item.id);
    }
  }
  return data;
}

export function scoreCase(c, changes, output = c.input) {
  const predicted = new Uint8Array(c.input.length);
  const allowed = new Uint8Array(c.input.length), review = new Uint8Array(c.input.length);
  for (const r of c.regions) {
    if (r.action === 'obfuscate') allowed.fill(1, r.start, r.end);
    if (r.action === 'review') review.fill(1, r.start, r.end);
  }
  for (const edit of changes) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.stop) || edit.start < 0
      || edit.stop <= edit.start || edit.stop > c.input.length) throw Error('Invalid pipeline edit.');
    predicted.fill(1, edit.start, edit.stop);
  }
  const groups = new Map(), retained = [], unknown = [];
  const confusion = { TP: 0, FP: 0, TN: 0, FN: 0 };
  for (const r of c.regions) {
    if (r.action !== 'review') {
      const detected = predicted.subarray(r.start, r.end).some(Boolean);
      const key = r.action === 'obfuscate' ? (detected ? 'TP' : 'FN') : (detected ? 'FP' : 'TN');
      confusion[key]++;
    }
    if (r.action === 'obfuscate') {
      const id = r.entity || r.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(r);
    } else if (r.action === 'review') unknown.push(r.id);
    else retained.push(r);
  }
  const missed = [], partial = [], protectedChanges = [], unexpected = [];
  const byCategory = {}, coverage = {};
  let covered = 0, correctEdits = 0, excludedEdits = 0;
  for (const [id, regions] of groups) {
    const category = regions[0].category;
    byCategory[category] ||= { total: 0, covered: 0 };
    byCategory[category].total++;
    let required = 0, changed = 0;
    for (const r of regions) for (let i = r.start; i < r.end; i++) {
      if (/\s/u.test(c.input[i])) continue;
      required++;
      changed += predicted[i];
    }
    coverage[id] = changed;
    if (changed === required) {
      covered++;
      byCategory[category].covered++;
    } else {
      missed.push(id);
      if (changed) partial.push(id);
    }
  }
  for (const r of retained) {
    if (predicted.subarray(r.start, r.end).some(Boolean)) protectedChanges.push(r.id);
  }
  for (const edit of changes) {
    let relevant = 0, wrong = 0;
    for (let i = edit.start; i < edit.stop; i++) {
      if (review[i]) continue;
      relevant++;
      if (!allowed[i]) wrong++;
    }
    if (!relevant) excludedEdits++;
    else if (wrong) unexpected.push({ start: edit.start, stop: edit.stop });
    else correctEdits++;
  }
  const invariantFailures = (c.literalInvariants || [])
    .filter(item => output.split(item.literal).length !== c.input.split(item.literal).length)
    .map(item => item.id);
  return {
    id: c.id, group: c.group, cohort: c.cohort,
    sensitive: groups.size, covered, retained: retained.length, review: unknown.length,
    correctEdits, excludedEdits, missed, partial, protectedChanges, unexpected,
    byCategory, coverage, invariantFailures, detection: detectionRates(confusion)
  };
}

export function summarize(results) {
  const counts = {
    cases: results.length, groups: new Set(results.map(r => r.group)).size,
    sensitive: 0, covered: 0, retained: 0, protectedChanges: 0, review: 0,
    correctEdits: 0, unexpectedEdits: 0, excludedEdits: 0,
    fullyCorrectCases: 0, invariantFailures: 0
  };
  const byCategory = {};
  const confusion = { TP: 0, FP: 0, TN: 0, FN: 0 };
  for (const r of results) {
    for (const key of Object.keys(confusion)) confusion[key] += r.detection[key];
    for (const key of ['sensitive', 'covered', 'retained', 'review', 'correctEdits', 'excludedEdits']) counts[key] += r[key];
    counts.protectedChanges += r.protectedChanges.length;
    counts.unexpectedEdits += r.unexpected.length;
    counts.invariantFailures += r.invariantFailures.length;
    if (!r.missed.length && !r.unexpected.length && !r.protectedChanges.length && !r.invariantFailures.length) counts.fullyCorrectCases++;
    for (const [category, n] of Object.entries(r.byCategory)) {
      byCategory[category] ||= { total: 0, covered: 0 };
      byCategory[category].total += n.total;
      byCategory[category].covered += n.covered;
    }
  }
  return {
    ...counts, byCategory, detection: detectionRates(confusion),
    completeSensitiveRecall: ratio(counts.covered, counts.sensitive),
    editPrecision: ratio(counts.correctEdits, counts.correctEdits + counts.unexpectedEdits),
    retainedValueViolationRate: ratio(counts.protectedChanges, counts.retained)
  };
}

export function failures(results) {
  return results.flatMap(r => [
    ...r.invariantFailures.map(id => `${r.id}:invariant:${id}`),
    ...r.missed.map(id => `${r.id}:missed:${id}`),
    ...r.protectedChanges.map(id => `${r.id}:retained:${id}`),
    ...r.unexpected.map(edit => `${r.id}:unexpected:${edit.start}:${edit.stop}`)
  ]).sort();
}

export function compareBaseline(report, baseline) {
  if (baseline.version !== 1 || !Array.isArray(baseline.failures) || !baseline.coverage) throw Error('Incomplete regression baseline.');
  if (report.datasetSha256 !== baseline.datasetSha256
    || JSON.stringify(report.signature) !== JSON.stringify(baseline.signature)) throw Error('Baseline dataset/model configuration differs. Do not compare unlike runs.');
  const previous = new Set(baseline.failures);
  const regressions = report.failures.filter(item => !previous.has(item));
  for (const [id, covered] of Object.entries(report.coverage)) {
    if (!(id in baseline.coverage)) throw Error('Baseline coverage is incomplete.');
    if (covered < baseline.coverage[id]) regressions.push(`${id}:reduced-coverage`);
  }
  return regressions;
}
