// Open only for choices returned by a successful browser lookup.
// Keep the popup open during authentication or errors, until connected or dismissed.
export function updateAccountDialog(card, status) {
  const dialog = card.querySelector('dialog');
  const message = card.querySelector('.account-message');
  message.textContent = status.status || '';
  message.hidden = !message.textContent;
  const action = status.choices?.length ? JSON.stringify(status.choices) : '';
  if (action && dialog.dataset.action !== action) {
    if (!dialog.open) dialog.showModal();
    card.querySelector('select').focus();
  }
  dialog.dataset.action = action;
  if (status.connected && dialog.dataset.connected !== 'true' && dialog.open) dialog.close();
  dialog.dataset.connected = String(!!status.connected);
}
