'use client'

import { useEffect, useRef, useState } from 'react'
import {
  emailSenderSettingsApi,
  type EmailSenderSettingsView,
} from '@/lib/email-sender-settings-api'

export interface EmailSenderSettingsPanelProps {
  accountId: string | null
}

type Operation = 'save' | 'key' | 'register' | 'check' | 'test'

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function errorMessage(error: unknown): string {
  const body = (error as { body?: { error?: string } })?.body
  return body?.error || '操作に失敗しました。入力内容を確認して、もう一度お試しください。'
}

function domainStatusLabel(status: string, registered: boolean): string {
  switch (status) {
    case 'verified':
      return '認証済み'
    case 'pending':
      return '認証待ち'
    case 'failed':
      return '認証に失敗'
    case 'not_started':
      return registered ? '認証待ち' : 'まだ登録していません'
    case 'not_registered':
    case 'unregistered':
    case 'none':
      return 'まだ登録していません'
    default:
      return status || 'まだ確認していません'
  }
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Clipboard API can be unavailable even when the property exists.
    }
  }

  const textarea = document.createElement('textarea')
  const previouslyFocused = document.activeElement as HTMLElement | null
  textarea.value = value
  textarea.setAttribute('aria-hidden', 'true')
  textarea.tabIndex = -1
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)

  try {
    textarea.focus()
    textarea.select()
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) {
      throw new Error('clipboard_copy_failed')
    }
  } finally {
    textarea.remove()
    previouslyFocused?.focus()
  }
}

