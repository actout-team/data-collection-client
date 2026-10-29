import { summarize } from './score.mjs';

// Combine counts, never percentages. Each suite remains an independent export.
export function aggregateReports(reports) {
  if (!reports.length) throw Error('No benchmark reports to aggregate.');
  const { signature, sourceRevision } = reports[0];
  const datasets = new Set(), hashes = new Set();
  for (const report of reports) {
    if (JSON.stringify(report.signature) !== JSON.stringify(signature)
        || report.sourceRevision !== sourceRevision) throw Error('Cannot combine different model or source configurations.');
    if (!report.dataset || !report.datasetSha256 || !Array.isArray(report.results)
        || datasets.has(report.dataset) || hashes.has(report.datasetSha256)) throw Error('Missing or duplicate benchmark dataset.');
    datasets.add(report.dataset); hashes.add(report.datasetSha256);
  }
  const summary = summarize(reports.flatMap(report => report.results.map(result => ({
    ...result, group: JSON.stringify([report.dataset, result.group])
  }))));
  const { TP, FP, TN, FN } = summary.detection;
  const ratio = (n, d) => d ? n / d : null;
  return {
    version: 1, createdAt: new Date().toISOString(), sourceRevision, signature,
    suites: reports.map(({ dataset, datasetSha256, summary }) => ({ dataset, datasetSha256, summary })),
    summary, scoredRegions: TP + FP + TN + FN,
    metrics: { accuracy: ratio(TP + TN, TP + FP + TN + FN), precision: ratio(TP, TP + FP),
      recall: ratio(TP, TP + FN), F1: ratio(2 * TP, 2 * TP + FP + FN),
      FPR: ratio(FP, FP + TN), TNR: ratio(TN, TN + FP), FNR: ratio(FN, FN + TP) },
    limitations: ['Micro-aggregate of the included regression suites, not an estimate of production accuracy.',
      'Review regions are excluded. Complete sensitive coverage is reported separately from any-overlap recall.']
  };
}
