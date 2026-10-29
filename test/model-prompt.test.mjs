import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmCompanies, needsCompanyConfirmation, CONTRAST_LABELS } from '../src/protection/model-prompt.mjs';
import { decode } from '../src/protection/model-runtime.mjs';

test('Company confirmation rejects unconfirmed spans without changing other categories or boundaries', () => {
  const text = 'Morrowglass Labs; ordinary phrase; Noor; 123; AB';
  const span = (value, category) => ({ start: text.indexOf(value), end: text.indexOf(value) + value.length, category });
  const company = span('Morrowglass Labs', 'companies'), ordinary = span('ordinary phrase', 'companies');
  const others = [span('Noor', 'names'), span('123', 'secrets'), span('123', 'companies'), span('AB', 'companies')];
  const confirmation = [{ ...company, category: 'names' }, { ...ordinary, category: 'background' }];
  assert.deepEqual(confirmCompanies([company, ordinary, ...others], confirmation, text), [company, ...others]);
  assert.deepEqual(confirmCompanies([company], [{ start: company.end, end: company.end + 2, category: 'companies' }], text), []);
  assert.equal(needsCompanyConfirmation({ start: 0, end: 11, category: 'companies' }, 'נרקיס מערכות'), true);
});

test('Background labels compete in the verifier but never create primary detections', () => {
  const tokens = [{ start: 0, end: 7 }], labels = ['company name', 'technical term'];
  const logits = { dims: [1, 1, 2, 3], data: Float32Array.from([1, 1, 1, 2, 2, 2]) };
  const result = decode(logits, tokens, labels, 0, 'concept', { 'company name': 'companies', ...CONTRAST_LABELS });
  assert.equal(result[0].category, 'background');
  assert.deepEqual(confirmCompanies([{ start: 0, end: 7, category: 'companies' }], result, 'concept'), []);
  assert.equal(CONTRAST_LABELS['public organization'], 'companies');
});
