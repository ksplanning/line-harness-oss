// @vitest-environment jsdom
/**
 * U6 (broadcast-combo-messages Batch 2) — 一覧の配信メタ表示。
 *  - combo(messages.length>1) は「N通のメッセージ」を表示 (誤認防止・codex LOW #10)
 *  - single (messages なし / len1) は従来どおり種別ラベルのみ
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import BroadcastMessageMeta, { comboMessageCount } from './broadcast-message-meta'
import type { ApiBroadcast } from '@/lib/api'

afterEach(() => cleanup())

const base = { messageType: 'text' as ApiBroadcast['messageType'] }

describe('U6 broadcast list meta: combo バッジ', () => {
  it('messages.length=2 → 「2通のメッセージ」を表示', () => {
    render(<BroadcastMessageMeta broadcast={{ ...base, messages: [
      { type: 'image', content: '{}' }, { type: 'text', content: 'hi' },
    ] }} />)
    expect(screen.getByText('2通のメッセージ')).toBeTruthy()
  })

  it('single (messages 未指定) → 種別ラベルのみ・通数バッジ無し', () => {
    render(<BroadcastMessageMeta broadcast={{ ...base }} />)
    expect(screen.getByText('テキスト')).toBeTruthy()
    expect(screen.queryByText(/通のメッセージ/)).toBeNull()
  })

  it('single (messages len1) は combo とみなさない', () => {
    render(<BroadcastMessageMeta broadcast={{ ...base, messages: [{ type: 'text', content: 'hi' }] }} />)
    expect(screen.queryByText(/通のメッセージ/)).toBeNull()
  })

  it('comboMessageCount は len>1 のとき通数、それ以外 0', () => {
    expect(comboMessageCount({ messages: [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }] })).toBe(2)
    expect(comboMessageCount({ messages: [{ type: 'text', content: 'a' }] })).toBe(0)
    expect(comboMessageCount({ messages: null })).toBe(0)
    expect(comboMessageCount({})).toBe(0)
  })
})
