// @vitest-environment jsdom
/**
 * treasure-b1-palette (T-G1) — プレビュー自前描画: rating(sub_type 別) / signature(署名パッド) / video(埋め込み枠 + 忠実度注記)。
 * hosted は Formaloo の実ウィジェット / oembed iframe で描画される = プレビューは近似 (正直な忠実度注記)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => cleanup())

function fld(type: HarnessField['type'], config: Record<string, unknown> = {}, over: Partial<HarnessField> = {}): HarnessField {
  return { id: `${type}1`, type, label: type, required: false, position: 0, config: config as HarnessField['config'], ...over }
}

describe('B1 preview — rating 自前描画 (T-G1)', () => {
  it('star(既定) は星ウィジェットを描画', () => {
    render(<FormPreview title="t" fields={[fld('rating', {}, { label: '満足度' })]} />)
    const w = screen.getByTestId('preview-rating')
    expect(w).toBeTruthy()
    expect(w.textContent).toContain('★')
  })
  it('nps は 0〜10 のボタン列を描画', () => {
    render(<FormPreview title="t" fields={[fld('rating', { ratingSubType: 'nps' }, { label: '推奨度' })]} />)
    const w = screen.getByTestId('preview-rating')
    expect(within(w).getByText('0')).toBeTruthy()
    expect(within(w).getByText('10')).toBeTruthy()
  })
  it('like_dislike は 良い/悪い を描画', () => {
    render(<FormPreview title="t" fields={[fld('rating', { ratingSubType: 'like_dislike' }, { label: '評価' })]} />)
    const w = screen.getByTestId('preview-rating')
    expect(w.textContent).toContain('👍')
    expect(w.textContent).toContain('👎')
  })
})

describe('B1 preview — signature 自前描画 (T-G1)', () => {
  it('署名パッド placeholder を描画 (公開フォームで手書き の注記)', () => {
    render(<FormPreview title="t" fields={[fld('signature', {}, { label: '同意サイン' })]} />)
    const pad = screen.getByTestId('preview-signature')
    expect(pad).toBeTruthy()
    expect(pad.textContent).toMatch(/署名|手書き/)
  })
})

describe('B1 preview — video 自前描画 + 忠実度注記 (T-G1)', () => {
  it('URL ありは埋め込み枠 + 忠実度注記を描画', () => {
    render(<FormPreview title="t" fields={[fld('video', { videoUrl: 'https://youtu.be/x' }, { label: '説明動画' })]} />)
    const v = screen.getByTestId('preview-video')
    expect(v).toBeTruthy()
    expect(v.textContent).toMatch(/公開フォーム|埋め込み|再生/)
  })
  it('URL 未設定は「動画URL未設定」を描画', () => {
    render(<FormPreview title="t" fields={[fld('video', { videoUrl: '' }, { label: '説明動画' })]} />)
    const v = screen.getByTestId('preview-video')
    expect(v.textContent).toContain('動画URL未設定')
  })
})
