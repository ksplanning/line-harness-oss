// @vitest-environment jsdom
/**
 * SharePanel (F-5 / T-E1) component test。
 *   - published: iframe/script 埋め込みコードを表示 (T-B3 gate 接続)
 *   - 未公開: 「公開すると発行されます」案内 / コードは出さない (N-7)
 *   - Sheets 再同期ボタンは owner のみ / クリックで onConnectSheets
 *   - 連携済みはシートリンク表示
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import SharePanel, { type SharePanelProps } from './share-panel'
import type { ShareInfo } from '@/lib/formaloo-advanced-api'

afterEach(() => cleanup())

const PUBLISHED: ShareInfo = {
  published: true,
  publicUrl: 'https://formaloo.me/f/abc',
  lineDistUrl: 'https://api.example.com/fo/xyz',
  iframeCode: '<iframe src="https://formaloo.me/f/abc"></iframe>',
  scriptCode: '<script>/*embed*/</script>',
  gsheetConnected: false,
  gsheetUrl: null,
}

function base(overrides: Partial<SharePanelProps> = {}): SharePanelProps {
  return { share: PUBLISHED, renderBackend: 'formaloo', isOwner: true, onConnectSheets: vi.fn(), ...overrides }
}

describe('SharePanel — 配布 URL 2 本 (T-A5 / 順方向)', () => {
  it('published は LINE 配信用 URL と HP 公開用 URL を別々に表示する', () => {
    render(<SharePanel {...base()} />)
    // LINE 配信用 = /fo/:id (追跡 + prefill 経路)
    expect(screen.getByTestId('line-dist-url').textContent).toContain('https://api.example.com/fo/xyz')
    // HP 公開用 = 生 Formaloo URL (prefill 無し)
    expect(screen.getByTestId('hp-public-url').textContent).toContain('https://formaloo.me/f/abc')
    // hidden field 設定の案内が出る (owner/infra 手順 / R-F5)
    expect(screen.getByTestId('line-dist-note').textContent).toContain('fr_id')
  })

  it('未公開は LINE 配信用 URL を出さない (未公開は配布不可)', () => {
    render(<SharePanel {...base({ share: { ...PUBLISHED, published: false, lineDistUrl: null, publicUrl: null, iframeCode: null, scriptCode: null } })} />)
    expect(screen.queryByTestId('line-dist-url')).toBeNull()
  })

  it('自前配信は公開用と LINE 配信用の URL を示し、fr_id の扱いを日常語で説明する', () => {
    const internalShare: ShareInfo = {
      ...PUBLISHED,
      publicUrl: 'https://api.example.com/f/internal-form',
      lineDistUrl: 'https://api.example.com/fo/internal-form',
      iframeCode: '<iframe src="https://formaloo.example.test/legacy"></iframe>',
      scriptCode: '<script src="https://formaloo.example.test/legacy.js"></script>',
    }
    render(<SharePanel {...base({ renderBackend: 'internal', share: internalShare })} />)

    expect(screen.getByTestId('line-dist-url').textContent).toContain('/fo/internal-form')
    expect(screen.getByTestId('hp-public-url').textContent).toContain('/f/internal-form')
    const note = screen.getByTestId('line-dist-note').textContent ?? ''
    expect(note).toContain('fr_id')
    expect(note).toContain('自前フォーム')
    expect(note).toContain('埋め込み・直接リンク')
    expect(screen.queryByTestId('iframe-code')).toBeNull()
    expect(screen.queryByTestId('script-code')).toBeNull()
  })

  it('自前配信は Formaloo alias 指示と Google Sheets / W4 の操作を一切表示しない', () => {
    const internalShare: ShareInfo = {
      ...PUBLISHED,
      publicUrl: 'https://api.example.com/f/internal-form',
      lineDistUrl: 'https://api.example.com/fo/internal-form',
      iframeCode: null,
      scriptCode: null,
    }
    const { container } = render(<SharePanel {...base({ renderBackend: 'internal', share: internalShare })} />)

    expect(container.textContent).not.toContain('Formaloo')
    expect(container.textContent).not.toContain('alias')
    expect(container.textContent).not.toContain('Google Sheets')
    expect(screen.queryByTestId('iframe-code')).toBeNull()
    expect(screen.queryByTestId('script-code')).toBeNull()
    expect(screen.queryByTestId('gsheet-sync-description')).toBeNull()
    expect(screen.queryByText('再同期する')).toBeNull()
  })

  it('自前配信の下書きは、埋め込みコードではなく 2 本の公開 URL がまだ使えないと案内する', () => {
    render(<SharePanel {...base({
      renderBackend: 'internal',
      share: { ...PUBLISHED, published: false, lineDistUrl: null, publicUrl: null, iframeCode: null, scriptCode: null },
    })} />)

    const note = screen.getByTestId('unpublished-note').textContent ?? ''
    expect(note).toContain('公開用 URL')
    expect(note).toContain('LINE 配信用 URL')
    expect(note).not.toContain('埋め込みコード')
  })
})

