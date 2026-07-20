// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import {
  createAutomationRuleModel,
  type AutomationRuleModel,
} from '@/lib/automation-rule-builder'
import {
  AutomationRuleBuilder,
  AutomationUnsupportedNotice,
} from './automation-rule-builder'

function Harness({ initial = createAutomationRuleModel() }: { initial?: AutomationRuleModel }) {
  const [model, setModel] = useState(initial)
  return (
    <AutomationRuleBuilder
      model={model}
      onChange={setModel}
      conditionsJson={JSON.stringify(model.conditions, null, 2)}
      actionsJson={JSON.stringify(model.actions, null, 2)}
    />
  )
}

afterEach(cleanup)

describe('AutomationRuleBuilder', () => {
  it('shows the two-step sentence and every trigger/action choice', () => {
    render(<Harness />)

    expect(screen.getByText('1. このイベントが起きたら')).toBeTruthy()
    expect(screen.getByText('2. これをする')).toBeTruthy()
    expect(within(screen.getByLabelText('イベント')).getAllByRole('option')).toHaveLength(7)
    expect(within(screen.getByLabelText('アクション 1の種類')).getAllByRole('option')).toHaveLength(8)
  })

  it('edits an incoming webhook trigger without exposing JSON editing', () => {
    render(<Harness />)

    fireEvent.change(screen.getByLabelText('イベント'), { target: { value: 'incoming_webhook.*' } })
    fireEvent.change(screen.getByLabelText('Webhookの種類'), { target: { value: 'stripe' } })

    expect((screen.getByLabelText('Webhookの種類') as HTMLInputElement).value).toBe('stripe')
    expect((screen.getByLabelText('条件JSON') as HTMLTextAreaElement).readOnly).toBe(true)
    expect((screen.getByLabelText('アクションJSON') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  it('adds, edits, and removes actions with parameter forms', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'アクションを追加' }))
    fireEvent.change(screen.getByLabelText('アクション 2の種類'), { target: { value: 'send_webhook' } })
    fireEvent.change(screen.getByLabelText('アクション 2: 送信先URL'), {
      target: { value: 'https://example.test/hook' },
    })

    expect((screen.getByLabelText('アクションJSON') as HTMLTextAreaElement).value).toContain('send_webhook')
    expect((screen.getByLabelText('アクションJSON') as HTMLTextAreaElement).value).toContain('https://example.test/hook')
    fireEvent.click(screen.getByRole('button', { name: 'アクション 2を削除' }))
    expect(screen.getAllByLabelText(/アクション \d+の種類/)).toHaveLength(1)
  })

  it('shows unsupported JSON honestly and read-only', () => {
    render(
      <AutomationUnsupportedNotice
        reasons={['未対応のアクションです: future']}
        conditionsJson={'{\n  "future": true\n}'}
        actionsJson={'[{"type":"future","params":{}}]'}
      />,
    )

    expect(screen.getByText(/GUI 非対応・JSON のまま保持/)).toBeTruthy()
    expect((screen.getByLabelText('保持中の条件JSON') as HTMLTextAreaElement).readOnly).toBe(true)
    expect((screen.getByLabelText('保持中のアクションJSON') as HTMLTextAreaElement).readOnly).toBe(true)
  })
})
