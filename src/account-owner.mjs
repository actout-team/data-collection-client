// Only authenticated self-profile data may seed exemptions. Never infer the
// owner from message frequency, a domain, a CRM contact, or a capture session.
const strings = values => [...new Set(values.filter(v => typeof v === 'string' && v.trim() && v.length <= 256).map(v => v.trim()))];
export function accountOwner(app, account, profile = {}) {
 if (!account || account.mode === 'capture' || account.authenticated === false) return null;
 let accountKey;
 if (app === 'gmail' && /^[^\s@]+@[^\s@]+$/.test(account.account || '')) accountKey = account.account.toLowerCase();
 else if (app === 'slack' && account.ok && account.team_id && account.user_id) {
  accountKey = account.team_id + ':' + account.user_id;
  if (profile.id !== account.user_id || profile.is_bot) profile = {};
  profile = { ...profile, ...profile.profile };
 } else if (app === 'hubspot' && account.authenticated && account.portalId && account.userId) accountKey = account.portalId + ':' + account.userId;
 else if (account.authenticated === true && typeof account.accountId === 'string' && account.accountId) accountKey = account.accountId;
 else return null;
 const self = app === 'slack' ? profile : account.ownerProfile || {};
 const names = strings([self.name, self.full_name, self.real_name, self.real_name_normalized, self.display_name, self.first_name, self.last_name, [self.first_name, self.last_name].filter(Boolean).join(' ')]);
 const emails = strings([app === 'gmail' ? account.account : null, self.email]).filter(v => /^[^\s@]+@[^\s@]+$/.test(v));
 const phones = strings([self.phone, self.mobile_phone]).filter(v => v.replace(/\D/g, '').length >= 9);
 const addresses = strings([self.street_address, self.postal_address, self.address]).filter(v => /\d/.test(v) && /\p{L}/u.test(v));
 return { app, accountKey, verified: true, source: 'authenticated-self-profile', names, emails, phones, addresses };
}
