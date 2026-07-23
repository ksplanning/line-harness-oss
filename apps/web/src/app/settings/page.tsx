'use client'

import { useState } from 'react'
import Header from '@/components/layout/header'
import EmailSenderSettingsPanel from '@/components/settings/email-sender-settings-panel'
import StaffNotificationSettingsPanel from '@/components/settings/staff-notification-settings-panel'
import { useAccount } from '@/contexts/account-context'

type SettingsSection = 'email-sender' | 'staff-notification'

const settingsSections: Array<{
  id: SettingsSection
  label: string
  description: string
}> = [
  {
    id: 'email-sender',
    label: 'メール差出人',
    description: '自動メールの差出人と DNS 認証を設定します。',
  },
  {
    id: 'staff-notification',
    label: 'スタッフ通知',
    description: '問い合わせや申込みを Chatwork・LINE へ通知します。',
  },
]

export default function SettingsPage() {
  const {
    accounts,
    selectedAccountId,
    setSelectedAccountId,
    loading,
  } = useAccount()
  const [activeSection, setActiveSection] = useState<SettingsSection>('email-sender')

  const activeLabel = settingsSections.find(
    (section) => section.id === activeSection,
  )?.label ?? ''

  return (
    <div>
      <Header
        title="通知設定"
        description="LINE アカウントごとのメール差出人とスタッフ通知を、ここでまとめて設定できます。"
      />

      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <label
          htmlFor="settings-line-account"
          className="block text-sm font-semibold text-gray-900"
        >
          設定する LINE アカウント
        </label>
        <p className="mt-1 text-sm text-gray-600">
          複数ある場合は、先に設定したいアカウントを選んでください。
        </p>
        <select
          id="settings-line-account"
          value={selectedAccountId ?? ''}
          onChange={(event) => {
            if (event.target.value) setSelectedAccountId(event.target.value)
          }}
          disabled={loading || accounts.length === 0}
          className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 disabled:bg-gray-100 disabled:text-gray-500 sm:max-w-md"
        >
          {loading && <option value="">アカウントを読み込んでいます...</option>}
          {!loading && accounts.length === 0 && (
            <option value="">選べるアカウントがありません</option>
          )}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName || account.name}
            </option>
          ))}
        </select>
      </section>

      <div
        role="group"
        aria-label="設定項目"
        className="mb-6 grid gap-3 sm:grid-cols-2"
      >
        {settingsSections.map((section) => {
          const active = section.id === activeSection
          return (
            <button
              key={section.id}
              type="button"
              aria-label={`${section.label}を開く`}
              aria-pressed={active}
              onClick={() => setActiveSection(section.id)}
              className={`min-h-[88px] rounded-xl border p-4 text-left transition-colors ${
                active
                  ? 'border-[#06C755] bg-green-50 ring-1 ring-[#06C755]'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <span className={`block text-sm font-semibold ${
                active ? 'text-green-800' : 'text-gray-900'
              }`}>
                {section.label}
              </span>
              <span className="mt-1 block text-xs leading-5 text-gray-600">
                {section.description}
              </span>
            </button>
          )
        })}
      </div>

      <section
        aria-label={`${activeLabel}の設定内容`}
        className="rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-6"
      >
        {activeSection === 'email-sender' ? (
          <EmailSenderSettingsPanel accountId={selectedAccountId} />
        ) : (
          <StaffNotificationSettingsPanel accountId={selectedAccountId} />
        )}
      </section>
    </div>
  )
}
