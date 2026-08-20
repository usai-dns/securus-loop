// SMS consent copy rendered on the FoxVox signup page.
// ⚠️ BYTE-IDENTICAL to foxvox-a2p/src/copy.mjs (SERVICE_CONSENT / MARKETING_CONSENT).
// The registered 10DLC campaign quotes these strings; carriers compare the live
// page against the registration. `a2p campaign precheck` (foxvox-a2p) fetches
// this page and fails if they drift. Change both places together, then run
// `a2p campaign update` to re-register the copy. Never add 2FA/verification-code
// wording here (undeclared use case → carrier rejection).
export const SERVICE_CONSENT =
  'By checking this box you agree to receive service SMS from FoxVox, such as new-message alerts ' +
  'relayed from your contact, delivery confirmations for your replies, and account and billing ' +
  'updates. You can reply to these texts to send a message back through FoxVox. Message frequency ' +
  'may vary. Message and data rates may apply. Reply HELP for help or STOP to opt out.';

export const MARKETING_CONSENT =
  'By checking this box you agree to receive Marketing SMS from FoxVox, such as product updates and ' +
  'offers. Message frequency varies. Message and data rates may apply. Reply HELP for help. STOP to opt out.';

export const LEGAL = {
  brand: 'FoxVox',
  // Legal entity shown in the policy pages — keep in sync with foxvox-a2p/config/brand.json companyName.
  legalName: 'FoxVox',
  supportEmail: 'support@foxvox.ai',
  privacyPath: '/privacy',
  termsPath: '/terms',
  signupPath: '/signup',
  state: 'Colorado',
};
