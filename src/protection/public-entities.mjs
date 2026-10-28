import { domainToASCII } from 'node:url';
import { publicMailDomains } from './value-shapes.mjs';

// Reviewed public brands/products/institutions, not a list inferred from private
// exports or from model confidence. Keep short/common aliases out (e.g. X, MS).
// Registry updates ship with the app. Custom registries can extend this policy
// through createPublicEntityPolicy; no network lookup or model approval is used.
export const PUBLIC_ENTITY_VERSION = '2026-10-16.1';
const registry = [
  ['Google|Google Workspace|Google Cloud|Google Drive|Google Docs|Google Sheets|Google Calendar|Google Meet|Gmail|YouTube|Android|Chrome', 'google.com google.co.il googlemail.com gmail.com googleapis.com gstatic.com youtube.com youtu.be android.com chromium.org'],
  ['Apple|Apple Inc.|iCloud|iPhone|iPad|MacBook|macOS|App Store', 'apple.com icloud.com me.com mac.com'],
  ['Microsoft|Microsoft Corporation|Microsoft Teams|Microsoft Azure|Microsoft 365|Office 365|Outlook|OneDrive|SharePoint|Windows', 'microsoft.com outlook.com hotmail.com live.com office.com office365.com microsoftonline.com sharepoint.com onedrive.com azure.com'],
  ['HubSpot', 'hubspot.com hubspotusercontent.com hubspotemail.net hsforms.com'],
  ['Slack|Salesforce|Tableau|MuleSoft', 'slack.com slack-edge.com salesforce.com force.com tableau.com mulesoft.com'],
  ['Amazon|Amazon Web Services|AWS', 'amazon.com amazon.co.uk amazon.de amazon.co.jp amazonaws.com aws.amazon.com'],
  ['Meta|Facebook|Instagram|WhatsApp', 'meta.com facebook.com fb.com instagram.com whatsapp.com'],
  ['LinkedIn|GitHub|GitHub Copilot', 'linkedin.com github.com githubusercontent.com githubassets.com'],
  ['OpenAI|ChatGPT|DALL-E', 'openai.com chatgpt.com'],
  ['Anthropic|Claude AI', 'anthropic.com claude.ai'],
  ['Zoom|Zoom Video Communications', 'zoom.us zoom.com'],
  ['Notion|Notion AI', 'notion.so notion.com notion.site'],
  ['Asana', 'asana.com'], ['Atlassian|Jira|Confluence|Trello|Bitbucket', 'atlassian.com atlassian.net jira.com trello.com bitbucket.org'],
  ['Intuit|QuickBooks|TurboTax|Mailchimp', 'intuit.com quickbooks.com turbotax.com mailchimp.com'],
  ['Xero', 'xero.com'], ['Gusto', 'gusto.com'], ['Deel', 'deel.com'],
  ['monday.com', 'monday.com'], ['Dropbox', 'dropbox.com dropboxusercontent.com'],
  ['Adobe|Adobe Acrobat|Photoshop|Illustrator', 'adobe.com acrobat.com'], ['Figma', 'figma.com'],
  ['Canva', 'canva.com'], ['Miro', 'miro.com'], ['Airtable', 'airtable.com'],
  ['DocuSign', 'docusign.com docusign.net'], ['Zendesk', 'zendesk.com'], ['Intercom', 'intercom.com intercom.io'],
  ['Stripe', 'stripe.com'], ['PayPal', 'paypal.com'], ['Shopify', 'shopify.com myshopify.com'],
  ['Wix', 'wix.com wixsite.com'], ['Squarespace', 'squarespace.com'], ['WordPress', 'wordpress.com wordpress.org'],
  ['Cloudflare', 'cloudflare.com'], ['DigitalOcean', 'digitalocean.com'], ['Vercel', 'vercel.com'], ['Netlify', 'netlify.com'],
  ['Oracle', 'oracle.com'], ['SAP', 'sap.com'], ['IBM', 'ibm.com'], ['Cisco', 'cisco.com'],
  ['Intel', 'intel.com'], ['NVIDIA', 'nvidia.com'], ['AMD', 'amd.com'], ['Samsung', 'samsung.com'], ['Sony', 'sony.com'],
  ['Netflix', 'netflix.com'], ['Spotify', 'spotify.com'], ['TikTok', 'tiktok.com'], ['Reddit', 'reddit.com'],
  ['X Corp.|Twitter', 'x.com twitter.com t.co'], ['Pinterest', 'pinterest.com'], ['Snapchat', 'snapchat.com'],
  ['Telegram', 'telegram.org t.me'], ['Signal Messenger', 'signal.org'], ['Discord', 'discord.com discord.gg'],
  ['Yahoo', 'yahoo.com yahoo.co.uk yahoo.co.jp'], ['Proton|Proton Mail', 'proton.me protonmail.com pm.me'],
  ['Mozilla|Firefox', 'mozilla.org firefox.com'], ['GitLab', 'gitlab.com'], ['Docker', 'docker.com docker.io'],
  ['Kubernetes', 'kubernetes.io'], ['Ubuntu|Canonical', 'ubuntu.com canonical.com'],
  ['Python Software Foundation', 'python.org'], ['Hugging Face', 'huggingface.co'],
  ['Tesla|SpaceX|Starlink', 'tesla.com spacex.com starlink.com'], ['Uber|Uber Eats', 'uber.com ubereats.com'], ['Airbnb', 'airbnb.com'],
  ['Booking.com', 'booking.com'], ['Expedia', 'expedia.com'], ['eBay', 'ebay.com'], ['Etsy', 'etsy.com'],
  ['Alibaba|AliExpress', 'alibaba.com aliexpress.com'], ['Walmart', 'walmart.com'], ['IKEA', 'ikea.com'],
  ['Nike', 'nike.com'], ['Adidas', 'adidas.com'], ['Coca-Cola', 'coca-cola.com'], ['PepsiCo', 'pepsico.com'],
  ["McDonald’s|McDonald's", 'mcdonalds.com'], ['Starbucks', 'starbucks.com'],
  ['Visa', 'visa.com'], ['Mastercard', 'mastercard.com'], ['American Express', 'americanexpress.com'],
  ['Toyota', 'toyota.com'], ['BMW', 'bmw.com'], ['Mercedes-Benz', 'mercedes-benz.com'], ['Volkswagen', 'volkswagen.com'],
  ['Reuters', 'reuters.com'], ['Associated Press', 'apnews.com'], ['BBC', 'bbc.com bbc.co.uk'], ['CNN', 'cnn.com'],
  ['The New York Times', 'nytimes.com'], ['The Guardian', 'theguardian.com'],
  ['Wikipedia|Wikimedia Foundation', 'wikipedia.org wikimedia.org'],
  ['NASA', 'nasa.gov'], ['United Nations|UNICEF|UNESCO|World Health Organization', 'un.org unicef.org unesco.org who.int'],
  ['World Bank|International Monetary Fund', 'worldbank.org imf.org'],
  ['MIT|Massachusetts Institute of Technology|Harvard University|Stanford University', 'mit.edu harvard.edu stanford.edu'],
  ['גוגל|יוטיוב', ''], ['אפל', ''], ['מיקרוסופט', ''], ['פייסבוק|אינסטגרם|וואטסאפ', ''],
];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = value => value.normalize('NFKC').toLowerCase();
const legal = '(?:[ ,]+(?:Inc\\.?|Incorporated|LLC|Ltd\\.?|Limited|Corp\\.?|Corporation|PLC|GmbH))?';
const hostPattern = /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?![\p{L}\p{N}_-])/gu;
export function createPublicEntityPolicy({ names = [], domains = [] } = {}) {
  if (!Array.isArray(names) || !Array.isArray(domains) || names.length > 10000 || domains.length > 10000 || [...names, ...domains].some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw Error('Invalid public-entity registry.');
  const aliases = [...new Set([...registry.flatMap(([aliases]) => aliases.split('|')), ...names])].sort((a, b) => b.length - a.length);
  const exact = new Set(aliases.map(normalize));
  const hosts = new Set([...registry.flatMap(([, value]) => value.split(' ').filter(Boolean)), ...publicMailDomains, ...domains].map(value => domainToASCII(value.toLowerCase().replace(/\.$/, ''))));
  if (hosts.has('') || [...hosts].some(host => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))) throw Error('Invalid public domain in registry.');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_@.-])(?:${aliases.map(escape).join('|')})${legal}(?![\\p{L}\\p{N}_@-])`, 'giu');
  function isDomain(value) {
    if (typeof value !== 'string' || value.length > 254 || /[\s/@:]/.test(value)) return false;
    const host = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
    if (!host) return false;
    // Match complete labels, never google.com.evil.test or notgoogle.com.
    return hosts.has(host) || host.split('.').some((_, i, labels) => i > 0 && hosts.has(labels.slice(i).join('.')));
  }
  function spans(text) {
    const domains = [...text.matchAll(hostPattern)];
    const found = domains.filter(m => isDomain(m[0])).map(m => ({ start: m.index, end: m.index + m[0].length, kind: 'domain' }));
    let domainIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // Do not infer a public company from a private/spoofed domain label.
      while (domainIndex < domains.length && domains[domainIndex].index + domains[domainIndex][0].length <= match.index) domainIndex++;
      if (domainIndex < domains.length && domains[domainIndex].index < match.index + match[0].length) continue;
      found.push({ start: match.index, end: match.index + match[0].length, kind: 'name' });
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = -1;
    return found.filter(s => { if (s.start < end) return false; end = s.end; return true; });
  }
  const entityCache = new Map();
  function isEntity(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (text.length > 200) return false;
    const key = normalize(text);
    if (entityCache.has(key)) return entityCache.get(key);
    const result = exact.has(key) || isDomain(text) || spans(text).some(s => s.start === 0 && s.end === text.length);
    if (entityCache.size >= 4096) entityCache.delete(entityCache.keys().next().value);
    entityCache.set(key, result); return result;
  }
  return { spans, isDomain, isEntity, info: { version: PUBLIC_ENTITY_VERSION, aliases: aliases.length, domains: hosts.size, customNames: names.length, customDomains: domains.length, network: false, modelMayExempt: false } };
}
export const publicEntities = createPublicEntityPolicy();
