// securus selectors — ESM version for cloudflare worker
// verified 2026-02-22

export const urls = {
  login: 'https://securustech.online/#/login',
  myAccount: 'https://securustech.online/#/my-account',
  inbox: 'https://securustech.online/#/products/emessage/inbox',
  compose: 'https://securustech.online/#/products/emessage/compose',
  sent: 'https://securustech.online/#/products/emessage/sent',
  messageView: 'https://securustech.online/#/products/emessage/inbox/view',
};

export const login = {
  emailField: 'input[type="email"]',
  passwordField: 'input[type="password"]',
  submitButton: 'button[type="submit"]',
};

export const postLogin = {
  launchInbox: 'a[href*="inbox"]',
  signOut: 'a[href*="login"]',
};

export const inbox = {
  table: 'table',
  dataRows: 'table tr:nth-child(n+2)',
  senderCell: 'td:nth-child(1)',
  subjectCell: 'td:nth-child(2)',
  dateCell: 'td:nth-child(3)',
};

export const messageView = {
  senderName: 'p.small-12.cell.font-bold.margin-bottom-half',
  messageBody: '.message',
  backToInbox: 'a[href*="inbox"]:not([href*="view"])',
};

export const compose = {
  contactDropdown: 'select#select-inmate',
  subjectField: 'input[name="subject"]',
  messageBody: 'textarea#message',
  sendButton: 'button[type="submit"]',
  confirmModal: '.reveal-overlay',
  confirmButton: '.reveal-overlay button',
};

export const contacts = {
  samuelMullikin: '65651103',
  ricardoChalchisevilla: '67887839',
};

export const siteId = '09420';
export const charLimit = 20000;
