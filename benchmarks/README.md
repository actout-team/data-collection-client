# Detection benchmark

Run `npm run validate:protection` after every change to detection, field routing,
owner/public policy, replacement span selection, model assets or thresholds.
It runs syntax checks, unit tests, and both UINT8 and FP32 models on CPU against
frozen public and private baselines. Missing private data is an error. CI and
contributors without private data explicitly use `-- --public-only`.

## Datasets and labels

- `public-controls.json`: 21 synthetic controls inspired by observed export
  structures. These contain no source account data. They cover all selected
  categories, owner/public exceptions, structural metadata, contextual secrets,
  a harmless homonym, JSON, HTML, XML and CSV.
- Private `collect-private-ground-truth-v1`: 31 projections/verbatim fields from
  seven shared files, 13 correlated source groups, 253 labeled regions. This is
  a manually reviewed seed, not an independently certified gold standard.
  The files were already protected. No reverse mapping is used as raw truth.
- Private `collect-private-ground-truth-v2`: preserves all 31 prior cases and adds
  281 manually labeled raw projections/fields from Gmail, Slack and Outlook.
  It has 312 cases, 1,268 regions: 308 sensitive, 670 retain/ignore, and 290
  unresolved review regions. The 978 resolved regions are scored. The bundle
  includes original-output scoring, frozen pre-change baselines, updated
  baselines, source inventory and explicit pending annotation coverage.
- All existing cases are **regression** examples, already inspected during
  development. None is an unseen holdout. New raw data should be grouped by
  account/person/thread before reserving an untouched holdout.

The private clear-error extension adds 1,105 reviewed originals and 19 contextual
controls. It excludes unresolved short-number detections from error labels.
Standalone term projections test neutral usage, not their unavailable source
contexts. Report this targeted suite separately from the original benchmark.

Each case stores exact input, source provenance, UTF-16 half-open offsets and
SHA-256 hashes for the input and annotated text. Offsets refer to serialized
source text, so JSON escapes and HTML entities retain their source boundaries.
Cases are exhaustive: bytes outside annotated sensitive/review regions must
remain untouched. Annotations are authored independently of model outputs and
production field contracts. The evaluator must not infer labels from mappings,
regex matches, model scores, or the current implementation.

| Label | Expected behavior |
| --- | --- |
| `obfuscate` | Cover the complete sensitive value, including weak credentials. |
| `retain-owner` | Keep a contact value in the fixture's explicit owner snapshot. |
| `retain-public` | Keep a verified public entity/contact reference. |
| `ignore` | Keep ordinary content, syntax and structural metadata. |
| `review` | Unresolved semantics or ownership. Exclude from scored positives/negatives. |

Owner exemptions depend on the supplied verified identity snapshot, not guessed
aliases. A password that equals an owner's email remains a secret. Public email
domains have separate literal-preservation invariants. Previously scrambled
company names and unverified recovery aliases are review cases, not negatives.

## Metrics and regression gate

The runner uses production parsers, owner/public policy, `createNeural`, the
shared detector and replacement span selection. It validates that reported
edits reproduce the actual parser output. All cases form one export with shared
mappings, which also tests unwanted propagation into harmless occurrences.

Report these metrics separately:

- Binary detection rates use **one explicitly labeled region per trial**.
  A positive prediction means any production edit overlaps that region.
  `obfuscate` is the positive class. Owner/public/ignore regions are negatives.
  Review regions and unlabeled gaps are excluded from these four rates.
  Report TP, FP, TN and FN alongside TPR = TP/(TP+FN), FPR = FP/(FP+TN),
  TNR = TN/(TN+FP), and FNR = FN/(FN+TP). A zero denominator reports `null`.
  Rates are micro-aggregated from counts, not averaged across cases.
  A partial secret edit is a detection TP but still fails complete coverage.
  Always report complete sensitive coverage with TPR so partial leaks remain
  visible. Over-wide edits and edits to unlabeled gaps still fail the existing
  regression gate. These are pipeline edit decisions, not model-only scores.
- Complete sensitive recall: fully covered sensitive occurrences / labeled
  sensitive occurrences. Partial coverage is a miss. Whitespace alone is not
  required to change. Multiple regions may share one `entity` ID.