export default function EmailSenderSettingsPanel({
  accountId,
}: EmailSenderSettingsPanelProps) {
  const [settings, setSettings] = useState<EmailSenderSettingsView | null>(null)
  const [senderEmail, setSenderEmail] = useState('')
  const [senderName, setSenderName] = useState('')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [resendApiKey, setResendApiKey] = useState('')
  const [showResendGuide, setShowResendGuide] = useState(false)
  const [loading, setLoading] = useState(false)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const activeAccount = useRef<string | null>(accountId)
  activeAccount.current = accountId

  const applyView = (view: EmailSenderSettingsView) => {
    setSettings(view)
    setSenderEmail(view.senderEmail ?? '')
    setSenderName(view.senderName ?? '')
    setRecipientEmail(view.senderEmail ?? '')
    setResendApiKey('')
  }

  useEffect(() => {
    const version = ++requestVersion.current
    setSettings(null)
    setSenderEmail('')
    setSenderName('')
    setRecipientEmail('')
    setResendApiKey('')
    setShowResendGuide(false)
    setError(null)
    setNotice(null)
    setOperation(null)

    if (!accountId) {
      setLoading(false)
      return
    }

    setLoading(true)
    void emailSenderSettingsApi.get(accountId)
      .then((view) => {
        if (version !== requestVersion.current || activeAccount.current !== accountId) return
        applyView(view)
      })
      .catch((cause) => {
        if (version !== requestVersion.current || activeAccount.current !== accountId) return
        setError(errorMessage(cause))
      })
      .finally(() => {
        if (version === requestVersion.current && activeAccount.current === accountId) {
          setLoading(false)
        }
      })
  }, [accountId])

  const trimmedEmail = senderEmail.trim()
  const trimmedName = senderName.trim()
  const trimmedRecipientEmail = recipientEmail.trim()
  const trimmedResendApiKey = resendApiKey.trim()
  const invalidEmail = trimmedEmail !== '' && !isEmail(trimmedEmail)
  const invalidRecipientEmail = (
    trimmedRecipientEmail !== ''
    && !isEmail(trimmedRecipientEmail)
  )
  const busy = loading || operation !== null
  const savedEmailMatches = Boolean(
    settings?.senderEmail
    && settings.senderEmail.trim().toLowerCase() === trimmedEmail.toLowerCase(),
  )

  const runOperation = async (
    kind: Operation,
    action: (currentAccountId: string) => Promise<EmailSenderSettingsView>,
    successMessage: string,
  ) => {
    const currentAccountId = accountId
    if (!currentAccountId || busy) return
    const version = requestVersion.current
    setOperation(kind)
    setError(null)
    setNotice(null)
    try {
      const view = await action(currentAccountId)
      if (
        requestVersion.current !== version
        || activeAccount.current !== currentAccountId
      ) return
      applyView(view)
      setNotice(successMessage)
    } catch (cause) {
      if (
        requestVersion.current === version
        && activeAccount.current === currentAccountId
      ) setError(errorMessage(cause))
    } finally {
      if (
        requestVersion.current === version
        && activeAccount.current === currentAccountId
      ) setOperation(null)
    }
  }

  const save = () => {
    if (invalidEmail) return
    void runOperation(
      'save',
      (currentAccountId) => emailSenderSettingsApi.save(currentAccountId, {
        senderEmail: trimmedEmail || null,
        senderName: trimmedName || null,
      }),
      '差出人設定を保存しました。',
    )
  }

  const saveResendApiKey = () => {
    if (!trimmedResendApiKey) return
    void runOperation(
      'key',
      (currentAccountId) => emailSenderSettingsApi.setResendApiKey(
        currentAccountId,
        trimmedResendApiKey,
      ),
      'Resend APIキーを保存しました。',
    )
  }

  const deleteResendApiKey = () => {
    void runOperation(
      'key',
      (currentAccountId) => emailSenderSettingsApi.setResendApiKey(
        currentAccountId,
        null,
      ),
      '保存済みのResend APIキーを削除しました。共通キーを使用します。',
    )
  }

  const sendTest = async () => {
    const currentAccountId = accountId
    if (
      !currentAccountId
      || busy
      || !settings?.senderEmail
      || !isEmail(trimmedRecipientEmail)
    ) return
    const version = requestVersion.current
    setOperation('test')
    setError(null)
    setNotice(null)
    try {
      const result = await emailSenderSettingsApi.testSend(
        currentAccountId,
        trimmedRecipientEmail,
      )
      if (
        requestVersion.current !== version
        || activeAccount.current !== currentAccountId
      ) return
      setNotice(result.message)
    } catch (cause) {
      if (
        requestVersion.current === version
        && activeAccount.current === currentAccountId
      ) setError(errorMessage(cause))
    } finally {
      if (
        requestVersion.current === version
        && activeAccount.current === currentAccountId
      ) setOperation(null)
    }
  }

  const copy = async (label: string, value: string) => {
    setError(null)
    setNotice(null)
    try {
      await writeClipboard(value)
      setNotice(`${label}をコピーしました。`)
    } catch {
      setError('コピーできませんでした。文字を選んでコピーしてください。')
    }
  }

  if (!accountId) {
    return (
      <div
        data-testid="email-sender-account-required"
        className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
      >
        先に LINE アカウントを選択してください。
      </div>
    )
  }

  return (
    <div data-testid="email-sender-settings-panel" className="space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">通知メールの差出人</h2>
        <p className="mt-1 text-sm text-gray-600">
          自動返信や編集リンクのメールに表示する差出人を、LINE アカウントごとに設定します。
          空欄で保存すると、これまでの既定の差出人に戻ります。
        </p>

        {loading ? (
          <p className="mt-4 text-sm text-gray-500">設定を読み込んでいます...</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="email-sender-address"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                差出人メールアドレス
              </label>
              <input
                id="email-sender-address"
                type="email"
                value={senderEmail}
                onChange={(event) => {
                  setSenderEmail(event.target.value)
                  setNotice(null)
                }}
                placeholder="例：info@example.com"
                autoComplete="email"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              {invalidEmail && (
                <p className="mt-1 text-xs text-red-600">
                  メールアドレスの形で入力してください。
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="email-sender-name"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                差出人名（任意）
              </label>
              <input
                id="email-sender-name"
                type="text"
                value={senderName}
                onChange={(event) => {
                  setSenderName(event.target.value)
                  setNotice(null)
                }}
                placeholder="例：〇〇事務局"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={save}
              disabled={busy || invalidEmail}
              className="rounded-lg bg-[#06C755] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {operation === 'save' ? '保存中...' : '差出人を保存'}
            </button>
          </div>
        )}

        {settings?.usingFallback && settings.senderEmail && (
          <p
            role="alert"
            className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            未認証のため既定の差出人で送っています
          </p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">
          送信サービス（Resend）の接続
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          このLINEアカウント専用のResend APIキーを設定できます。
          キーを設定しない場合は、これまでどおり共通の送信設定を使います。
        </p>

        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
          {settings?.resendApiKeyMasked ? (
            <p className="text-sm text-gray-700">
              保存済みAPIキー: <code>********</code>
            </p>
          ) : (
            <p className="text-sm text-gray-700">未設定（共通キーを使用します）</p>
          )}
        </div>

        <div className="mt-4">
          <label
            htmlFor="email-sender-resend-api-key"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Resend APIキー
          </label>
          <input
            id="email-sender-resend-api-key"
            type="password"
            value={resendApiKey}
            onChange={(event) => {
              setResendApiKey(event.target.value)
              setNotice(null)
            }}
            placeholder="re_..."
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            保存後はマスクだけを表示し、入力したキーは画面に残しません。
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={saveResendApiKey}
            disabled={busy || trimmedResendApiKey === ''}
            className="rounded-lg bg-[#06C755] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {operation === 'key' && trimmedResendApiKey !== ''
              ? '保存中...'
              : 'APIキーを保存'}
          </button>
          {settings?.resendApiKeyMasked && (
            <button
              type="button"
              onClick={deleteResendApiKey}
              disabled={busy}
              className="rounded border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-50"
            >
              保存済みAPIキーを削除
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowResendGuide(true)}
            disabled={busy}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
          >
            Resendアカウント作成手順を開く
          </button>
        </div>

        <div className="mt-4 border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-600">
            下の宛先アドレスに確認メールを1通送ります。
          </p>
          <div className="mt-2 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label
                htmlFor="email-sender-test-recipient"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                宛先メールアドレス
              </label>
              <input
                id="email-sender-test-recipient"
                type="email"
                value={recipientEmail}
                onChange={(event) => {
                  setRecipientEmail(event.target.value)
                  setNotice(null)
                }}
                placeholder="例：recipient@example.com"
                autoComplete="email"
                aria-invalid={invalidRecipientEmail}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() => { void sendTest() }}
              disabled={
                busy
                || !settings?.senderEmail
                || trimmedRecipientEmail === ''
                || invalidRecipientEmail
              }
              className="shrink-0 rounded border border-[#087A39] px-3 py-2 text-sm font-medium text-[#087A39] disabled:opacity-50"
            >
              {operation === 'test' ? '送信中...' : 'テスト送信'}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">独自ドメインの認証</h2>
        <p className="mt-1 text-sm text-gray-600">
          メール会社に「このドメインを使ってよい」と確認してもらうため、DNS 設定を行います。
        </p>

        <div
          data-testid="email-sender-dns-guide"
          className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"
        >
          <h3 className="font-semibold">設定の手順</h3>
          <ol className="mt-2 space-y-2">
            <li>1. 上の差出人メールアドレスを入力して、「差出人を保存」を押します。</li>
            <li>2. 下の「ドメインを登録してDNS設定を表示」を押します。</li>
            <li>
              3. ドメインを管理しているサービス（お名前.com、Cloudflare など）の DNS 設定画面を開きます。
            </li>
            <li>
              4. 表示された各行の「種類」「名前」「値」を、そのまま DNS 設定画面へ貼り付けて保存します。
            </li>
            <li>
              5. DNS の反映には時間がかかることがあります。少し待ってから「認証状態を確認」を押します。
            </li>
          </ol>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void runOperation(
                'register',
                (currentAccountId) => emailSenderSettingsApi.registerDomain(currentAccountId),
                'DNS 設定を表示しました。',
              )
            }}
            disabled={busy || invalidEmail || trimmedEmail === '' || !savedEmailMatches}
            className="rounded border border-[#087A39] px-3 py-2 text-sm font-medium text-[#087A39] disabled:opacity-50"
          >
            {operation === 'register'
              ? '登録中...'
              : 'ドメインを登録してDNS設定を表示'}
          </button>
          <button
            type="button"
            onClick={() => {
              void runOperation(
                'check',
                (currentAccountId) => emailSenderSettingsApi.checkDomain(currentAccountId),
                '認証状態を更新しました。',
              )
            }}
            disabled={busy || !settings?.resendDomainId}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
          >
            {operation === 'check' ? '確認中...' : '認証状態を確認'}
          </button>
        </div>

        <div
          data-testid="email-sender-domain-status"
          className="mt-3 text-sm text-gray-700"
        >
          対象ドメイン: {settings?.senderDomain ?? '未設定'}
          {' / '}
          状態: {domainStatusLabel(
            settings?.domainStatus ?? '',
            Boolean(settings?.resendDomainId),
          )}
        </div>

        {(settings?.dnsRecords.length ?? 0) > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-gray-800">貼り付ける DNS レコード</h3>
            <ul className="mt-2 space-y-3">
              {settings?.dnsRecords.map((record, index) => {
                const recordLabel = record.record?.trim() || `${record.type} ${index + 1}`
                const nameId = `email-sender-dns-${index}-name`
                const valueId = `email-sender-dns-${index}-value`
                return (
                  <li
                    key={`${record.type}-${record.name}-${index}`}
                    className="rounded-lg border border-gray-200 bg-gray-50 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-gray-200 px-2 py-1 text-xs font-semibold text-gray-800">
                        {record.type}
                      </span>
                      {record.record && (
                        <span className="text-xs text-gray-600">{record.record}</span>
                      )}
                      {record.ttl && (
                        <span className="text-xs text-gray-600">TTL: {record.ttl}</span>
                      )}
                      {record.priority !== null && (
                        <span className="text-xs text-gray-600">
                          優先度: {record.priority}
                        </span>
                      )}
                      {record.status && (
                        <span className="text-xs text-gray-600">
                          レコード状態: {record.status}
                        </span>
                      )}
                    </div>

                    <div className="mt-3">
                      <label
                        htmlFor={nameId}
                        className="mb-1 block text-xs font-medium text-gray-700"
                      >
                        名前
                      </label>
                      <div className="flex gap-2">
                        <input
                          id={nameId}
                          readOnly
                          value={record.name}
                          className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-2 font-mono text-xs"
                        />
                        <button
                          type="button"
                          aria-label={`${recordLabel} の名前をコピー`}
                          onClick={() => { void copy('名前', record.name) }}
                          className="rounded border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700"
                        >
                          コピー
                        </button>
                      </div>
                    </div>

                    <div className="mt-3">
                      <label
                        htmlFor={valueId}
                        className="mb-1 block text-xs font-medium text-gray-700"
                      >
                        値
                      </label>
                      <div className="flex items-start gap-2">
                        <textarea
                          id={valueId}
                          readOnly
                          value={record.value}
                          rows={2}
                          className="min-w-0 flex-1 resize-y rounded border border-gray-300 bg-white px-2 py-2 font-mono text-xs"
                        />
                        <button
                          type="button"
                          aria-label={`${recordLabel} の値をコピー`}
                          onClick={() => { void copy('値', record.value) }}
                          className="rounded border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700"
                        >
                          コピー
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>

      {showResendGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowResendGuide(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="resend-account-guide-title"
            className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl"
          >
            <h2
              id="resend-account-guide-title"
              className="text-lg font-semibold text-gray-900"
            >
              Resendアカウント作成手順
            </h2>
            <ol className="mt-4 space-y-3 text-sm text-gray-700">
              <li>1. Resendの公式サイトで無料登録し、メール認証を完了します。</li>
              <li>2. 管理画面の「API Keys」からAPIキーを発行します。</li>
              <li>3. 権限は「Full access」を選び、発行されたキーを一度だけ控えます。</li>
              <li>4. この画面の「Resend APIキー」欄へ貼り付けて保存します。</li>
            </ol>
            <p className="mt-4 text-xs text-amber-800">
              APIキーは第三者へ送らず、チャットや作業記録にも貼り付けないでください。
            </p>
            <button
              type="button"
              onClick={() => setShowResendGuide(false)}
              className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white"
            >
              手順を閉じる
            </button>
          </div>
        </div>
      )}

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
