# Outlook.com connector

Beta supports personal accounts at `outlook.live.com`. Microsoft 365 work accounts, shared mailboxes, complete original bodies and attachment downloads are not supported.

## Protocol

The document-start observer learns the selected tab's authorization, mailbox identity and folder request shape. Credentials stay inside the page. Identity is checked before reads; expiry or account changes require reconnection.

| Operation | Purpose |
| --- | --- |
| `GetMailboxByIdentity` | Verify the selected mailbox and owner profile |
| `FindFolder` | Enumerate folders with explicit pagination |
| `FindItem` | Enumerate message metadata in each accessible mail folder |
| `GetConversationItems` | Enrich already-listed message IDs with available body fragments |

Reads use POST `/owa/service.svc`. Some operations encode JSON in `x-owa-urlpostdata`; conversation reads use a JSON body. Request templates come from observed website traffic, not copied session headers.

## Coverage rules

- Follow `IncludesLastItemInRange`, not a comparison between offset and reported total. Reject stalled or repeated pages.
- Scan `IPF.Note` folders independently of Focused Inbox. Other folder types remain in `folders.jsonl` but are not treated as mail.
- Filter each message by received time, with sent time as fallback. A conversation timestamp cannot date every message.
- Enrich only listed IDs. Missing conversation members retain metadata with a missing-body flag.
- `UniqueBody` can omit quoted content. Mark exports partial; do not describe fragments as MIME originals or complete messages.
- HTML is stored as data, never rendered. Responses are bounded to 8 MB, bodies to 2 MB and cached conversation results to ten entries. Throttling/server errors retry at most four times.

Outputs are `folders.jsonl`, `messages.jsonl`, `coverage.jsonl` and the run report.

## Validation

Prior live checks verified personal-mail identity, a fresh signed-in tab, folder pagination, message metadata and a conversation fragment without marking the message read. These checks do not establish large-mailbox completeness or the installed extension flow.

Automated fixtures cover identity binding, account switches, expiry, bounded responses, pagination, date filtering, throttling, cancellation and missing bodies. Raw traces and account content are not committed.

For live QA, run `npm ci` and `npm start`, reload the extension, pair it, and approve Outlook site access. Select the signed-in Outlook.com tab; the first connection may refresh it to install the observer. Export a small known date window and compare IDs, folders, dates and body coverage with the mailbox. Test large folders and long conversations before expanding the supported scope.
