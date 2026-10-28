export const protectionOptions = [
  { id: 'names', label: 'Names', detail: 'People in messages and profiles' },
  { id: 'companies', label: 'Companies', detail: 'Private companies; recognized public brands stay unchanged' },
  { id: 'emails', label: 'Email addresses', detail: 'Sensitive local parts; recognized public domains stay unchanged' },
  { id: 'phones', label: 'Phone numbers', detail: 'Phone fields and common formats' },
  { id: 'addresses', label: 'Addresses', detail: 'Addresses in messages and profiles' },
  { id: 'secrets', label: 'Passwords & tokens', detail: 'Credentials, API keys and private keys' },
  { id: 'identifiers', label: 'Personal & payment IDs', detail: 'Tax, passport, bank and card fields' }
];
export function protectionMatches(state, selected, { namePreference = 'auto', generationMode = 'pools' } = {}) {
  const result = state.protectionResult;
  return (result?.generation?.namePreference || 'auto') === namePreference && (result?.generation?.mode || 'pools') === generationMode && !state.busy && !!result && ['finished', 'partial'].includes(result.status) && result.source === state.downloadResult?.output && [...selected].sort().join(',') === [...result.categories].sort().join(',');
}
