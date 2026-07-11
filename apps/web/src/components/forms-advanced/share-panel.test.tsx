// @vitest-environment jsdom
/**
 * SharePanel (F-5 / T-E1) component test。
 *   - published: iframe/script 埋め込みコードを表示 (T-B3 gate 接続)
 *   - 未公開: 「公開すると発行されます」案内 / コードは出さない (N-7)
 *   - Sheets 連携ボタンは owner のみ / クリックで onConnectSheets
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
  return { share: PUBLISHED, isOwner: true, onConnectSheets: vi.fn(), ...overrides }
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

describe('SharePanel — Sheets 連携 (T-E1 / N-9)', () => {
  it('owner はSheets連携ボタンが出て、クリックで onConnectSheets', () => {
    const p = base()
    render(<SharePanel {...p} />)
    fireEvent.click(screen.getByText('Googleスプレッドシートと連携'))
    expect(p.onConnectSheets).toHaveBeenCalled()
  })

  it('非 owner にはSheets連携ボタンが出ない', () => {
    render(<SharePanel {...base({ isOwner: false })} />)
    expect(screen.queryByText('Googleスプレッドシートと連携')).toBeNull()
  })

  it('連携済みはシートリンクと再同期ボタンを出す', () => {
    render(<SharePanel {...base({ share: { ...PUBLISHED, gsheetConnected: true, gsheetUrl: 'https://sheet.example/1' } })} />)
    expect(screen.getByTestId('gsheet-connected')).toBeTruthy()
    expect(screen.getByText('シートを開く')).toBeTruthy()
    expect(screen.getByText('再同期する')).toBeTruthy()
  })

  it('share が null なら何も描画しない', () => {
    const { container } = render(<SharePanel {...base({ share: null })} />)
    expect(container.querySelector('[data-testid="share-panel"]')).toBeNull()
  })
})