describe('SharePanel — 埋め込みコード (T-E1)', () => {
  it('published は iframe/script コードを出す', () => {
    render(<SharePanel {...base()} />)
    expect((screen.getByTestId('iframe-code') as HTMLTextAreaElement).value).toContain('<iframe')
    expect((screen.getByTestId('script-code') as HTMLTextAreaElement).value).toContain('<script>')
  })

  it('未公開はコードを出さず案内を出す (N-7)', () => {
    render(<SharePanel {...base({ share: { ...PUBLISHED, published: false, iframeCode: null, scriptCode: null, publicUrl: null } })} />)
    expect(screen.queryByTestId('iframe-code')).toBeNull()
    expect(screen.getByTestId('unpublished-note')).toBeTruthy()
  })
})

describe('SharePanel — Sheets 再同期 (T-E1 / N-9 / admin-ui-cleanup D-2)', () => {
  it('未接続でも実態どおり再同期ボタンを出し、クリックで onConnectSheets', () => {
    const p = base()
    render(<SharePanel {...p} />)

    expect(screen.getByTestId('gsheet-sync-description').textContent).toContain('回答を再同期')
    expect(screen.queryByText('Googleスプレッドシートと連携')).toBeNull()
    fireEvent.click(screen.getByText('再同期する'))
    expect(p.onConnectSheets).toHaveBeenCalled()
  })

  it('未接続 note は Formaloo ダッシュボードでの初回接続手順を正直に案内する', () => {
    render(<SharePanel {...base()} />)

    const note = screen.getByTestId('gsheet-unconnected-note').textContent ?? ''
    expect(note).toContain('初回接続')
    expect(note).toContain('Formaloo ダッシュボード')
    expect(note).toContain('Google Sheets 連携')
  })

  it('非 owner にはSheets再同期ボタンが出ない', () => {
    render(<SharePanel {...base({ isOwner: false })} />)
    expect(screen.queryByText('再同期する')).toBeNull()
  })

  it('連携済みはシートリンクと再同期ボタンを出す', () => {
    render(<SharePanel {...base({ share: { ...PUBLISHED, gsheetConnected: true, gsheetUrl: 'https://sheet.example/1' } })} />)
    expect(screen.getByTestId('gsheet-connected')).toBeTruthy()
    expect(screen.getByText('シートを開く')).toBeTruthy()
    expect(screen.getByText('再同期する')).toBeTruthy()
  })

  it('再同期中は処理中の文言を出し、ボタンを無効化する', () => {
    render(<SharePanel {...base({ connecting: true })} />)

    const button = screen.getByText('再同期中…') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('share が null なら何も描画しない', () => {
    const { container } = render(<SharePanel {...base({ share: null })} />)
    expect(container.querySelector('[data-testid="share-panel"]')).toBeNull()
  })
})

describe('SharePanel — シート入口の配置', () => {
  it('自前配信の共有欄には旧シート入口を残さない', () => {
    const { container } = render(<SharePanel {...base({ renderBackend: 'internal' })} />)

    expect(screen.queryByTestId('gsheet-sync-description')).toBeNull()
    expect(screen.queryByTestId('internal-sheet-unconnected')).toBeNull()
    expect(screen.queryByTestId('internal-sheet-connected')).toBeNull()
    expect(container.textContent).not.toContain('設定 → シート連携')
  })

  it('Formaloo は既存 Sheets subtree の文言と操作をそのまま維持する', () => {
    const p = base({ renderBackend: 'formaloo' })
    render(<SharePanel {...p} />)

    expect(screen.getByTestId('gsheet-sync-description').textContent?.trim()).toBe(
      'Formaloo で接続済みの Google スプレッドシートへ回答を再同期します。この画面から初回接続はできません。',
    )
    expect(screen.getByTestId('gsheet-unconnected-note').textContent?.trim()).toBe(
      '未接続です。初回接続は Formaloo ダッシュボードで対象フォームを開き、「Google Sheets 連携」から設定してください。',
    )
    fireEvent.click(screen.getByText('再同期する'))
    expect(p.onConnectSheets).toHaveBeenCalledTimes(1)
  })
})
