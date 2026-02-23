// securus selectors — verified 2026-02-22

module.exports = {
  urls: {
    login: 'https://securustech.online/#/login',
    myAccount: 'https://securustech.online/#/my-account',
    inbox: 'https://securustech.online/#/products/emessage/inbox',
    compose: 'https://securustech.online/#/products/emessage/compose',
    messageView: 'https://securustech.online/#/products/emessage/inbox/view', // + ?messageId={}&siteId={}
  },
  login: {
    emailField: 'input[type="email"]',
    passwordField: 'input[type="password"]',
    submitButton: 'button[type="submit"]',
  },
  postLogin: {
    launchInbox: 'a[href*="inbox"]',
    signOut: 'a[href*="login"]',
  },
  inbox: {
    table: 'table',
    headerRow: 'table tr:nth-child(1)',
    dataRows: 'table tr:nth-child(n+2)',
    firstDataRow: 'table tr:nth-child(2)',
    senderCell: 'td:nth-child(1)',
    subjectCell: 'td:nth-child(2)',
    dateCell: 'td:nth-child(3)',
    actionCell: 'td:nth-child(4)',
    paginationNext: 'a:has-text("Next PAGINATION_PAGE")',
  },
  messageView: {
    senderName: 'p.small-12.cell.font-bold.margin-bottom-half',
    recipient: 'p.small-12.cell.margin-bottom-half',
    messageBody: '.message',
    backToInbox: 'a[href*="inbox"]:not([href*="view"])',
  },
  compose: {
    contactDropdown: 'select#select-inmate',
    subjectField: 'input[name="subject"]',
    messageBody: 'textarea#message',
    sendButton: 'button[type="submit"]:has-text("Send")',
    cancelLink: 'a:has-text("Cancel")',
    returnStampCheckbox: 'input[type="checkbox"]',
    // after clicking send, a stamp usage confirmation modal appears
    confirmModal: '.reveal-overlay',
    confirmButton: 'button:has-text("Confirm")',
    confirmCancel: '.reveal-overlay a:has-text("Cancel")',
  },
  contacts: {
    samuelMullikin: '65651103',
    ricardoChalchisevilla: '67887839',
  },
  siteId: '09420',
  charLimit: 20000,
};
