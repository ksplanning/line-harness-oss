/**
 * Browser-loadable URL for the copyable Apps Script.
 *
 * The `.gs` document is deliberately the only source body. `new URL` lets the
 * web bundler publish that exact file as a static asset without a second
 * TypeScript string copy that could drift.
 */
export const GOOGLE_SHEETS_FRIEND_LEDGER_APPS_SCRIPT_URL = new URL(
  '../../../docs/google-sheets-friend-ledger-onedit.gs',
  import.meta.url,
).href
