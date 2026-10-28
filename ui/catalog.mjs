import { apps } from '../extension/catalog.mjs';

const details = {
  slack: ['Communication', 'Messages, threads and attachment metadata.'],
  outlook: ['Email', 'Outlook.com messages and folders. Body fragments only; attachments not downloaded.'],
  gmail: ['Email', 'Email bodies and metadata. Attachment contents are not downloaded.'],
  hubspot: ['CRM', 'Contacts, companies and deals created or modified in the selected date window.'],
  salesforce: ['CRM', 'CRM records. Browse to capture.'],
  quickbooks: ['Accounting', 'Customers, invoices and transactions. Browse to capture.'],
  xero: ['Accounting', 'Contacts, invoices and accounts. Browse to capture.'],
  gusto: ['Payroll', 'Employees, contractors and payroll. Browse to capture.'],
  deel: ['People', 'People, contracts and invoices. Browse to capture.'],
  notion: ['Knowledge', 'Pages and collections. Browse to capture.'],
  asana: ['Projects', 'Tasks and projects. Browse to capture.']
};
// Pending entries are display-only: no bridge routes or site permissions exist.
const pending = [
  ['googledrive', 'Google Drive', 'Files', 'Development paused. File-sharing integrations are deferred.', 'In development'],
  ['googlecalendar', 'Google Calendar', 'Calendar', 'Events, attendees, recurring meetings and calendar metadata.'],
  ['outlookcalendar', 'Outlook Calendar', 'Calendar', 'Events, attendees, recurring meetings and calendar metadata.'],
  ['jira', 'Jira', 'Projects', 'Issues, projects, comments and work history.'],
  ['confluence', 'Confluence', 'Knowledge', 'Pages, spaces and comments.'],
  ['zendesk', 'Zendesk', 'Support', 'Tickets, conversations, organizations and agents.'],
  ['clickup', 'ClickUp', 'Projects', 'Tasks, lists, spaces and comments.'],
  ['airtable', 'Airtable', 'Databases', 'Bases, tables, records and field schemas.'],
  ['googlechat', 'Google Chat', 'Communication', 'Spaces, messages and conversation threads.'],
  ['planner', 'Microsoft Planner', 'Projects', 'Plans, buckets, tasks and assignments.'],
  ['todo', 'Microsoft To Do', 'Tasks', 'Task lists, tasks, due dates and completion states.'],
  ['calendly', 'Calendly', 'Scheduling', 'Scheduled meetings, invitees and event types.'],
  ['teams', 'Microsoft Teams', 'Communication', 'Chats, channels and meeting conversations.'],
  ['zoom', 'Zoom', 'Meetings', 'Meetings, recordings and available transcripts.'],
  ['monday', 'monday.com', 'Projects', 'Boards, items and project updates.'],
  ['trello', 'Trello', 'Projects', 'Boards, cards, checklists and comments.']
].map(([id, name, category, detail, statusLabel]) => ({ id, name, category, detail, statusLabel, maturity: 'pending' }));
export const catalog = [
  ...apps.map(app => ({ ...app, category: details[app.id]?.[0] || 'Work apps', detail: details[app.id]?.[1] || app.detail, maturity: app.maturity || (['slack', 'gmail'].includes(app.id) ? 'tested' : 'experimental') })),
  ...pending
];
export const steps = ['Browser', 'Apps', 'Download', 'Protection', 'Export'];
export const PAGE_SIZE = 4;
export function appPage(items, query = '', page = 1, size = PAGE_SIZE) {
  const rank = { tested: 0, beta: 1, experimental: 2, pending: 3 };
  const needle = query.trim().toLowerCase();
  const matches = items.filter(a => `${a.name} ${a.category} ${a.detail} ${a.maturity}`.toLowerCase().includes(needle)).sort((a, b) =>
    (rank[a.maturity] ?? 2) - (rank[b.maturity] ?? 2) || (a.id === 'slack' ? -1 : b.id === 'slack' ? 1 : a.name.localeCompare(b.name)));
  const pages = Math.max(1, Math.ceil(matches.length / size));
  const current = Math.max(1, Math.min(page, pages));
  return { items: matches.slice((current - 1) * size, current * size), total: matches.length, page: current, pages };
}
export function canReview(state) {
  const result = state.downloadResult;
  return !state.busy && !!result && (['finished', 'partial'].includes(result.status) || (result.status === 'cancelled' && result.saved > 0));
}
export function stepBlock(step, state, selected, items = catalog) {
  if (state.busy) return 'Busy';
  if (step === 0 && !state.browserConnected) return 'Connect browser.';
  if (step === 1) {
    if (!state.browserConnected) return 'Reconnect browser.';
    if (!selected.size) return 'Select at least one app.';
    if ([...selected].some(id => !items.some(a => a.id === id && a.maturity !== 'pending') || !state.apps?.[id]?.connected)) return 'Connect selected apps.';
  }
  if (step === 2 && !canReview(state)) return 'Download first.';
  return '';
}
