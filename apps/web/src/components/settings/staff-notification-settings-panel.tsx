'use client'

import { useEffect, useRef, useState } from 'react'
import {
  staffNotificationSettingsApi,
  type StaffNotificationChannelDefinition,
  type StaffNotificationDestinationInput,
  type StaffNotificationDestinationView,
  type StaffNotificationLineLinkCode,
} from './staff-notification-settings-api'

export interface StaffNotificationSettingsPanelProps {
  accountId: string | null
}

type TestState = 'testing' | 'ok' | 'ng'

const GENERIC_ERROR = '操作に失敗しました。設定内容を確認して、もう一度お試しください。'

function fieldValueIsValid(
  definition: StaffNotificationChannelDefinition,
  values: Record<string, string>,
  existing: StaffNotificationDestinationView | undefined,
): boolean {
  return definition.configFields.every((field) => {
    const value = values[field.key]?.trim() ?? ''
    const existingSecret = field.inputType === 'secret'
      && Boolean(existing?.config[field.key])
    if (field.required && !value && !existingSecret) return false
    if (!value) return true
    if (value.length > field.maxLength) return false
    if (!field.pattern) return true
    try {
      return new RegExp(field.pattern).test(value)
    } catch {
      return false
    }
  })
}

function removeKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export default function StaffNotificationSettingsPanel({
  accountId,
}: StaffNotificationSettingsPanelProps) {
  const [channels, setChannels] = useState<StaffNotificationChannelDefinition[]>([])
  const [destinations, setDestinations] = useState<StaffNotificationDestinationView[]>([])
  const [loading, setLoading] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestState>>({})
  const [lineCodes, setLineCodes] = useState<Record<string, StaffNotificationLineLinkCode>>({})

  const [editingId, setEditingId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [channelType, setChannelType] = useState('')
  const [notifyInquiry, setNotifyInquiry] = useState(true)
  const [notifyFormSubmission, setNotifyFormSubmission] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})

  const requestVersion = useRef(0)
  const activeAccount = useRef<string | null>(accountId)
  activeAccount.current = accountId

  const resetForm = (availableChannels = channels) => {
    setEditingId(null)
    setLabel('')
    setChannelType(availableChannels[0]?.channelType ?? '')
    setNotifyInquiry(true)
    setNotifyFormSubmission(true)
    setEnabled(true)
    setConfigValues({})
  }

  const isCurrentRequest = (version: number, currentAccountId: string) => (
    requestVersion.current === version
    && activeAccount.current === currentAccountId
  )

  const reload = async (
    currentAccountId: string,
    version: number,
  ): Promise<StaffNotificationDestinationView[] | null> => {
    const next = await staffNotificationSettingsApi.list(currentAccountId)
    if (!isCurrentRequest(version, currentAccountId)) return null
    setDestinations(next)
    return next
  }

  useEffect(() => {
    const version = ++requestVersion.current
    setChannels([])
    setDestinations([])
    setLoading(false)
    setOperation(null)
    setError(null)
    setNotice(null)
    setTestResults({})
    setLineCodes({})
    resetForm([])

    if (!accountId) return

    setLoading(true)
    void Promise.all([
      staffNotificationSettingsApi.listChannels(),
      staffNotificationSettingsApi.list(accountId),
    ])
      .then(([nextChannels, nextDestinations]) => {
        if (!isCurrentRequest(version, accountId)) return
        setChannels(nextChannels)
        setDestinations(nextDestinations)
        setChannelType(nextChannels[0]?.channelType ?? '')
      })
      .catch(() => {
        if (isCurrentRequest(version, accountId)) setError(GENERIC_ERROR)
      })
      .finally(() => {
        if (isCurrentRequest(version, accountId)) setLoading(false)
      })
  }, [accountId])

  const currentEditing = editingId
    ? destinations.find((destination) => destination.id === editingId)
    : undefined
  const currentDefinition = channels.find(
    (channel) => channel.channelType === channelType,
  )
  const busy = loading || operation !== null
  const canSave = !busy
    && label.trim() !== ''
    && Boolean(currentDefinition)
    && Boolean(
      currentDefinition
      && fieldValueIsValid(currentDefinition, configValues, currentEditing),
    )

  const runMutation = async (
    operationKey: string,
    action: (currentAccountId: string) => Promise<unknown>,
    successMessage: string,
    afterSuccess?: () => void,
  ) => {
    const currentAccountId = accountId
    if (!currentAccountId || busy) return
    const version = requestVersion.current
    setOperation(operationKey)
    setError(null)
    setNotice(null)

    try {
      await action(currentAccountId)
      const refreshed = await reload(currentAccountId, version)
      if (!refreshed) return
      afterSuccess?.()
      setNotice(successMessage)
    } catch {
      if (isCurrentRequest(version, currentAccountId)) setError(GENERIC_ERROR)
    } finally {
      if (isCurrentRequest(version, currentAccountId)) setOperation(null)
    }
  }

  const save = () => {
    if (!accountId || !canSave || !currentDefinition) return
    const config = Object.fromEntries(currentDefinition.configFields.map((field) => [
      field.key,
      configValues[field.key]?.trim() ?? '',
    ]))
    const input: StaffNotificationDestinationInput = {
      lineAccountId: accountId,
      label: label.trim(),
      channelType: currentDefinition.channelType,
      notifyInquiry,
      notifyFormSubmission,
      enabled,
      config,
    }

    if (editingId) {
      const destinationId = editingId
      void runMutation(
        `update:${destinationId}`,
        () => staffNotificationSettingsApi.update(destinationId, input),
        '通知先を更新しました。',
        () => resetForm(),
      )
      return
    }

    void runMutation(
      'create',
      () => staffNotificationSettingsApi.create(input),
      '通知先を追加しました。',
      () => resetForm(),
    )
  }

  const startEdit = (destination: StaffNotificationDestinationView) => {
    if (busy || destination.unsupported) return
    const definition = channels.find(
      (channel) => channel.channelType === destination.channelType,
    )
    if (!definition) return
    setTestResults((current) => removeKey(current, destination.id))
    setEditingId(destination.id)
    setLabel(destination.label)
    setChannelType(destination.channelType)
    setNotifyInquiry(destination.notifyInquiry)
    setNotifyFormSubmission(destination.notifyFormSubmission)
    setEnabled(destination.enabled)
    setConfigValues(Object.fromEntries(definition.configFields.map((field) => [
      field.key,
      field.inputType === 'secret' ? '' : destination.config[field.key] ?? '',
    ])))
    setError(null)
    setNotice(null)
  }

  const remove = (destination: StaffNotificationDestinationView) => {
    void runMutation(
      `delete:${destination.id}`,
      (currentAccountId) => staffNotificationSettingsApi.remove(
        currentAccountId,
        destination.id,
      ),
      '通知先を削除しました。',
      () => {
        if (editingId === destination.id) resetForm()
        setLineCodes((current) => removeKey(current, destination.id))
        setTestResults((current) => removeKey(current, destination.id))
      },
    )
  }

  const sendTest = async (destination: StaffNotificationDestinationView) => {
    const currentAccountId = accountId
    if (!currentAccountId || busy) return
    const version = requestVersion.current
    setOperation(`test:${destination.id}`)
    setError(null)
    setNotice(null)
    setTestResults((current) => ({ ...current, [destination.id]: 'testing' }))

    try {
      await staffNotificationSettingsApi.sendTest(currentAccountId, destination.id)
      if (!isCurrentRequest(version, currentAccountId)) return
      setTestResults((current) => ({ ...current, [destination.id]: 'ok' }))
    } catch {
      if (!isCurrentRequest(version, currentAccountId)) return
      setTestResults((current) => ({ ...current, [destination.id]: 'ng' }))
    } finally {
      if (isCurrentRequest(version, currentAccountId)) setOperation(null)
    }
  }

  const issueLineLinkCode = async (destination: StaffNotificationDestinationView) => {
    const currentAccountId = accountId
    if (!currentAccountId || busy) return
    const version = requestVersion.current
    setOperation(`line-code:${destination.id}`)
    setError(null)
    setNotice(null)

    try {
      const code = await staffNotificationSettingsApi.issueLineLinkCode(
        currentAccountId,
        destination.id,
      )
      if (!isCurrentRequest(version, currentAccountId)) return
      setLineCodes((current) => ({ ...current, [destination.id]: code }))
      setNotice('LINE連携コードを発行しました。')
    } catch {
      if (isCurrentRequest(version, currentAccountId)) setError(GENERIC_ERROR)
    } finally {
      if (isCurrentRequest(version, currentAccountId)) setOperation(null)
    }
  }

  const refreshLineLinkStatus = async (
    destination: StaffNotificationDestinationView,
  ) => {
    const currentAccountId = accountId
    if (!currentAccountId || busy) return
    const version = requestVersion.current
    setOperation(`line-refresh:${destination.id}`)
    setError(null)
    setNotice(null)

    try {
      const refreshed = await reload(currentAccountId, version)
      if (!refreshed) return
      const linked = refreshed.find((item) => item.id === destination.id)
        ?.setupState?.linked === true
      if (linked) {
        setLineCodes((current) => removeKey(current, destination.id))
        setNotice('LINE連携を確認しました。')
      } else {
        setNotice('LINE連携はまだ確認できません。送信後にもう一度更新してください。')
      }
    } catch {
      if (isCurrentRequest(version, currentAccountId)) setError(GENERIC_ERROR)
    } finally {
      if (isCurrentRequest(version, currentAccountId)) setOperation(null)
    }
  }

  const unlinkLine = (destination: StaffNotificationDestinationView) => {
    void runMutation(
      `line-unlink:${destination.id}`,
      (currentAccountId) => staffNotificationSettingsApi.unlinkLine(
        currentAccountId,
        destination.id,
      ),
      'LINE連携を解除しました。',
      () => setLineCodes((current) => removeKey(current, destination.id)),
    )
  }

  if (!accountId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        先に LINE アカウントを選択してください。
      </div>
    )
  }

  return (
    <div data-testid="staff-notification-settings-panel" className="mt-8 space-y-6 border-t border-gray-200 pt-6">
      <section>
        <h2 className="text-base font-semibold text-gray-900">スタッフ通知</h2>
        <p className="mt-1 text-sm text-gray-600">
          問い合わせやフォーム申込みを、登録した通知チャネルへ送ります。
        </p>
        {channels.filter((channel) => channel.notice).map((channel) => (
          <p
            key={channel.channelType}
            className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {channel.notice}
          </p>
        ))}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-700">登録済みの通知先</h3>
        {loading ? (
          <p className="text-sm text-gray-500">通知先を読み込んでいます...</p>
        ) : destinations.length === 0 ? (
          <div
            data-testid="staff-notification-empty"
            className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600"
          >
            通知先はまだありません。下のフォームから追加してください。
          </div>
        ) : (
          <ul className="space-y-3">
            {destinations.map((destination) => {
              const definition = channels.find(
                (channel) => channel.channelType === destination.channelType,
              )
              const testState = testResults[destination.id]
              const lineCode = lineCodes[destination.id]
              const lineSetup = definition?.capabilities.setupKind === 'line_one_time'
              return (
                <li
                  key={destination.id}
                  data-testid={`staff-notification-destination-${destination.id}`}
                  className="rounded-lg border border-gray-200 bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-gray-900">{destination.label}</p>
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {definition?.label ?? `未対応 (${destination.channelType})`}
                        </span>
                        <span className={`rounded px-2 py-0.5 text-xs ${
                          destination.enabled
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {destination.enabled ? '有効' : '無効'}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-gray-600">
                        問い合わせ受信: {destination.notifyInquiry ? '通知する' : '通知しない'}
                      </p>
                      <p className="mt-1 text-xs text-gray-600">
                        フォーム申込み: {destination.notifyFormSubmission ? '通知する' : '通知しない'}
                      </p>

                      {destination.unsupported ? (
                        <p className="mt-2 text-xs text-amber-700">
                          このチャネルは現在のバージョンでは編集・送信できません。削除は可能です。
                        </p>
                      ) : (
                        definition?.configFields.map((field) => (
                          <p key={field.key} className="mt-1 text-xs text-gray-600">
                            {field.label}: {destination.config[field.key] || '未設定'}
                          </p>
                        ))
                      )}

                      {lineSetup && (
                        <div className="mt-2 space-y-2 text-xs text-gray-600">
                          <p>
                            LINE連携: {destination.setupState?.linked ? '連携済み' : '未連携'}
                          </p>
                          {lineCode && (
                            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-blue-950">
                              <p>
                                スタッフが公式アカウントへ、次の文をそのまま送信してください。
                              </p>
                              <code className="mt-1 block font-mono text-sm">
                                通知連携 {lineCode.code}
                              </code>
                              <p className="mt-1">有効期限: {lineCode.expiresAt}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {definition?.capabilities.testSend && !destination.unsupported && (
                        <button
                          type="button"
                          aria-label={`${destination.label}へテスト送信`}
                          onClick={() => { void sendTest(destination) }}
                          disabled={busy}
                          className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                        >
                          {testState === 'testing' ? '送信中...' : 'テスト送信'}
                        </button>
                      )}
                      {lineSetup && !destination.setupState?.linked && (
                        <button
                          type="button"
                          aria-label={`${destination.label}の連携コードを発行`}
                          onClick={() => { void issueLineLinkCode(destination) }}
                          disabled={busy}
                          className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                        >
                          {operation === `line-code:${destination.id}` ? '発行中...' : '連携コードを発行'}
                        </button>
                      )}
                      {lineSetup && !destination.setupState?.linked && lineCode && (
                        <button
                          type="button"
                          aria-label={`${destination.label}の連携状態を更新`}
                          onClick={() => { void refreshLineLinkStatus(destination) }}
                          disabled={busy}
                          className="rounded border border-blue-300 px-3 py-1.5 text-xs text-blue-800 disabled:opacity-50"
                        >
                          {operation === `line-refresh:${destination.id}`
                            ? '確認中...'
                            : '連携状態を更新'}
                        </button>
                      )}
                      {lineSetup && destination.setupState?.linked && (
                        <button
                          type="button"
                          aria-label={`${destination.label}のLINE連携を解除`}
                          onClick={() => unlinkLine(destination)}
                          disabled={busy}
                          className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 disabled:opacity-50"
                        >
                          連携解除
                        </button>
                      )}
                      {!destination.unsupported && definition && (
                        <button
                          type="button"
                          aria-label={`${destination.label}を編集`}
                          onClick={() => startEdit(destination)}
                          disabled={busy}
                          className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                        >
                          編集
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`${destination.label}を削除`}
                        onClick={() => remove(destination)}
                        disabled={busy}
                        className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 disabled:opacity-50"
                      >
                        削除
                      </button>
                    </div>
                  </div>

                  {testState === 'ok' && (
                    <p role="status" className="mt-2 text-xs text-green-700">
                      テスト通知を送信しました。
                    </p>
                  )}
                  {testState === 'ng' && (
                    <p role="alert" className="mt-2 text-xs text-red-600">
                      テスト通知を送信できませんでした。設定を確認してください。
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-700">
          {editingId ? '通知先を編集' : '通知先を追加'}
        </h3>

        <div>
          <label htmlFor="staff-notification-channel" className="mb-1 block text-sm text-gray-700">
            通知チャネル
          </label>
          <select
            id="staff-notification-channel"
            aria-label="通知チャネル"
            value={channelType}
            disabled={busy || editingId !== null || channels.length === 0}
            onChange={(event) => {
              setChannelType(event.target.value)
              setConfigValues({})
            }}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-60"
          >
            {channels.map((channel) => (
              <option key={channel.channelType} value={channel.channelType}>
                {channel.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="staff-notification-label" className="mb-1 block text-sm text-gray-700">
            通知先名
          </label>
          <input
            id="staff-notification-label"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例：受付担当"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        {currentDefinition?.configFields.map((field) => {
          const id = `staff-notification-config-${field.key}`
          const existingSecret = field.inputType === 'secret'
            && Boolean(currentEditing?.config[field.key])
          return (
            <div key={field.key}>
              <label htmlFor={id} className="mb-1 block text-sm text-gray-700">
                {field.label}
              </label>
              <input
                id={id}
                type={field.inputType === 'secret' ? 'password' : 'text'}
                autoComplete={field.inputType === 'secret' ? 'off' : undefined}
                value={configValues[field.key] ?? ''}
                maxLength={field.maxLength}
                pattern={field.pattern}
                onChange={(event) => setConfigValues((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))}
                placeholder={existingSecret
                  ? '変更する場合だけ入力'
                  : field.placeholder}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              {existingSecret && (
                <p className="mt-1 text-xs text-gray-500">
                  保存済み: {currentEditing?.config[field.key]}（空欄なら変更しません）
                </p>
              )}
            </div>
          )
        })}

        {currentDefinition?.notice && (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {currentDefinition.notice}
          </p>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700">通知するイベント</legend>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={notifyInquiry}
              onChange={(event) => setNotifyInquiry(event.target.checked)}
            />
            問い合わせ受信を通知
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={notifyFormSubmission}
              onChange={(event) => setNotifyFormSubmission(event.target.checked)}
            />
            フォーム申込みを通知
          </label>
        </fieldset>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          この通知先を有効にする
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="rounded-lg bg-[#06C755] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {operation === 'create' || operation?.startsWith('update:')
              ? '保存中...'
              : editingId ? '変更を保存' : '通知先を追加'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => resetForm()}
              disabled={busy}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 disabled:opacity-50"
            >
              編集をやめる
            </button>
          )}
        </div>
      </section>

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
