// In-memory diagnostics only. Never pass request bodies, cookies or mail content here.
export function safeLogText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bxox[a-z]-[A-Za-z0-9-]+/gi, '[redacted Slack token]')
    .replace(/\b(cookie|authorization)\s*[:=][^\n]*/gi, '$1: [redacted]')
    .replace(/\b(token|password|secret|sessionid|SID|__Secure-\w+)\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 400);
}
export function createLog(limit = 80) {
  const entries = [];
  return {
    entries,
    add(level, source, message) {
      const entry = { time: new Date().toISOString(), level, source, message: safeLogText(message) };
      const previous = entries.at(-1);
      if (previous && previous.level === level && previous.source === source && previous.message === entry.message) {
        previous.time = entry.time; previous.count = (previous.count || 1) + 1;
      } else entries.push(entry);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    text() { return entries.map(e => `${e.time} [${e.level.toUpperCase()}] ${e.source}: ${e.message}${e.count ? ` (×${e.count})` : ''}`).join('\n'); }
  };
}
