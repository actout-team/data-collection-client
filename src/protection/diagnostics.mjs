import { safeLogText } from '../log.mjs';
export function errorDetail(error) {
  const causes = []; const seen = new Set();
  for (let item = error; item && causes.length < 3 && !seen.has(item); item = item.cause) {
    seen.add(item);
    causes.push(`${item.code || item.name || 'Error'}: ${item.message || String(item)}`);
  }
  return safeLogText(causes.join(' → ').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]'));
}
export function modelError(error, phase) {
  const detail = errorDetail(error);
  const hint = /MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(detail) ? ' Run npm install in the app folder, then restart.' : /No supported adapters|Failed to get a WebGPU adapter/.test(detail) ? ' No GPU adapter is available to the model process. Check GPU access and drivers, then restart.' : '';
  return `${phase}: ${detail}${hint}`;
}
