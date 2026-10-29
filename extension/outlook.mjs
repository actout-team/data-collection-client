// Serialized into the selected MAIN world. Never return session headers.
export async function outlookRead(op, args, expected) {
  try {
    const api = window.__actoutOutlook;
    if (!api) throw Object.assign(Error('Refresh Outlook to activate the connector, then reconnect.'), { code: 'LOGIN_REQUIRED' });
    return { ok: true, value: await api.read(op, args, expected) };
  } catch (error) {
    return { ok: false, code: error.code || 'OUTLOOK_FAILED', error: error.code ? error.message : 'Outlook read failed. Refresh the selected tab and reconnect.' };
  }
}
