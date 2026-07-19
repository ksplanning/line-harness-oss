// @vitest-environment jsdom
/**
 * treasure-b2-form-settings (D-1/D-2/D-3) — builder の「運用制御」設定。
 *
 * 契約:
 *   - UI は reCAPTCHA / 下書き保存 / 先着 N 名 / 受付開始 / 受付終了 / UTM 流入元記録の 6 項目。
 *   - 初期未操作 save は operationsSettings absent（既存フォームへ false/null を勝手に送らない）。
 *   - 操作した field だけを partial payload で送り、解除は false/null を明示する。
 *   - datetime-local は JST 壁時計として `:00+09:00` の ISO8601 に変換する。
 *   - initialOperationsSettings と Formaloo reimport の値を UI へ復元する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: 'テスト',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

function recaptcha(): HTMLInputElement {
  return screen.getByLabelText(/reCAPTCHA/i) as HTMLInputElement
}

function draftAnswers(): HTMLInputElement {
  return screen.getByLabelText(/下書き保存/) as HTMLInputElement
}

function maxSubmitCount(): HTMLInputElement {
  return screen.getByLabelText(/先着N名|先着 N 名|送信上限/) as HTMLInputElement
}

function submitStartTime(): HTMLInputElement {
  return screen.getByLabelText(/受付開始/) as HTMLInputElement
}

function submitEndTime(): HTMLInputElement {
  return screen.getByLabelText(/受付終了/) as HTMLInputElement
}

function utmCapture(): HTMLInputElement {
  return screen.getByLabelText(/UTM.*流入元|流入元.*UTM/i) as HTMLInputElement
}

describe('FormBuilder — 運用制御 settings (treasure B2)', () => {
  it('「運用制御」に 6 項目を表示し、既定は OFF / 未設定', () => {
    render(<FormBuilder {...base()} />)

    expect(screen.getByText('運用制御')).toBeTruthy()
    expect(recaptcha().checked).toBe(false)
    expect(draftAnswers().checked).toBe(false)
    expect(maxSubmitCount().value).toBe('')
    expect(submitStartTime().value).toBe('')
    expect(submitEndTime().value).toBe('')
    expect(utmCapture().checked).toBe(false)
  })

  it('初期未操作 save は operationsSettings を載せない (absent = 既存フォーム不干渉)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as Record<string, unknown>
    expect('operationsSettings' in saved).toBe(false)
  })

  it('触った field だけを partial operationsSettings に載せる', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.change(maxSubmitCount(), { target: { value: '100' } })
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({ maxSubmitCount: 100 })
  })

  it('boolean toggle も触った key だけを送る (reCAPTCHA ON)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(recaptcha())
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({ hasRecaptcha: true })
  })

  it('datetime-local は JST の +09:00 ISO8601 へ変換し、開始・終了だけを送る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.change(submitStartTime(), { target: { value: '2026-07-20T09:30' } })
    fireEvent.change(submitEndTime(), { target: { value: '2026-08-20T18:45' } })
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({
      submitStartTime: '2026-07-20T09:30:00+09:00',
      submitEndTime: '2026-08-20T18:45:00+09:00',
    })
  })

  it('initialOperationsSettings の全値を復元する', () => {
    render(<FormBuilder {...base({
      initialOperationsSettings: {
        hasRecaptcha: true,
        acceptDraftAnswers: true,
        maxSubmitCount: 100,
        submitStartTime: '2026-07-20T09:00:00+09:00',
        submitEndTime: '2026-08-20T18:30:00+09:00',
        utmTracking: true,
      },
    })} />)

    expect(recaptcha().checked).toBe(true)
    expect(draftAnswers().checked).toBe(true)
    expect(maxSubmitCount().value).toBe('100')
    expect(submitStartTime().value).toBe('2026-07-20T09:00')
    expect(submitEndTime().value).toBe('2026-08-20T18:30')
    expect(utmCapture().checked).toBe(true)
  })

  it('設定済み値の clear は boolean=false / nullable field=null を明示する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      onSave,
      initialOperationsSettings: {
        hasRecaptcha: true,
        acceptDraftAnswers: true,
        maxSubmitCount: 100,
        submitStartTime: '2026-07-20T09:00:00+09:00',
        submitEndTime: '2026-08-20T18:30:00+09:00',
        utmTracking: true,
      },
    })} />)

    fireEvent.click(recaptcha())
    fireEvent.click(draftAnswers())
    fireEvent.change(maxSubmitCount(), { target: { value: '' } })
    fireEvent.change(submitStartTime(), { target: { value: '' } })
    fireEvent.change(submitEndTime(), { target: { value: '' } })
    fireEvent.click(utmCapture())
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({
      hasRecaptcha: false,
      acceptDraftAnswers: false,
      maxSubmitCount: null,
      submitStartTime: null,
      submitEndTime: null,
      utmTracking: false,
    })
  })

  it('Formaloo 再取り込みで remote 5項目を復元し、local-only UTM は保持・次の save で永続する', async () => {
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({
      ok: true,
      fields: [],
      logic: [],
      operationsSettings: {
        hasRecaptcha: true,
        acceptDraftAnswers: true,
        maxSubmitCount: 25,
        submitStartTime: '2026-07-25T10:00:00+09:00',
        submitEndTime: '2026-07-31T17:00:00+09:00',
      },
    })
    render(<FormBuilder {...base({
      onSave,
      onReimport,
      // UTM は Formaloo FormUpdateRequest の値ではない。reimport で remote 5 項目を置換しても local toggle は維持する。
      initialOperationsSettings: { utmTracking: true },
    })} />)

    // 未保存のローカル変更は reimport で remote 値へ置き換える。
    fireEvent.change(maxSubmitCount(), { target: { value: '999' } })
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    })

    await waitFor(() => expect(maxSubmitCount().value).toBe('25'))
    expect(recaptcha().checked).toBe(true)
    expect(draftAnswers().checked).toBe(true)
    expect(submitStartTime().value).toBe('2026-07-25T10:00')
    expect(submitEndTime().value).toBe('2026-07-31T17:00')
    expect(utmCapture().checked).toBe(true)

    fireEvent.click(screen.getByText('保存'))
    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({
      hasRecaptcha: true,
      acceptDraftAnswers: true,
      maxSubmitCount: 25,
      submitStartTime: '2026-07-25T10:00:00+09:00',
      submitEndTime: '2026-07-31T17:00:00+09:00',
    })
  })

  it('Formaloo 日時の秒・小数秒を再取り込みから次の save まで保つ', async () => {
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({
      ok: true,
      fields: [],
      logic: [],
      operationsSettings: {
        submitStartTime: '2026-07-20T09:00:30.123456+09:00',
        submitEndTime: '2026-08-20T18:30:45+09:00',
      },
    })
    render(<FormBuilder {...base({ onSave, onReimport })} />)

    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    })

    // datetime-local が表示できるのはミリ秒までだが、保存 payload は remote の6桁を保持する。
    expect(submitStartTime().value).toBe('2026-07-20T09:00:30.123')
    expect(submitEndTime().value).toBe('2026-08-20T18:30:45.000')
    fireEvent.click(screen.getByText('保存'))
    expect(onSave.mock.calls[0][0].operationsSettings).toMatchObject({
      submitStartTime: '2026-07-20T09:00:30.123456+09:00',
      submitEndTime: '2026-08-20T18:30:45+09:00',
    })
  })

  it('再取り込みで operationsSettings shape が absent なら現在値を保持して誤clearしない', async () => {
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({ ok: true, fields: [], logic: [] })
    render(<FormBuilder {...base({
      onSave,
      onReimport,
      initialOperationsSettings: { hasRecaptcha: true, maxSubmitCount: 30, utmTracking: true },
    })} />)

    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    })

    expect(recaptcha().checked).toBe(true)
    expect(maxSubmitCount().value).toBe('30')
    expect(utmCapture().checked).toBe(true)
    fireEvent.click(screen.getByText('保存'))
    expect('operationsSettings' in (onSave.mock.calls[0][0] as Record<string, unknown>)).toBe(false)
  })

  it('未保存のlocal-only UTM intentは再取り込み後もtouchedとして次のsaveへ載せる', async () => {
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({ ok: true, fields: [], logic: [] })
    render(<FormBuilder {...base({ onSave, onReimport })} />)

    fireEvent.click(utmCapture())
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    })
    expect(utmCapture().checked).toBe(true)

    fireEvent.click(screen.getByText('保存'))
    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({ utmTracking: true })
  })

  it('再取り込みの explicit empty は remote 全解除として次の save に5 keyを載せる', async () => {
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({ ok: true, fields: [], logic: [], operationsSettings: {} })
    render(<FormBuilder {...base({
      onSave,
      onReimport,
      initialOperationsSettings: { hasRecaptcha: true, maxSubmitCount: 30, utmTracking: true },
    })} />)

    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    })
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({
      hasRecaptcha: false,
      acceptDraftAnswers: false,
      maxSubmitCount: null,
      submitStartTime: null,
      submitEndTime: null,
    })
    expect(utmCapture().checked).toBe(true)
  })

  it('完全同期した save 後は touched を消し、次の無関係 save で古い値を再PATCHしない', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(recaptcha())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].operationsSettings).toEqual({ hasRecaptcha: true })

    await waitFor(() => expect(screen.getByText('保存')).not.toHaveProperty('disabled', true))
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect('operationsSettings' in (onSave.mock.calls[1][0] as Record<string, unknown>)).toBe(false)
  })

  it('保存中は運用制御を編集不可にし、送信中 snapshot より新しい intent を消さない', async () => {
    let resolveSave!: (value: { ok: true }) => void
    const onSave = vi.fn().mockImplementation(() => new Promise<{ ok: true }>((resolve) => {
      resolveSave = resolve
    }))
    render(<FormBuilder {...base({ onSave, onReimport: vi.fn() })} />)

    fireEvent.click(recaptcha())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    expect(recaptcha().disabled).toBe(true)
    expect(draftAnswers().disabled).toBe(true)
    expect(maxSubmitCount().disabled).toBe(true)
    expect(submitStartTime().disabled).toBe(true)
    expect(submitEndTime().disabled).toBe(true)
    expect(utmCapture().disabled).toBe(true)
    expect((screen.getByText('Formaloo から再取り込み') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => resolveSave({ ok: true }))
    await waitFor(() => expect(recaptcha().disabled).toBe(false))
  })

  it('保存中は表示済みの再取り込み確認も実行不可にする', async () => {
    let resolveSave!: (value: { ok: true }) => void
    const onSave = vi.fn().mockImplementation(() => new Promise<{ ok: true }>((resolve) => {
      resolveSave = resolve
    }))
    render(<FormBuilder {...base({ onSave, onReimport: vi.fn() })} />)

    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(recaptcha())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    expect((within(screen.getByTestId('reimport-confirm')).getByText('はい') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => resolveSave({ ok: true }))
  })

  it('再取り込み中も save を開始できず、双方向の状態競合を防ぐ', async () => {
    let resolveReimport!: (value: { ok: false }) => void
    const onReimport = vi.fn().mockImplementation(() => new Promise<{ ok: false }>((resolve) => {
      resolveReimport = resolve
    }))
    render(<FormBuilder {...base({ onReimport })} />)

    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    })
    await waitFor(() => expect(onReimport).toHaveBeenCalledTimes(1))

    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => resolveReimport({ ok: false }))
  })
})
