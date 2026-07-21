'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { FriendFieldDefinition, Tag } from '@line-crm/shared'
import { api, downloadCsv } from '@/lib/api'
import type { FriendListItem } from '@/lib/api'
import { csvDateStamp } from '@/lib/download'
import Header from '@/components/layout/header'
import FriendListTable from '@/components/friends/friend-list-table'
import SavedSearchPanel from '@/components/friends/saved-search-panel'
import ExportCsvButton from '@/components/shared/export-csv-button'
import CcPromptButton from '@/components/cc-prompt-button'
import FriendFieldDefinitionsPanel from '@/components/friends/friend-field-definitions-panel'
import FollowersImportPanel from '@/components/friends/followers-import-panel'
import { useAccount } from '@/contexts/account-context'

const ccPrompts = [
  {
    title: '友だちのセグメント分析',
    prompt: `友だち一覧のデータを分析してください。
1. タグ別の友だち数を集計
2. アクティブ率の高いセグメントを特定
3. エンゲージメントが低い層への施策を提案
レポート形式で出力してください。`,
  },
  {
    title: 'タグ一括管理',
    prompt: `友だちのタグを一括管理してください。
1. 未タグの友だちを特定
2. 行動履歴に基づいたタグ付け提案
3. 不要タグの整理
作業手順を示してください。`,
  },
]

const PAGE_SIZE = 20

type SortMode = 'recent' | 'oldest'
type ResponseFilter = 'all' | 'unhandled'

