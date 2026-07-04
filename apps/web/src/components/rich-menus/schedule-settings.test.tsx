// @vitest-environment jsdom
/**
 * T-C11 / A6 (F2 batch4 G17) — schedule 設定 UI: 期間トグル + 開始/終了 + dark-ship 注記 +
 * 行内確認 (期間削除) + 保存 payload (+09:00)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { updateSchedule } = vi.hoisted(() => ({ updateSchedule: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { richMenuGroups: { updateSchedule: (...a: unknown[]) => updateSchedule(...a) } } }))

import ScheduleSettings, { isScheduled } from './schedule-settings'

beforeEach(() => { updateSchedule.mockResolvedValue({ success: true }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ScheduleSettings (G17 dark-ship)', () => {
  it('always shows the dark-ship 準備中 note', () => {
    render(<ScheduleSettings groupId="g1" accountId="acc-1" scheduleStart={null} scheduleEnd={null} />)
    expect(screen.getByText(/自動切替は準備中/)).toBeTruthy()
    expect(screen.getByText(/運用開始（owner 立会）後に有効/)).toBeTruthy()
  })

  it('enabling shows start/end datetime inputs + 期間外は既定に戻る note', () => {
    render(<ScheduleSettings groupId="g1" accountId="acc-1" scheduleStart={null} scheduleEnd={null} />)
    fireEvent.click(screen.getByLabelText('期間限定にする'))
    expect(screen.getByLabelText('開始日時')).toBeTruthy()
    expect(screen.getByLabelText('終了日時')).toBeTruthy()
    expect(screen.getByText(/期間外は既定メニューに戻ります/)).toBeTruthy()
  })

  it('saves schedule with +09:00 ISO payload', async () => {
    render(<ScheduleSettings groupId="g1" accountId="acc-1" scheduleStart={null} scheduleEnd={null} />)
    fireEvent.click(screen.getByLabelText('期間限定にする'))
    fireEvent.change(screen.getByLabelText('開始日時'), { target: { value: '2026-07-10T00:00' } })
    fireEvent.change(screen.getByLabelText('終了日時'), { target: { value: '2026-07-20T23:59' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledWith('g1', 'acc-1', { scheduleStart: '2026-07-10T00:00:00+09:00', scheduleEnd: '2026-07-20T23:59:00+09:00' }))
  })

  it('deleting a schedule uses inline confirm (no native confirm)', async () => {
    render(<ScheduleSettings groupId="g1" accountId="acc-1" scheduleStart="2026-07-10T00:00:00+09:00" scheduleEnd="2026-07-20T00:00:00+09:00" />)
    fireEvent.click(screen.getByText('期間を削除'))
    expect(screen.getByText(/期間を削除しますか？/)).toBeTruthy()
    fireEvent.click(screen.getByText('はい'))
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledWith('g1', 'acc-1', { scheduleStart: null, scheduleEnd: null }))
  })

  it('isScheduled helper drives the 期間限定 badge', () => {
    expect(isScheduled('2026-07-10T00:00:00+09:00', null)).toBe(true)
    expect(isScheduled(null, null)).toBe(false)
  })
})
