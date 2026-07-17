// @vitest-environment jsdom
/**
 * b1-field-polish (T-E1) — preview に星色反映 + 動画枠拡大。
 *   rating プレビュー星に form-level design.ratingStarColor を反映 (未設定=既定黄)。
 *   video プレビュー枠を videoHeight (未設定=既定) 反映の再生可能アスペクトで描画。既存 case 不変・正直な忠実度注記。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import FormPreview from './form-preview'
import { DEFAULT_RATING_STAR_COLOR, DEFAULT_VIDEO_HEIGHT } from '@line-crm/shared'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
const ratingField: HarnessField = { id: 'r1', type: 'rating', label: '満足度', required: false, position: 0, config: {} }
const videoField = (config: Record<string, unknown>): HarnessField => ({ id: 'v1', type: 'video', label: '説明', required: false, position: 0, config: config as HarnessField['config'] })

describe('b1-field-polish T-E1 — preview 星色反映', () => {
  it('design.ratingStarColor を星プレビューの色に反映', () => {
    render(<FormPreview title="t" fields={[ratingField]} design={{ ratingStarColor: '#3B82F6' }} />)
    expect(screen.getByTestId('preview-rating').style.color).toBe(rgb('#3B82F6'))
  })
  it('ratingStarColor 未設定は既定黄で描画 (honest default)', () => {
    render(<FormPreview title="t" fields={[ratingField]} />)
    expect(screen.getByTestId('preview-rating').style.color).toBe(rgb(DEFAULT_RATING_STAR_COLOR))
  })
})

describe('b1-field-polish T-E1 — preview 動画枠拡大', () => {
  it('videoHeight を動画プレビュー枠の高さに反映', () => {
    render(<FormPreview title="t" fields={[videoField({ videoUrl: 'https://youtu.be/x', videoHeight: '400px' })]} />)
    const frame = screen.getByTestId('preview-video-frame')
    expect(frame.style.height).toBe('400px')
  })
  it('videoHeight 未設定は既定高さで描画 (薄帯でなく再生可能サイズ)', () => {
    render(<FormPreview title="t" fields={[videoField({ videoUrl: 'https://youtu.be/x' })]} />)
    const frame = screen.getByTestId('preview-video-frame')
    expect(frame.style.height).toBe(DEFAULT_VIDEO_HEIGHT)
  })
  it('URL 未設定の動画は従来どおり未設定枠 (video-frame は出さない)', () => {
    render(<FormPreview title="t" fields={[videoField({ videoUrl: '' })]} />)
    expect(screen.queryByTestId('preview-video-frame')).toBeNull()
    expect(screen.getByTestId('preview-video-note')).toBeTruthy() // 忠実度注記は不変
  })
})

describe('b1-field-polish T-E1 — 既存 case 不変', () => {
  it('rating/video を含まないフォームは従来どおり描画 (fidelity note 等)', () => {
    render(<FormPreview title="t" fields={[{ id: 't1', type: 'text', label: '名前', required: true, position: 0, config: {} }]} />)
    expect(screen.getByTestId('preview-fidelity-note')).toBeTruthy()
    expect(screen.queryByTestId('preview-video-frame')).toBeNull()
  })
})