export default function FriendsPage() {
  const { selectedAccountId } = useAccount()
  const [friends, setFriends] = useState<FriendListItem[]>([])
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searchSubmitted, setSearchSubmitted] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [responseFilter, setResponseFilter] = useState<ResponseFilter>('all')
  const [savedSearchId, setSavedSearchId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  const loadFriendsRequest = useRef(0)

  const loadTags = useCallback(async () => {
    try {
      const res = await api.tags.list()
      if (res.success) setAllTags(res.data)
    } catch {
      // Non-blocking — tags used for filter
    }
  }, [])

  const loadFieldDefinitions = useCallback(async () => {
    try {
      const res = await api.friendFieldDefinitions.list()
      if (res.success) setFieldDefinitions(res.data)
    } catch {
      // Fail-soft: definition management must not block the friend list.
      setFieldDefinitions([])
    }
  }, [])

  const loadFriends = useCallback(async () => {
    const requestId = ++loadFriendsRequest.current
    setLoading(true)
    setError('')
    try {
      const res = await api.friends.list({
        offset: String((page - 1) * PAGE_SIZE),
        limit: PAGE_SIZE,
        tagId: selectedTagId || undefined,
        accountId: selectedAccountId || undefined,
        search: searchSubmitted || undefined,
        includeChatStatus: true,
        sort: sortMode,
        handled: responseFilter === 'unhandled' ? 'unhandled' : undefined,
        savedSearchId: savedSearchId || undefined,
      })
      if (requestId !== loadFriendsRequest.current) return
      if (res.success) {
        setFriends(res.data.items)
        setTotal(res.data.total)
        setHasNextPage(res.data.hasNextPage)
      } else {
        setError(res.error)
      }
    } catch {
      if (requestId === loadFriendsRequest.current) {
        setError('友だちの読み込みに失敗しました。もう一度お試しください。')
      }
    } finally {
      if (requestId === loadFriendsRequest.current) setLoading(false)
    }
  }, [page, selectedTagId, selectedAccountId, searchSubmitted, sortMode, responseFilter, savedSearchId])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  useEffect(() => {
    void loadFieldDefinitions()
  }, [loadFieldDefinitions])

  // Reset the URL-style account context to page 1 in a separate effect.
  // For user-driven filter changes (search/sort/handled/tag) we reset
  // page synchronously inside the handlers below — that avoids the
  // double-fetch race where the old `page` request resolves after the
  // new `page=1` request and overwrites the correct page-1 rows.
  useEffect(() => {
    setPage(1)
  }, [selectedAccountId])

  useEffect(() => {
    void loadFriends()
  }, [loadFriends])

  // Fan-out helpers: changing a filter also resets pagination synchronously,
  // so React batches both state updates into one re-render and `loadFriends`
  // fires exactly once with the new filter + page=1.
  const updateAndResetPage = (cb: () => void) => {
    cb()
    setPage(1)
  }
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateAndResetPage(() => setSearchSubmitted(searchInput.trim()))
  }
  // Clearing the input clears the active search even if the user doesn't
  // press 検索 again. Without this, "search Alice → clear input → change
  // tag" would keep filtering by Alice while the input box looks empty —
  // see codex feedback. Keeping a non-empty input that doesn't match
  // searchSubmitted is fine: the user is mid-edit, hasn't applied yet.
  const handleSearchInputChange = (v: string) => {
    setSearchInput(v)
    if (v.trim() === '' && searchSubmitted !== '') {
      updateAndResetPage(() => setSearchSubmitted(''))
    }
  }
  // CSV 出力: 画面の絞り込み条件 (account/タグ/検索/対応マーク) をそのまま worker export に渡す。
  // 「未対応のみ」表示中は handled=unhandled も渡し、絞込ビューと CSV を食い違わせない (I-2)。
  const handleExportCsv = async () => {
    const params = new URLSearchParams()
    if (selectedAccountId) params.set('lineAccountId', selectedAccountId)
    if (selectedTagId) params.set('tagId', selectedTagId)
    if (searchSubmitted) params.set('search', searchSubmitted)
    if (responseFilter === 'unhandled') params.set('handled', 'unhandled')
    await downloadCsv(`/api/exports/friends.csv?${params}`, `友だち一覧_${csvDateStamp()}.csv`)
  }

  const handleSortChange = (v: SortMode) => updateAndResetPage(() => setSortMode(v))
  const handleResponseFilterChange = (v: ResponseFilter) => updateAndResetPage(() => setResponseFilter(v))
  const handleTagFilterChange = (v: string) => updateAndResetPage(() => setSelectedTagId(v))

  return (
    <div>
      <Header
        title="友だちリスト"
        description="友だちの検索や、詳細情報の確認ができます。"
      />

      {/* Search + sort bar — L-step style */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchInputChange(e.target.value)}
            placeholder="友だち名を検索"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <select
            value={sortMode}
            onChange={(e) => handleSortChange(e.target.value as SortMode)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="recent">友だち追加の新しい順</option>
            <option value="oldest">友だち追加の古い順</option>
          </select>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg text-white text-sm font-medium"
            style={{ backgroundColor: '#06C755' }}
          >
            検索
          </button>
        </form>

        {/* Secondary filters — タグ + 対応マーク */}
        <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 font-medium whitespace-nowrap">タグ:</label>
            <select
              className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              value={selectedTagId}
              onChange={(e) => handleTagFilterChange(e.target.value)}
            >
              <option value="">すべて</option>
              {allTags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 font-medium whitespace-nowrap">対応マーク:</label>
            <select
              className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              value={responseFilter}
              onChange={(e) => handleResponseFilterChange(e.target.value as ResponseFilter)}
            >
              <option value="all">すべて</option>
              <option value="unhandled">未対応のみ</option>
            </select>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <ExportCsvButton
              onExport={handleExportCsv}
              onError={setError}
              disabled={!selectedAccountId || total === 0}
            />
            <span className="text-xs text-gray-500">
              {loading ? '読み込み中...' : `${total.toLocaleString('ja-JP')} 件`}
            </span>
          </div>
        </div>

        {/* 保存済み検索 (G10) — 既存フィルタの上に AND で重なる絞込 */}
        <SavedSearchPanel
          accountId={selectedAccountId || null}
          tags={allTags}
          activeId={savedSearchId}
          onApply={(id) => updateAndResetPage(() => setSavedSearchId(id))}
        />
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 grid grid-cols-[80px_220px_120px_1fr_280px] gap-3 animate-pulse">
              <div className="h-5 bg-gray-100 rounded w-16" />
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-full bg-gray-200" />
                <div className="h-3 bg-gray-200 rounded w-24" />
              </div>
              <div className="h-3 bg-gray-100 rounded w-20" />
              <div className="space-y-2">
                <div className="h-3 bg-gray-100 rounded w-3/4" />
                <div className="h-2 bg-gray-100 rounded w-20" />
              </div>
              <div className="h-5 bg-gray-100 rounded w-32" />
            </div>
          ))}
        </div>
      ) : (
        <FriendListTable
          friends={friends}
          allTags={allTags}
          onRefresh={loadFriends}
          fieldDefinitions={fieldDefinitions}
        />
      )}

      {!loading && total > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mt-4">
          <p className="text-sm text-gray-500">
            {((page - 1) * PAGE_SIZE) + 1}〜{Math.min(page * PAGE_SIZE, total)} 件 / 全{total.toLocaleString('ja-JP')}件
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              前へ
            </button>
            <span className="text-sm text-gray-600 px-1">{page} ページ</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              次へ
            </button>
          </div>
        </div>
      )}

      <div className="mt-6" aria-label="友だち管理の補助設定">
        <details className="group mb-3">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800 shadow-sm transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
            <span>
              取り込み設定
              <span className="mt-0.5 block text-xs font-normal text-gray-500">以前からいる友だちを追加する時だけ開きます</span>
            </span>
            <svg aria-hidden="true" className="h-5 w-5 shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="mt-2">
            <FollowersImportPanel
              accountId={selectedAccountId || null}
              onCompleted={loadFriends}
            />
          </div>
        </details>

        <details id="friend-custom-fields" className="group scroll-mt-20">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800 shadow-sm transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
            <span>
              カスタムフィールド設定
              <span className="mt-0.5 block text-xs font-normal text-gray-500">友だち全員に共通する項目を管理します</span>
            </span>
            <svg aria-hidden="true" className="h-5 w-5 shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="mt-2">
            <FriendFieldDefinitionsPanel
              id="friend-custom-fields-panel"
              definitions={fieldDefinitions}
              onRefresh={loadFieldDefinitions}
            />
          </div>
        </details>
      </div>

      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
