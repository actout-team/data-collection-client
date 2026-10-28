// Candidate read paths are deliberately conservative. Only HubSpot URLs have been observed live.
// HubSpot uses a dedicated website reader. The remaining adapters only capture observed responses.
export const saasApps = [
  { id: 'outlook', name: 'Outlook', home: 'https://outlook.live.com/mail/', hosts: ['outlook.live.com'], scope: '^(/mail)(?:/|$)', mode: 'website-api', maturity: 'beta', statusLabel: 'Beta', cookies: [], detail: 'Outlook.com personal mail: folders, message metadata and HTML body fragments. No MIME originals or attachment files yet.' },
  {
    "id": "hubspot",
    "name": "HubSpot",
    "home": "https://app.hubspot.com/",
    "hosts": [
      "app.hubspot.com",
      "app-eu1.hubspot.com",
      "app-na1.hubspot.com",
      "app-na2.hubspot.com"
    ],
    "scope": "^/[^/]+/(\\d+)(?:/|$)",
    "readPaths": [
      "^/api/inbounddb-objects/v1/crm-objects/[^/]+/batch$",
      "^/api/properties/v4/groups/[^/]+/properties$",
      "^/api/pipelines/v2/pipelines/[^/]+$"
    ],
    "graphql": "/api/graphql/crm",
    "mode": "website-api",
    "cookies": ["csrf.app"],
    "detail": "Contacts, companies and deals created or modified in the selected date window. Current values; full change history is not included."
  },
  {
    "id": "salesforce",
    "name": "Salesforce",
    "home": "https://login.salesforce.com/",
    "hosts": [
      "*.lightning.force.com",
      "*.my.salesforce.com"
    ],
    "readPaths": [
      "^/services/data/v[0-9.]+/(?:query|queryAll|sobjects/[^/]+(?:/[^/]+)?)$"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  },
  {
    "id": "quickbooks",
    "name": "QuickBooks Online",
    "home": "https://qbo.intuit.com/",
    "hosts": [
      "qbo.intuit.com",
      "*.qbo.intuit.com"
    ],
    "readPaths": [
      "^/api/v[0-9]+/(?:company/[^/]+/)?(?:customers|vendors|invoices|bills|payments|accounts|transactions)(?:/[^/]+)?$"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  },
  {
    "id": "xero",
    "name": "Xero",
    "home": "https://go.xero.com/",
    "hosts": [
      "go.xero.com",
      "*.xero.com"
    ],
    "readPaths": [
      "^/(?:api/)?(?:[0-9]+/)?(?:Contacts|Invoices|Bills|Accounts|BankTransactions)(?:/.*)?$"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  },
  {
    "id": "gusto",
    "name": "Gusto",
    "home": "https://app.gusto.com/",
    "hosts": [
      "app.gusto.com"
    ],
    "readPaths": [
      "^/api/(?:v[0-9]+/)?(?:companies/[^/]+/)?(?:employees|contractors|payrolls|departments)(?:/[^/]+)?$"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  },
  {
    "id": "deel",
    "name": "Deel",
    "home": "https://app.deel.com/",
    "hosts": [
      "app.deel.com"
    ],
    "readPaths": [
      "^/api/(?:v[0-9]+/)?(?:contracts|people|invoices|organizations|teams)(?:/[^/]+)?$"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  },
  {
    "id": "notion",
    "name": "Notion",
    "home": "https://www.notion.so/",
    "hosts": [
      "www.notion.so",
      "notion.so",
      "app.notion.com"
    ],
    "readPaths": [],
    "readPosts": [
      "/api/v3/search",
      "/api/v3/loadPageChunk",
      "/api/v3/getRecordValues",
      "/api/v3/queryCollection"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  },
  {
    "id": "asana",
    "name": "Asana",
    "home": "https://app.asana.com/",
    "hosts": [
      "app.asana.com"
    ],
    "readPaths": [
      "^/api/1\\.0/(?:tasks|projects|workspaces|teams|users)(?:/[^/]+){0,2}$"
    ],
    "mode": "capture",
    "cookies": [],
    "detail": "Experimental API capture. Connect, browse lists/details, then save observed responses. No automatic history scan. Days back does not apply."
  }
];
