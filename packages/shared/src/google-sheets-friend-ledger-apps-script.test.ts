import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { GOOGLE_SHEETS_FRIEND_LEDGER_APPS_SCRIPT_URL } from './google-sheets-friend-ledger-apps-script'

describe('Google Sheets friend-ledger Apps Script asset', () => {
  test('points at the copyable docs script as its single source of truth', () => {
    const sourceUrl = new URL(GOOGLE_SHEETS_FRIEND_LEDGER_APPS_SCRIPT_URL)
    expect(sourceUrl.pathname).toMatch(/\/docs\/google-sheets-friend-ledger-onedit\.gs$/)

    const source = readFileSync(sourceUrl, 'utf8')
    expect(source).toContain('function installFriendLedgerSync()')
    expect(source).toContain('function friendLedgerOnEdit(event)')
    expect(source).toContain("'SHEETS_WEBHOOK_SECRET'")
  })
})
