// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import InternalSheetsSetupPanel, {
  type InternalSheetsSetupPanelProps,
} from './internal-sheets-setup-panel'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const CANONICAL_APPS_SCRIPT = readFileSync(
  join(ROOT, 'docs/google-sheets-friend-ledger-onedit.gs'),
  'utf8',
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPanel() {
  const loadAppsScript = vi.fn().mockResolvedValue(CANONICAL_APPS_SCRIPT)
  const panelProps = {
    serviceAccountEmail: null,
    fields: [],
    onInspect: vi.fn(),
    onSave: vi.fn(),
    loadAppsScript,
    onRequestWebhookSecret: vi.fn(),
  } as InternalSheetsSetupPanelProps & {
    loadAppsScript: () => Promise<string>
    onRequestWebhookSecret: () => Promise<string>
  }
  render(<InternalSheetsSetupPanel {...panelProps} />)
  return { loadAppsScript }
}

describe('InternalSheetsSetupPanel instant setup contract', () => {
  test('shows five plain-language steps and saved-only values in a dialog', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '即時反映の設定を見る' }))
    const dialog = await screen.findByRole('dialog', { name: '即時反映の設定' })

    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5)
    for (const propertyName of [
      'SHEETS_WEBHOOK_URL',
      'SHEETS_WEBHOOK_SECRET',
      'SHEETS_CONNECTION_ID',
      'SHEETS_SPREADSHEET_ID',
      'SHEETS_SHEET_NAME',
    ]) {
      expect(within(dialog).getByText(propertyName)).toBeTruthy()
    }
    expect(within(dialog).getAllByText('接続保存後に表示')).toHaveLength(5)
  })

  test('copies the exact canonical Apps Script document', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { loadAppsScript } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '即時反映の設定を見る' }))
    const dialog = await screen.findByRole('dialog', { name: '即時反映の設定' })
    const copy = within(dialog).getByRole('button', { name: 'Apps Script 全文をコピー' })
    await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copy)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CANONICAL_APPS_SCRIPT))
    expect(loadAppsScript).toHaveBeenCalledTimes(1)
  })
})