- Edit precision: edits wholly within scored sensitive regions / all scored
  edits. An over-wide edit is incorrect even if it covers a secret. Edits wholly
  inside review regions are excluded.
- Retained-value violations: retained/ignored labeled regions touched by an
  edit / all such regions. Regions are not independent trials.
- Per-category counts, public-domain invariants, complete-case results, source
  groups, review exclusions and candidate provenance.

Categories stratify gold-label coverage, not predicted-category classification accuracy.
Recall and precision have different units. Do not compute F1 from these values
or claim overall accuracy. There is no representative prevalence, independent
labeler agreement or production recall estimate. No confidence interval is
reported as if correlated occurrences were independent.

The gate rejects new misses, unwanted edits, invariant failures, and reduced
coverage of already partially missed entities. It checks dataset/model revision,
precision, backend, threshold and selected categories before comparison. Known
baseline failures remain visible. A passing regression gate is not a clean
privacy audit or release certification. CPU FP32 verifies the desktop model's
weights, but does not assert parity with Metal/CUDA execution.

## Commands

```sh
npm run validate:protection
npm run validate:protection -- --public-only
npm run benchmark:protection -- --check
npm run benchmark:protection -- --precision float32 \
  --baseline benchmarks/public-controls.cpu-float32.baseline.json --check
```

Restore the private bundle into `.local/benchmark/private/`, or set
`ACTOUT_PRIVATE_BENCHMARK` to its directory. Set `ACTOUT_TEST_MODEL_CACHE`
to reuse a model cache. Models are checksum-pinned and downloaded on first use.
Private fixtures, baselines and run reports are gitignored. CI only uploads
public-control reports. Reports contain case/region IDs and counts, not source
text or replacement values.

Private extensions named `ground-truth.<suite>.private.json` are included
automatically, using `baseline.<suite>.cpu-uint8.json` and
`baseline.<suite>.cpu-float32.json` in the same directory. Keep the original
dataset and baselines unchanged when adding a suite.

A baseline is created only with explicit `--write-baseline --baseline NEW_PATH`.
It refuses to overwrite an existing file. Never refresh a baseline to make a
regression disappear. Investigate the failure first, record the decision and
review any changed labels independently of predictions. If model/precision or
labels change, establish a separately named baseline rather than compare unlike
runs. Dataset versioning must preserve earlier cases and their source provenance.

Before admitting a new case: verify the source bytes and provenance, read the
whole selected context, label every sensitive span and preservation obligation,
record ownership evidence, isolate ambiguity, check boundaries/duplicates, then
perform a second annotation review. Independent human review and original raw
exports remain necessary before making strong accuracy claims.

## Required deployment and data-intake workflow

Before deploying any detection-flow change, run `npm run validate:protection`
against both the current private corpus and public controls. Report TPR, FPR,
TNR, FNR and their TP/FP/TN/FN counts for each corpus and model precision, plus
complete sensitive coverage, new regressions, dataset ID/hash and source revision.
Keep CPU measurements distinct from native GPU validation. A public-only CI pass
does not replace the private pre-deployment run. Do not report stale results as
validation of a new revision or silently accept a failing regression gate.

Whenever the user shares raw data pulled from any app:

1. Verify whether it is original raw data or already protected. Preserve source
   bytes and provenance privately. Never infer original values from a mapping.
2. Label sensitive values, verified owner/public exemptions and ordinary content
   from their full context, independently of detector output. Include every new
   unique source record in the annotation inventory. Record exact duplicates and
   any exclusions explicitly. Keep uncertain labels as `review`.
3. Audit boundaries, source hashes, completeness and identity evidence in a second
   review pass. Retain source/thread/account grouping so related examples cannot
   leak across splits. Record the reviewer and reasons, not just a confidence score.
4. Append reviewed cases in a new private dataset version, preserving prior
   versions. Deduplicate source records and report additions and exclusions.
   Reserve genuinely new groups as untouched evaluation data before tuning.
5. Run the previous and proposed pipeline on the same expanded version when
   comparing a change. Establish separately named baselines for new dataset/model
   versions. Never relabel failures or overwrite frozen baselines to make a run pass.
6. Save the expanded private bundle and report its version, added label counts,
   unresolved cases and evaluation results. Keep real inputs and identities out
   of Git and public CI. If source context or scale prevents complete annotation,
   report the pending inventory explicitly rather than claiming it was all added.
