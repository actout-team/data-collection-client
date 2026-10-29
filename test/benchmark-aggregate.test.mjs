import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReports } from '../scripts/benchmark/aggregate.mjs';
import { scoreCase } from '../scripts/benchmark/score.mjs';

function report(dataset, actions, edits) {
  const input = 'abc';
  const result = scoreCase({ id: 'case', group: 'thread', cohort: 'synthetic', input,
    regions: actions.map((action, i) => ({ id: String(i), start: i, end: i + 1, action, category: 'names' })) }, edits);
  return { dataset, datasetSha256: dataset, signature: { precision: 'float32' }, sourceRevision: 'same', results: [result] };
}
test('Aggregate uses region counts and keeps review exclusions and full coverage distinct', () => {
  const a = report('a', ['obfuscate', 'ignore', 'review'], [{ start: 0, stop: 1 }]);
  const b = report('b', ['obfuscate', 'ignore', 'ignore'], [{ start: 1, stop: 3 }]);
  const result = aggregateReports([a, b]);
  assert.equal(result.scoredRegions, 5);
  assert.equal(result.summary.review, 1);
  assert.equal(result.summary.groups, 2);
  assert.equal(result.metrics.accuracy, 2 / 5);
  assert.equal(result.metrics.precision, 1 / 3);
  assert.equal(result.metrics.recall, 1 / 2);
  assert.equal(result.metrics.F1, 2 / 5);
  assert.equal(result.summary.covered, 1);
  assert.equal(result.summary.sensitive, 2);
});
test('Aggregate rejects duplicates, mixed precisions and stale source revisions', () => {
  const a = report('a', ['ignore'], []), b = report('b', ['ignore'], []);
  assert.throws(() => aggregateReports([]), /No benchmark/);
  assert.throws(() => aggregateReports([a, a]), /duplicate/);
  assert.throws(() => aggregateReports([a, { ...b, datasetSha256: 'a' }]), /duplicate/);
  assert.throws(() => aggregateReports([a, { ...b, signature: { precision: 'uint8' } }]), /configuration/);
  assert.throws(() => aggregateReports([a, { ...b, sourceRevision: 'old' }]), /configuration/);
  assert.equal(aggregateReports([a]).metrics.recall, null);
});
