'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { EyeIcon, EyeOffIcon, LockIcon } from '@/components/shared/icons'

export default function LoginPage() {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [apiKeyOpen, setApiKeyOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  // 認証成功後の共通処理 (session 情報のキャッシュ + 遷移)。
  const onLoginResponse = async (res: Response) => {
    if (res.ok) {
      localStorage.removeItem('lh_api_key')
      try {
        const data = await res.json()
        if (data.success && data.data) {
          localStorage.setItem('lh_staff_name', data.data.name)
          localStorage.setItem('lh_staff_role', data.data.role)
        }
        if (data.csrfToken) localStorage.setItem('lh_csrf', data.csrfToken)
      } catch {
        // プロフィール/CSRF キャッシュは best-effort。
      }
      router.push('/')
      return
    }
    if (res.status === 403) {
      setError('しばらくしてからもう一度お試しください')
    } else if (res.status === 401) {
      // 汎用文言 (どちらが違うか言わない = 列挙攻撃を助けない)。
      setError('ログインIDまたはパスワードが正しくありません')
    } else {
      let message = 'ログインに失敗しました'
      try {
        const data = await res.json()
        if (data?.error) message = data.error
      } catch {
        // keep default
      }
      setError(message)
    }
  }

  const post = async (body: Record<string, string>) => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL
    if (!apiUrl) {
      setError('NEXT_PUBLIC_API_URL is not set in build env')
      return null
    }
    return fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await post({ loginId, password })
      if (res) await onLoginResponse(res)
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleApiKeyLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await post({ apiKey })
      if (res) await onLoginResponse(res)
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: '#06C755' }}>
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg mx-auto mb-3" style={{ backgroundColor: '#06C755' }}>
            H
          </div>
          <h1 className="text-xl font-bold text-gray-900">L Harness</h1>
          <p className="text-sm text-gray-500 mt-1">管理画面にログイン</p>
        </div>

        <form onSubmit={handleLogin}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">ログインID</label>
            <input
              type="text"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="ログインIDを入力"
              autoComplete="username"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              autoFocus
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="パスワードを入力"
                autoComplete="current-password"
                className="w-full px-4 py-3 pr-11 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 inline-flex items-center justify-center text-gray-400 hover:text-gray-600"
                aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

          <button
            type="submit"
            disabled={loading || !loginId || !password}
            className="w-full py-3 text-white font-medium rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            style={{ backgroundColor: '#06C755' }}
          >
            <LockIcon /> {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>

        {/* 並行期間: 旧 API キーログインを折りたたみで残す (owner 確認後に env flag で非表示)。 */}
        <div className="mt-5 pt-4 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setApiKeyOpen((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            {apiKeyOpen ? '▾' : '▸'} APIキーでログイン（従来の方法）
          </button>
          {apiKeyOpen && (
            <form onSubmit={handleApiKeyLogin} className="mt-3">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="APIキーを入力"
                autoComplete="off"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={loading || !apiKey}
                className="w-full mt-2 py-2.5 text-sm text-gray-700 font-medium rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              >
                APIキーでログイン
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
