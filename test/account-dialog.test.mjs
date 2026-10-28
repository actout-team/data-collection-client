import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAccountDialog } from '../ui/account-dialog.mjs';

function fixture() {
  let opened = 0, focused;
  const dialog = { dataset: {}, open: false, showModal() { this.open = true; opened++; }, close() { this.open = false; } };
  const message = { focus() { focused = 'message'; } };
  const select = { focus() { focused = 'select'; } };
  const card = { querySelector: selector => ({ dialog, '.account-message': message, select })[selector] };
  return { card, dialog, message, get opened() { return opened; }, get focused() { return focused; } };
}
test('Tab choice opens immediately once, even for one tab, and can be dismissed', () => {
  const f = fixture(), status = { status: 'Choose a tab', choices: [{ title: 'Gmail', url: 'https://mail.google.com/mail/u/0/' }] };
  updateAccountDialog(f.card, status);
  assert.equal(f.opened, 1); assert.equal(f.focused, 'select');
  f.dialog.close(); updateAccountDialog(f.card, structuredClone(status));
  assert.equal(f.opened, 1); assert.equal(f.dialog.open, false);
  updateAccountDialog(f.card, { status: 'Waiting for Chrome…' });
  updateAccountDialog(f.card, status);
  assert.equal(f.opened, 2);
});
test('Failures never open a popup; an existing popup stays open through authentication and errors', () => {
  const f = fixture();
  updateAccountDialog(f.card, { status: 'Loading tab' }); assert.equal(f.opened, 0);
  updateAccountDialog(f.card, { status: 'Reload the extension' }); assert.equal(f.opened, 0);
  updateAccountDialog(f.card, { choices: [{ title: 'Gmail', url: 'https://mail.google.com/mail/u/0/' }] });
  updateAccountDialog(f.card, { status: 'Checking session' }); assert.equal(f.dialog.open, true);
  updateAccountDialog(f.card, { status: 'Sign in in Chrome' });
  assert.equal(f.dialog.open, true); assert.equal(f.message.textContent, 'Sign in in Chrome');
  assert.equal(f.opened, 1);
  updateAccountDialog(f.card, { status: 'Connected', connected: true });
  assert.equal(f.dialog.open, false);
  f.dialog.showModal(); // Manually reviewing an already-connected account.
  updateAccountDialog(f.card, { status: 'Connected', connected: true });
  assert.equal(f.dialog.open, true);
});
