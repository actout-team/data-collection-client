// Semantic classes, not examples or term exceptions. Public-organization output
// confirms an identity; it never grants a public-entity exemption.
export const CONTRAST_LABELS = Object.freeze({
  'ordinary word': 'background', 'technical term': 'background',
  'public organization': 'companies', markup: 'background'
});

export function needsCompanyConfirmation(span, text) {
  // Keep short, ambiguous labels and numeric decisions under the existing policy.
  return span.category === 'companies' && span.end - span.start >= 3
    && /\p{L}/u.test(text.slice(span.start, span.end));
}

export function confirmCompanies(primary, confirmation, text) {
  return primary.filter(span => !needsCompanyConfirmation(span, text)
    || confirmation.some(other => ['names', 'companies'].includes(other.category)
      && other.start < span.end && other.end > span.start));
}
