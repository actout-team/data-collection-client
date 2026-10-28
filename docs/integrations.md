# Connector development

The [README](../README.md#connectors) lists every connector and its current state. Keep that table aligned with `extension/catalog.mjs`, `extension/saas-catalog.mjs` and `ui/catalog.mjs`.

## Boundaries

| Layer | Contract |
| --- | --- |
| Catalog | App ID, allowed HTTPS hosts, account scope, connection mode and UI metadata. Pending entries exist only in the UI. |
| Browser reader | Account-bound, allowlisted reads. Returns serializable data or a bounded error. Never returns cookies, authorization headers or session tokens. |
| Desktop collector | Receives `ask`, `window`, `writer`, `signal`, `stats`, `progress`, `meter` and `diagnostic`; returns status and coverage. |
| Writer | Appends provider records to named JSONL files. A run gets a new private directory. |
| Protection | Parses exported values independently of the connector. Known structural fields remain intact. |

The loopback bridge accepts only the paired extension origin and secret. Browser functions passed to `chrome.scripting.executeScript` must be self-contained: Chrome serializes them without module imports or closures. HubSpot uses the isolated world; session observers run in the page's main world.

## Add an automatic connector

1. Establish the provider's actual read protocol and identity response. Use in-app or research browsers first; use a personal browser only with explicit authorization. Keep raw traces and real records out of Git.
2. Add sanitized structural fixtures under `test/fixtures/`. Never infer a private endpoint or pagination contract from another app.
3. Register hosts and account scope in the extension catalog. Add only the required optional permissions to `extension/manifest.json`.
4. Implement a browser reader and its allowlisted route in `extension/background.mjs`. If it needs a document-start helper, add its source, installer and registration metadata to `extension/observers.mjs`; the build supplies its version.
5. Implement the collector in `src/connectors/` and register it in `src/connectors/index.mjs`. Check cancellation, account changes, date boundaries, malformed pages, repeated cursors, duplicates and rate limits. Preserve saved records on failure.
6. Add the UI description, licensed icon and README row. Report incomplete traversal as partial; never turn an unknown schema or missing continuation into empty success.
7. Run `npm run check` and `npm test`, then compare a consenting account's export with an independent reference. Test the actual extension-to-desktop flow before claiming live coverage.

Capture adapters use the shared reader in `extension/saas.mjs` and collector in `src/connectors/saas.mjs`. Their path rules describe observed responses, not an authenticated history API. Do not promote a capture adapter to Automatic without an account-bound enumerator and coverage tests.

## Deferred work

Outlook.com supports personal mail only. See [outlook.md](outlook.md) for its protocol and remaining validation gates.

Google Drive is disabled. Its reader, download transport, collector and synthetic tests are retained for future work. Resume only after confirming file-download routes, optional permissions, each native format, cancellation, account changes and shared-drive coverage through the actual extension. Metadata pagination alone does not establish file-export coverage.

Drive protocol notes:

- `GET https://drivefrontend-pa.clients6.google.com/v1/account` supplies account and self-profile metadata. Session authorization stays in the selected tab.
- `POST /v1/items:list` returns items and a continuation token. Modified-after and modified-before predicates are rechecked locally against `[start,end)`.
- Native document exports need a separate file transport; page-origin fetch may be blocked by CORS. Reject login/confirmation HTML rather than saving it as a document.
- Current versions only. Deleted files, revision history, shortcut targets and files over 128 MB are outside the retained collector's scope.

OneDrive, SharePoint, Dropbox and Box remain deferred. Existing attachment links do not imply attachment-content collection.
