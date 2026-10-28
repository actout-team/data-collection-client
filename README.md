# AgentSim Collect

A local macOS app that exports work data through your signed-in Chrome tabs and creates a separate copy with consistent replacements for sensitive values. Built with Electron and a Chrome extension. No hosted backend or app API keys.

## Setup

Requires macOS, Chrome, Node.js 24+ and npm.

1. Download this repository's source ZIP and extract it, or use a local checkout.
2. Open Terminal in the project folder:

   ```sh
   npm ci
   npm start
   ```

3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the project's `extension/` folder.
4. Open **AgentSim Local Bridge**, click **Pair desktop app**, approve site access, then approve pairing in the desktop app.
5. Sign in to the apps you need. In Collect, select each app, click **Connect**, and choose its browser tab. Keep Chrome open. Refresh Gmail once if its session headers are not ready.
6. Choose **Days back** (default 90) and an output folder, download, then choose protection settings and create the protected copy. Review its report before sharing.

After updating source, run `npm ci` and `npm start`, reload the extension in Chrome, then refresh connected app tabs. The build stamps the extension and all browser helpers with the desktop version. If pairing fails, keep the desktop app open and check that port `4319` is available.

## Connectors

**Automatic** collectors paginate available records. **Beta** has known coverage gaps. **Capture** saves eligible responses while you browse, for up to 15 minutes; it does not scan history or apply Days back. **Planned** and **Paused** entries are disabled and request no site access.

| App | Status | Data or planned scope |
| --- | --- | --- |
| Gmail | Automatic, experimental | Message bodies, recipients, labels and attachment metadata; excludes Spam, Trash, MIME originals and attachment contents. |
| Slack | Automatic | Accessible channels, DMs, replies, users and attachment metadata; subject to workspace permissions and retention. |
| HubSpot | Automatic, experimental | Current contacts, companies and deals created or modified in the window; excludes full change history and attachments. |
| Outlook.com | Beta | Personal-mail folders, message metadata and HTML body fragments; excludes Microsoft 365 work mail, MIME originals and attachment files. |
| Salesforce | Capture | Accounts, contacts, opportunities and activity. |
| QuickBooks Online | Capture | Customers, invoices and transactions. |
| Xero | Capture | Contacts, invoices and accounts. |
| Gusto | Capture | Employees, contractors and payroll. |
| Deel | Capture | People, contracts and invoices. |
| Notion | Capture | Pages and collections. |
| Asana | Capture | Tasks and projects. |
| Microsoft Teams | Planned | Chats, channels and meeting conversations. |
| Google Calendar | Planned | Events, recurrence and attendees. |
| Outlook Calendar | Planned | Events, recurrence and attendees. |
| Zoom | Planned | Meetings and available transcripts. |
| Jira | Planned | Issues, projects and comments. |
| Confluence | Planned | Pages, spaces and comments. |
| Zendesk | Planned | Tickets and conversations. |
| monday.com | Planned | Boards, items and updates. |
| ClickUp | Planned | Spaces, lists and tasks. |
| Airtable | Planned | Bases, tables and records. |
| Trello | Planned | Boards, cards and checklists. |
| Google Chat | Planned | Spaces and messages. |
| Microsoft Planner | Planned | Plans, buckets and tasks. |
| Microsoft To Do | Planned | Lists, tasks and completion states. |
| Calendly | Planned | Meetings, invitees and event types. |
| Google Drive | Paused | File metadata and current content; implementation and tests retained, runtime access disabled. |

OneDrive, SharePoint, Dropbox and Box are also deferred. Capture adapters do not verify account identity or complete coverage. Website APIs can change; a completed traversal does not prove a complete account export. See [connector development](docs/integrations.md) and [Outlook protocol notes](docs/outlook.md).

## How it works

- **Collection:** the paired extension makes allowlisted reads in the selected tab. Cookies and provider session tokens stay in Chrome. Automatic collectors verify the account, paginate, deduplicate and apply an inclusive start and exclusive end date window.
- **Output:** each run writes a new directory with JSONL records and `report.json`; connector coverage reports record omissions. Source checkouts default to `downloads/`; packaged apps use `~/Downloads/AgentSim Collect/`. Cancellation keeps partial results.
- **Protection:** local detection scans supported text values, builds shared replacements, then writes a new directory. Original exports stay unchanged. A separate mapping contains original values and must stay private. Review skipped content and the protection report; substitution is reversible, not encryption or guaranteed anonymization.

Protection downloads checksum-pinned models on first use and then runs locally. Verified owner contact details and known public entities are preserved. Attachment contents, filenames, structural metadata and unsupported files can remain unchanged. See [protection settings and limits](docs/protection.md).

## Development

```sh
npm run check                         # JavaScript syntax
npm test                              # Build helpers, then run regression tests
npm run validate:protection -- --public-only  # Tests and CPU model baselines
npm run dist                          # macOS arm64 and x64 DMGs
```

Model validation downloads assets unless cached. Detection changes also require the private regression corpus; see [benchmark instructions](benchmarks/README.md). Live account tests and signed/notarized installers require separate validation.

| Path | Responsibility |
| --- | --- |
| `src/main.mjs`, `src/bridge.mjs` | Desktop lifecycle, IPC and paired loopback bridge |
| `src/connectors/` | Collector registry, pagination and provider-specific formats |
| `extension/` | Browser readers, session observers and connection policy |
| `src/protection/` | Parsing, detection, replacement and local model processes |
| `ui/` | Desktop flow and connector catalog |
| `test/`, `benchmarks/` | Synthetic fixtures, regressions and frozen model baselines |

MIT licensed. Icon attribution is in [ui/icons/NOTICE.txt](ui/icons/NOTICE.txt). Downloaded models and runtimes retain their upstream licenses, listed in [protection notes](docs/protection.md).
