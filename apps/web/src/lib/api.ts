import type {
  Friend,
  Tag,
  Scenario,
  ScenarioStep,
  FriendScenario,
  ApiResponse,
  PaginatedResponse,
  User,
  LineAccount,
  ConversionPoint,
  Affiliate,
  Template,
  Automation,
  AutomationLog,
  Chat,
  Reminder,
  ReminderStep,
  ScoringRule,
  IncomingWebhook,
  IncomingWebhookCreated,
  OutgoingWebhook,
  OutgoingWebhookCreated,
  NotificationRule,
  Notification,
  AccountHealthLog,
  AccountMigration,
  StaffMember,
  Role,
  StaffMe,
  Broadcast,
  BroadcastTargetType,
  EntryRoute,
  CreateEntryRouteInput,
  EntryRouteFunnel,
  TrafficPool,
  PoolAccount,
  FriendFieldDefinition,
} from '@line-crm/shared'
import { downloadBlob } from './download'

/**
 * 1 配信に束ねる 1 メッセージ (combo messages / broadcast-combo-messages Batch 2)。
 * worker 側 (apps/worker/src/routes/broadcasts.ts の MessageBlock) と同一形状。
 * messages[0] が message_type/message_content/alt_text に先頭ミラーされる。
 */
export interface MessageBlock {
  type: ApiBroadcast['messageType'];
  content: string;
  altText?: string | null;
}

export type TestSendSource =
  | 'broadcast'
  | 'greeting'
  | 'entry_greeting'
  | 'scenario'
  | 'template_pack'
  | 'reminder'

export interface TestSendMessage {
  type: string
  content: string
  altText?: string | null
}

export interface TestRecipient {
  id: string
  displayName: string
  pictureUrl: string | null
}

export interface TestSendResult {
  success: boolean
  sent?: number
  failed?: number
  deduplicated?: boolean
  error?: string
  capBlocked?: boolean
}

export interface FaqPersonalContextSettingsPayload {
  enabled: boolean
  /** null = all active custom fields; [] = none. */
  selectedCustomFieldIds: string[] | null
  includeFormAnswers: boolean
  maxTokens: number
}

/** Broadcast type from API (now camelCase after worker serialization) */
export type ApiBroadcast = Omit<Broadcast, 'targetType'> & {
  targetType: BroadcastTargetType;
  accountIds: string[] | null;
  dedupPriority: string[] | null;
  failedAccountIds: string[] | null;
  /** combo 配信の順序付きメッセージ列 (最大5)。NULL/未指定=従来 single。 */
  messages?: MessageBlock[] | null;
  /** Legacy single Flex notification text; combo blocks carry their own altText. */
  altText?: string | null;
};

export type BroadcastInsight = {
  broadcastId?: string
  delivered: number | null
  uniqueImpression: number | null
  uniqueClick: number | null
  uniqueMediaPlayed: number | null
  openRate: number | null
  clickRate: number | null
  status?: string
  fetchedAt?: string | null
}

const API_URL = process.env.NEXT_PUBLIC_API_URL
if (!API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Build cannot proceed without a valid API URL. ' +
    'Set it in .env.production (local) or GitHub Secrets (CI).'
  )
}

/**
 * Read the CSRF token issued at login. The session credential itself lives in
 * an HttpOnly cookie (never exposed to JS); only the CSRF token is held
 * client-side and echoed back via the X-CSRF-Token header on mutating
 * requests. In a cross-site topology the SPA cannot read the API's CSRF cookie
 * directly, so the token is delivered in the login/session response body and
 * cached here.
 */
export const CSRF_STORAGE_KEY = 'lh_csrf'

export function getCsrfToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(CSRF_STORAGE_KEY) || ''
}

export function setCsrfToken(token: string | undefined | null): void {
  if (typeof window === 'undefined' || !token) return
  localStorage.setItem(CSRF_STORAGE_KEY, token)
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  const csrfHeaders: Record<string, string> = {}
  if (MUTATING_METHODS.has(method)) {
    const token = getCsrfToken()
    if (token) csrfHeaders['X-CSRF-Token'] = token
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    // Send the HttpOnly session cookie with every request.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    // 4xx/5xx の JSON body を Error に添付する (caller が理由を出し分けられるように)。
    // 例: 429 通数上限ブロックは body.capBlocked / body.cap を UI が読む (G2)。
    // 既存の catch は body/status を無視するので後方互換。
    let body: unknown = undefined
    try { body = await res.json() } catch { /* 非 JSON エラー body は無視 */ }
    const err = new Error(`API error: ${res.status}`) as Error & { status?: number; body?: unknown }
    err.status = res.status
    err.body = body
    throw err
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/**
 * CSV エクスポート専用のダウンロード経路 (batch3 C6 / G39)。
 *
 * fetchApi は常に res.json() を呼ぶため CSV blob を受け取れない (JSON parse で落ちる)。
 * ここでは fetch を直接使い、admin(pages.dev)⇄worker(workers.dev) の cross-site でも
 * HttpOnly セッション cookie を送るため `credentials: 'include'` を付ける。
 * res.ok を確認し、400 (上限超過) 等は body の日本語エラーを Error として投げる
 * (呼び出し側 UI が error banner に出す)。成功時は blob を downloadBlob で保存する。
 */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { credentials: 'include' })
  if (!res.ok) {
    let message = 'CSV の出力に失敗しました。もう一度お試しください。'
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // non-JSON レスポンスはそのまま既定メッセージ
    }
    throw new Error(message)
  }
  const blob = await res.blob()
  downloadBlob(blob, filename)
}

export type FriendListParams = {
  offset?: string
  limit?: string | number
  tagId?: string
  accountId?: string
  search?: string
  /**
   * `false` でタグ enrich をスキップ。autocomplete 等で displayName/picture
   * しか使わない呼び出し向け。デフォルトは true（既存呼び出しの挙動維持）。
   */
  includeTags?: boolean
  /**
   * `true` で latestIncomingMessage / latestOutgoingAt / activeScenario /
   * handled を付与。L-step 風友だちリスト UI 用。デフォルトは false。
   */
  includeChatStatus?: boolean
  /** 並び替え。`oldest` で created_at ASC、未指定 / `recent` で DESC. */
  sort?: 'recent' | 'oldest'
  /** `unhandled` で「最新が未返信の incoming」だけに絞る (サーバ側 SQL filter). */
  handled?: 'unhandled'
  /** G10 保存済み検索: 指定時のみ保存条件を AND する。未指定は byte-identical. */
  savedSearchId?: string
}

/** G28 応答時間帯: 曜日別営業時間の 1 行 (day は 0=日..6=土 / getUTCDay 準拠)。 */
export interface DayHours {
  day: number
  closed: boolean
  open: string // 'HH:MM'
  close: string // 'HH:MM'
}
export type OutsideHoursMode = 'auto_reply' | 'away_message' | 'none'
export interface ResponseScheduleData {
  id: string | null
  lineAccountId: string | null
  isEnabled: boolean
  timezone: string
  outsideHoursMode: OutsideHoursMode
  awayMessage: string | null
  weeklyHours: DayHours[]
}

/** G10 保存済み検索: conditions は broadcast と同一の SegmentCondition JSON 文字列。 */
export interface SavedSearchData {
  id: string
  lineAccountId: string | null
  name: string
  conditions: string
  createdAt: string
  updatedAt: string
}

export interface CannedResponseData {
  id: string
  lineAccountId: string | null
  title: string
  content: string
  createdAt: string
  updatedAt: string
}

export type FriendWithTags = Friend & { tags: Tag[] }
export type FriendFieldDefinitionInput = Pick<
  FriendFieldDefinition,
  'name' | 'defaultValue' | 'displayOrder' | 'isActive'
>

export type RichMenuDisplayConditionType =
  | 'tag_exists'
  | 'tag_not_exists'
  | 'metadata_equals'
  | 'metadata_not_equals'
  | 'metadata_contains'
  | 'metadata_not_contains'
  | 'tag_name_contains'
  | 'tag_name_not_contains'

export interface RichMenuDisplayRule {
  id: string
  accountId: string
  name: string
  conditionType: RichMenuDisplayConditionType
  conditionValue: string
  richMenuId: string
  priority: number
  isActive: boolean
  activeFrom: string | null
  activeUntil: string | null
  createdAt: string
  updatedAt: string
}

export type RichMenuDisplayRuleInput = Pick<
  RichMenuDisplayRule,
  | 'name'
  | 'conditionType'
  | 'conditionValue'
  | 'richMenuId'
  | 'priority'
  | 'isActive'
  | 'activeFrom'
  | 'activeUntil'
>

export interface RichMenuRuleReapplyJob {
  id: string
  accountId: string
  status: 'running' | 'completed'
  totalCount: number
  processedCount: number
  appliedCount: number
  skippedCount: number
  failedCount: number
  lastFriendId: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface RichMenuDisplayRuleOptions {
  tags: Tag[]
  fields: FriendFieldDefinition[]
}
/** Friend list items, optionally hydrated with chat status (when ?includeChatStatus=true) */
export type FriendListItem = FriendWithTags & Partial<{
  latestIncomingMessage: { content: string; messageType: string; createdAt: string } | null
  latestOutgoingAt: string | null
  activeScenario: { name: string; status: string } | null
  handled: boolean
}>

export const api = {
  friendFieldDefinitions: {
    list: () =>
      fetchApi<ApiResponse<FriendFieldDefinition[]>>('/api/friend-field-definitions'),
    create: (input: FriendFieldDefinitionInput) =>
      fetchApi<ApiResponse<FriendFieldDefinition>>('/api/friend-field-definitions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, patch: Partial<FriendFieldDefinitionInput>) =>
      fetchApi<ApiResponse<FriendFieldDefinition>>(
        `/api/friend-field-definitions/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      ),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/friend-field-definitions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },
  richMenuDisplayRules: {
    options: (accountId: string) =>
      fetchApi<ApiResponse<RichMenuDisplayRuleOptions>>(
        `/api/rich-menu-display-rules/options?accountId=${encodeURIComponent(accountId)}`,
      ),
    list: (accountId: string) =>
      fetchApi<ApiResponse<RichMenuDisplayRule[]>>(
        `/api/rich-menu-display-rules?accountId=${encodeURIComponent(accountId)}`,
      ),
    create: (accountId: string, input: RichMenuDisplayRuleInput) =>
      fetchApi<ApiResponse<RichMenuDisplayRule>>(
        `/api/rich-menu-display-rules?accountId=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    update: (accountId: string, id: string, patch: Partial<RichMenuDisplayRuleInput>) =>
      fetchApi<ApiResponse<RichMenuDisplayRule>>(
        `/api/rich-menu-display-rules/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      ),
    delete: (accountId: string, id: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/rich-menu-display-rules/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),
    latestJob: (accountId: string) =>
      fetchApi<ApiResponse<RichMenuRuleReapplyJob | null>>(
        `/api/rich-menu-display-rules/reapply/latest?accountId=${encodeURIComponent(accountId)}`,
      ),
    startReapply: (accountId: string) =>
      fetchApi<ApiResponse<RichMenuRuleReapplyJob>>(
        `/api/rich-menu-display-rules/reapply?accountId=${encodeURIComponent(accountId)}`,
        { method: 'POST' },
      ),
  },
  friends: {
    list: (params?: FriendListParams) => {
      const query: Record<string, string> = {}
      if (params?.offset) query.offset = String(params.offset)
      if (params?.limit) query.limit = String(params.limit)
      if (params?.tagId) query.tagId = params.tagId
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.search) query.search = params.search
      if (params?.includeTags === false) query.includeTags = 'false'
      if (params?.includeChatStatus) query.includeChatStatus = 'true'
      if (params?.sort) query.sort = params.sort
      if (params?.handled) query.handled = params.handled
      if (params?.savedSearchId) query.savedSearchId = params.savedSearchId
      return fetchApi<ApiResponse<PaginatedResponse<FriendListItem>>>(
        '/api/friends?' + new URLSearchParams(query)
      )
    },
    get: (id: string) =>
      fetchApi<ApiResponse<FriendWithTags>>(`/api/friends/${id}`),
    count: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<{ count: number }>>('/api/friends/count' + query)
    },
    addTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tagId }),
      }),
    removeTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags/${tagId}`, {
        method: 'DELETE',
      }),
    richMenu: (id: string) =>
      fetchApi<ApiResponse<{ id: string | null; name: string | null; isDefault: boolean }>>(
        `/api/friends/${id}/rich-menu`,
      ),
    // G9 カスタム項目 (friend metadata) の手動編集。
    // worker PUT /api/friends/:id/metadata は {...existing, ...patch} の pure merge。
    // → patch には「追加/変更したキーのみ」を渡すこと (全 metadata を上書き送信すると
    //   worker には残るが将来 UI 側で消しかねないので、変更キーのみ送る規約で統一)。
    //   これにより UI 非表示の他キーは worker 側に残る (merge 保証 / T-A4)。
    updateMetadata: (id: string, patch: Record<string, string>) =>
      fetchApi<ApiResponse<FriendWithTags>>(`/api/friends/${encodeURIComponent(id)}/metadata`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
  },
  tags: {
    list: () =>
      fetchApi<ApiResponse<Tag[]>>('/api/tags'),
    create: (data: { name: string; color: string }) =>
      fetchApi<ApiResponse<Tag>>('/api/tags', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/tags/${id}`, { method: 'DELETE' }),
  },
  scenarios: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<(Scenario & { stepCount?: number })[]>>('/api/scenarios' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Scenario & { steps: ScenarioStep[] }>>(`/api/scenarios/${id}`),
    // シナリオ複製 (steps 含む深いコピー・is_active=false で作られる)。
    // accountId 指定時は worker 側 account 境界 guard に渡す (別 account の複製を防ぐ)。
    duplicate: (id: string, accountId?: string) => {
      const query = accountId ? `?lineAccountId=${encodeURIComponent(accountId)}` : ''
      return fetchApi<ApiResponse<Scenario & { steps: ScenarioStep[] }>>(
        `/api/scenarios/${id}/duplicate${query}`,
        { method: 'POST' },
      )
    },
    // G7 手動シナリオ登録 (指名移動)。worker POST /api/scenarios/:id/enroll/:friendId は
    // 「シナリオへの紐付け (friend_scenarios 行追加)」のみで送信は発火しない (挿入と送信の分離)。
    // 既登録は 409 を返す → 呼び側は success:false を見て「すでに登録されています」表示に切替える
    //   (fetchApi は res.ok=false 時 success:false を返すため握り潰されない / T-A1)。
    enroll: (scenarioId: string, friendId: string) =>
      fetchApi<ApiResponse<FriendScenario>>(
        `/api/scenarios/${encodeURIComponent(scenarioId)}/enroll/${encodeURIComponent(friendId)}`,
        { method: 'POST' },
      ),
    create: (data: Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>) =>
      fetchApi<ApiResponse<Scenario>>('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>>) =>
      fetchApi<ApiResponse<Scenario>>(`/api/scenarios/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}`, { method: 'DELETE' }),
    addStep: (
      id: string,
      data: {
        stepOrder: number
        messageType: ScenarioStep['messageType']
        messageContent: string
        delayMinutes?: number
        offsetDays?: number
        offsetMinutes?: number
        deliveryTime?: string
        templateId?: string | null
        onReachTagId?: string | null
        conditionType?: string | null
        conditionValue?: string | null
        nextStepOnFalse?: number | null
      },
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateStep: (
      id: string,
      stepId: string,
      data: {
        stepOrder?: number
        messageType?: ScenarioStep['messageType']
        messageContent?: string
        delayMinutes?: number
        offsetDays?: number
        offsetMinutes?: number
        deliveryTime?: string
        templateId?: string | null
        onReachTagId?: string | null
        conditionType?: string | null
        conditionValue?: string | null
        nextStepOnFalse?: number | null
      },
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteStep: (id: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'DELETE',
      }),
    reorderSteps: (id: string, orders: { stepId: string; stepOrder: number }[]) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orders }),
      }),
    preview: (id: string, startAt?: string) => {
      const q = startAt ? `?startAt=${encodeURIComponent(startAt)}` : ''
      return fetchApi<ApiResponse<{
        startAt: string
        steps: Array<{
          stepOrder: number
          deliveryAt: string
          deliveryAtLabel: string
          messageType: string
          messageContent: string
        }>
      }>>(`/api/scenarios/${id}/preview${q}`)
    },
    stats: (id: string) =>
      fetchApi<ApiResponse<{
        enrolledTotal: number
        activeNow: number
        completed: number
        paused: number
        steps: Array<{ stepOrder: number; reachedCount: number; reachRate: number }>
      }>>(`/api/scenarios/${id}/stats`),
  },
  broadcasts: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<ApiBroadcast[]>>('/api/broadcasts' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`),
    create: (data: {
      title: string
      messageType: ApiBroadcast['messageType']
      messageContent: string
      // combo: 順序付きメッセージ列 (最大5)。未指定=従来 single (後方互換)。先頭は messageType/messageContent にミラー。
      messages?: MessageBlock[]
      targetType: ApiBroadcast['targetType']
      targetTagId?: string | null
      scheduledAt?: string | null
      status?: ApiBroadcast['status']
      lineAccountId?: string | null
      accountIds?: string[]
      dedupPriority?: string[]
      senderPresetId?: string | null
      abTestId?: string | null
      abVariant?: string | null
    }) =>
      fetchApi<ApiResponse<ApiBroadcast>>('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        title?: string
        messageType?: ApiBroadcast['messageType']
        messageContent?: string
        // combo: 順序付きメッセージ列 (最大5)。指定時は worker が先頭ミラー + messages 更新 (combo 行の単一フィールド PUT は 400)。
        messages?: MessageBlock[]
        targetType?: ApiBroadcast['targetType']
        targetTagId?: string | null
        scheduledAt?: string | null
        senderPresetId?: string | null
        abTestId?: string | null
        abVariant?: string | null
      }
    ) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/broadcasts/${id}`, { method: 'DELETE' }),
    send: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send`, { method: 'POST' }),
    getInsight: (id: string) =>
      fetchApi<ApiResponse<BroadcastInsight | null>>(`/api/broadcasts/${id}/insight`),
    fetchInsight: (id: string) =>
      fetchApi<ApiResponse<BroadcastInsight>>(`/api/broadcasts/${id}/fetch-insight`, { method: 'POST' }),
    testSend: (id: string) =>
      fetchApi<{ success: boolean; sent?: number; failed?: number; error?: string }>(`/api/broadcasts/${id}/test-send`, { method: 'POST' }),
    getProgress: (id: string) =>
      fetchApi<{ success: boolean; data?: { status: string; totalCount: number; successCount: number; batchOffset: number } }>(`/api/broadcasts/${id}/progress`),
    previewCount: (id: string) =>
      fetchApi<{
        success: boolean;
        data?: {
          count: number;
          perAccount?: Array<{ accountId: string; sendCount: number }>;
        };
        error?: string;
      }>(`/api/broadcasts/${id}/preview-count`),
    perAccountStats: (id: string) =>
      fetchApi<{
        success: boolean;
        data?: Array<{
          accountId: string;
          accountName: string;
          sent: number;
          uniqueImpression: number | null;
          uniqueClick: number | null;
        }>;
        error?: string;
      }>(`/api/broadcasts/${id}/per-account-stats`),
    sendSegment: (id: string, conditions: unknown) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send-segment`, {
        method: 'POST',
        body: JSON.stringify({ conditions }),
      }),
    dedupPreview: (input: { accountIds: string[]; dedupPriority: string[]; targetTagId?: string | null }) =>
      fetchApi<{
        success: boolean;
        data?: {
          totalSelected: number;
          uniqueRecipients: number;
          reduction: number;
          reductionRate: number;
          perAccount: Array<{
            accountId: string;
            accountName: string;
            accountCountry: string | null;
            selectedCount: number;
            sendCount: number;
            excludedToHigherPriority: number;
          }>;
        };
        error?: string;
      }>('/api/broadcasts/dedup-preview', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },

  // G1 A/B テスト配信 (worker routes/ab-tests.ts)。実 A/B 送信・勝ち全配信は owner 立会 gated。
  abTests: {
    list: (accountId: string) =>
      fetchApi<ApiResponse<Array<{ id: string; accountId: string; name: string; metric: 'open_rate' | 'click_rate'; status: 'draft' | 'running' | 'decided'; winnerBroadcastId: string | null; createdAt: string; updatedAt: string }>>>(`/api/ab-tests?accountId=${encodeURIComponent(accountId)}`),
    create: (accountId: string, body: { name: string; metric: 'open_rate' | 'click_rate' }) =>
      fetchApi<ApiResponse<{ id: string; name: string; metric: string; status: string }>>(`/api/ab-tests?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, accountId: string, body: { name?: string; metric?: 'open_rate' | 'click_rate'; status?: 'draft' | 'running' | 'decided' }) =>
      fetchApi<ApiResponse<unknown>>(`/api/ab-tests/${id}?accountId=${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(`/api/ab-tests/${id}?accountId=${encodeURIComponent(accountId)}`, { method: 'DELETE' }),
    splitPreview: (id: string, accountId: string, conditions: unknown) =>
      fetchApi<{ success: boolean; data?: { total: number; counts: Record<string, number> }; note?: string; error?: string }>(`/api/ab-tests/${id}/split-preview?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', body: JSON.stringify({ conditions }) }),
    compare: (id: string, accountId: string) =>
      fetchApi<{ success: boolean; data?: { metric: string; variants: Array<{ variant: string; broadcastId: string; openRate: number | null; clickRate: number | null }>; winner: string | null; tie: boolean; dataPending: boolean } }>(`/api/ab-tests/${id}/compare?accountId=${encodeURIComponent(accountId)}`),
    winnerDraft: (id: string, accountId: string, winnerVariant: string) =>
      fetchApi<{ success: boolean; data?: { draftBroadcastId: string }; note?: string; error?: string }>(`/api/ab-tests/${id}/winner-draft?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', body: JSON.stringify({ winnerVariant }) }),
  },

  segments: {
    count: (conditions: unknown, accountId?: string) =>
      fetchApi<{ success: boolean; count?: number; error?: string }>('/api/segments/count', {
        method: 'POST',
        body: JSON.stringify({ conditions, accountId }),
      }),
  },

  // フォーム一覧 (G11 opened_form の対象フォーム選択用)。
  forms: {
    list: () =>
      fetchApi<ApiResponse<Array<{ id: string; name: string }>>>('/api/forms'),
    legacyUsage: () =>
      fetchApi<ApiResponse<{ formCount: number; submissionCount: number }>>('/api/forms/legacy/usage'),
  },

  accountSettings: {
    getTestRecipients: (accountId: string) =>
      fetchApi<ApiResponse<TestRecipient[]>>(
        `/api/account-settings/test-recipients?accountId=${encodeURIComponent(accountId)}`,
      ),
    updateTestRecipients: (accountId: string, friendIds: string[]) =>
      fetchApi<{ success: boolean; error?: string }>('/api/account-settings/test-recipients', {
        method: 'PUT',
        body: JSON.stringify({ accountId, friendIds }),
      }),
  },

  testSends: {
    getRecipients: (source: TestSendSource, accountId: string) =>
      fetchApi<ApiResponse<TestRecipient[]>>(
        `/api/test-sends/${source}/recipients?accountId=${encodeURIComponent(accountId)}`,
      ),
    send: (input: {
      accountId: string
      source: TestSendSource
      messages: TestSendMessage[]
      idempotencyKey: string
      senderPresetId?: string
    }) => fetchApi<TestSendResult>(`/api/test-sends/${input.source}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  },

  // G28 応答時間帯スケジュール
  responseSchedules: {
    get: (accountId: string) =>
      fetchApi<{ success: boolean; data: ResponseScheduleData }>(
        `/api/response-schedules?accountId=${encodeURIComponent(accountId)}`,
      ),
    save: (data: {
      accountId: string
      isEnabled: boolean
      outsideHoursMode: OutsideHoursMode
      awayMessage: string | null
      weeklyHours: DayHours[]
    }) =>
      fetchApi<{ success: boolean; data?: ResponseScheduleData; error?: string }>('/api/response-schedules', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },

  // G10 保存済み検索 (セグメント)
  savedSearches: {
    list: (accountId?: string) =>
      fetchApi<{ success: boolean; data: SavedSearchData[] }>(
        '/api/saved-searches' + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
      ),
    create: (data: { name: string; conditions: unknown; accountId?: string | null }) =>
      fetchApi<{ success: boolean; data?: SavedSearchData; error?: string }>('/api/saved-searches', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    rename: (id: string, name: string, accountId?: string | null) =>
      fetchApi<{ success: boolean; data?: SavedSearchData; error?: string }>(
        `/api/saved-searches/${id}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
        {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        },
      ),
    remove: (id: string, accountId?: string | null) =>
      fetchApi<{ success: boolean }>(
        `/api/saved-searches/${id}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
        {
          method: 'DELETE',
        },
      ),
  },

  // G23 チャット定型文 (canned responses) — 個別チャットに差し込む定型文の CRUD
  cannedResponses: {
    list: (accountId?: string | null) =>
      fetchApi<{ success: boolean; data: CannedResponseData[] }>(
        '/api/canned-responses' + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
      ),
    create: (data: { title: string; content: string; accountId?: string | null }) =>
      fetchApi<{ success: boolean; data?: CannedResponseData; error?: string }>('/api/canned-responses', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { title?: string; content?: string }, accountId?: string | null) =>
      fetchApi<{ success: boolean; data?: CannedResponseData; error?: string }>(
        `/api/canned-responses/${id}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        },
      ),
    remove: (id: string, accountId?: string | null) =>
      fetchApi<{ success: boolean }>(
        `/api/canned-responses/${id}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
        {
          method: 'DELETE',
        },
      ),
  },

  // ── Round 2 APIs ─────────────────────────────────────────────────────────
  users: {
    list: () =>
      fetchApi<ApiResponse<User[]>>('/api/users'),
    get: (id: string) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`),
    create: (data: { email?: string | null; phone?: string | null; externalId?: string | null; displayName?: string | null }) =>
      fetchApi<ApiResponse<User>>('/api/users', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<User, 'email' | 'phone' | 'externalId' | 'displayName'>>) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${id}`, { method: 'DELETE' }),
    link: (userId: string, friendId: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${userId}/link`, {
        method: 'POST',
        body: JSON.stringify({ friendId }),
      }),
    accounts: (userId: string) =>
      fetchApi<ApiResponse<{ id: string; lineUserId: string; displayName: string | null; isFollowing: boolean }[]>>(
        `/api/users/${userId}/accounts`,
      ),
  },
  lineAccounts: {
    list: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    get: (id: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`),
    // G2 配信通数の月次上限。表示 (messagesThisMonth) と gate は同一計測。cap=null=無制限。
    getMonthlyCap: (id: string) =>
      fetchApi<ApiResponse<{ monthlyCap: number | null; messagesThisMonth: number; remaining: number | null }>>(`/api/line-accounts/${id}/monthly-cap`),
    updateMonthlyCap: (id: string, monthlyCap: number | null) =>
      fetchApi<ApiResponse<{ monthlyCap: number | null }>>(`/api/line-accounts/${id}/monthly-cap`, { method: 'PATCH', body: JSON.stringify({ monthlyCap }) }),
    create: (data: {
      channelId: string;
      name: string;
      channelAccessToken: string;
      channelSecret: string;
      loginChannelId?: string | null;
      loginChannelSecret?: string | null;
      liffId?: string | null;
    }) =>
      fetchApi<ApiResponse<LineAccount>>('/api/line-accounts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    // Smart method routing:
    //   - rotating Messaging credentials (channelAccessToken / channelSecret)
    //     requires PUT (owner-only on the worker)
    //   - everything else routes to PATCH (admin-allowed)
    // This keeps a single helper signature for callers (toggle, country/role
    // edit, the edit modal) while letting admin users actually save the
    // non-credential changes. Without this, admin saves on the edit modal
    // would 403 even though the worker has a PATCH route that would accept
    // them.
    update: (
      id: string,
      data: Partial<
        Pick<
          LineAccount,
          | 'name'
          | 'channelAccessToken'
          | 'channelSecret'
          | 'loginChannelId'
          | 'loginChannelSecret'
          | 'liffId'
          | 'isActive'
          | 'country'
          | 'role'
        >
      >,
    ) => {
      const touchesMessagingCredentials =
        data.channelAccessToken !== undefined || data.channelSecret !== undefined
      return fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`, {
        method: touchesMessagingCredentials ? 'PUT' : 'PATCH',
        body: JSON.stringify(data),
      })
    },
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/line-accounts/${id}`, { method: 'DELETE' }),
    updateOrder: (ordered: Array<{ id: string; displayOrder: number }>) =>
      fetchApi<{ success: boolean; error?: string }>('/api/line-accounts/order', {
        method: 'PATCH',
        body: JSON.stringify({ ordered }),
      }),
  },
  conversions: {
    points: () =>
      fetchApi<ApiResponse<ConversionPoint[]>>('/api/conversions/points'),
    createPoint: (data: { name: string; eventType: string; value?: number | null }) =>
      fetchApi<ApiResponse<ConversionPoint>>('/api/conversions/points', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deletePoint: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/conversions/points/${id}`, { method: 'DELETE' }),
    track: (data: { conversionPointId: string; friendId: string; userId?: string | null; affiliateCode?: string | null; metadata?: Record<string, unknown> | null }) =>
      fetchApi<ApiResponse<unknown>>('/api/conversions/track', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    report: (params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ conversionPointId: string; conversionPointName: string; eventType: string; totalCount: number; totalValue: number }[]>>(
        '/api/conversions/report?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  affiliates: {
    list: () =>
      fetchApi<ApiResponse<Affiliate[]>>('/api/affiliates'),
    get: (id: string) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`),
    create: (data: { name: string; code: string; commissionRate?: number }) =>
      fetchApi<ApiResponse<Affiliate>>('/api/affiliates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Affiliate, 'name' | 'commissionRate' | 'isActive'>>) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/affiliates/${id}`, { method: 'DELETE' }),
    report: (id: string, params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ affiliateId: string; affiliateName: string; code: string; commissionRate: number; totalClicks: number; totalConversions: number; totalRevenue: number }>>(
        `/api/affiliates/${id}/report?` + new URLSearchParams(params as Record<string, string>),
      ),
  },
  templates: {
    list: (category?: string) =>
      fetchApi<ApiResponse<Array<{
        id: string;
        name: string;
        category: string;
        messageType: string;
        messageContent: string;
        usageCount: number;
        createdAt: string;
        updatedAt: string;
      }>>>(
        '/api/templates' + (category ? '?' + new URLSearchParams({ category }) : ''),
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<{
        id: string;
        name: string;
        category: string;
        messageType: string;
        messageContent: string;
        usedBy: {
          autoReplies: Array<{ id: string; keyword: string; matchType: 'exact' | 'contains'; lineAccountId: string | null }>;
          automations: Array<{ id: string; name: string; eventType: string }>;
        };
        createdAt: string;
        updatedAt: string;
      }>>(
        `/api/templates/${id}`,
      ),
    create: (data: { name: string; category: string; messageType: string; messageContent: string }) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        '/api/templates',
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (id: string, data: Partial<{ name: string; category: string; messageType: string; messageContent: string }>) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        `/api/templates/${id}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}`, { method: 'DELETE' }),
    usages: (id: string) =>
      fetchApi<ApiResponse<{
        autoReplies: Array<{ id: string; keyword: string; lineAccountId: string | null }>;
        scenarioSteps: Array<{ scenarioId: string; scenarioName: string; stepId: string; stepOrder: number }>;
      }>>(`/api/templates/${id}/usages`),
  },
  autoReplies: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?accountId=' + encodeURIComponent(params.accountId) : ''
      return fetchApi<ApiResponse<Array<{
        id: string;
        keyword: string;
        matchType: 'exact' | 'contains';
        responseType: string;
        responseContent: string;
        templateId: string | null;
        lineAccountId: string | null;
        isActive: boolean;
        createdAt: string;
        effectiveAccounts?: Array<{
          accountId: string;
          accountName: string;
          status: 'reply' | 'silent' | 'not_applicable';
          via: 'inline' | 'automation' | null;
        }>;
      }>>>('/api/auto-replies' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<{
        id: string;
        keyword: string;
        matchType: 'exact' | 'contains';
        responseType: string;
        responseContent: string;
        templateId: string | null;
        lineAccountId: string | null;
        isActive: boolean;
        createdAt: string;
      }>>(`/api/auto-replies/${id}`),
    create: (body: {
      keyword: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      templateId?: string | null;
      lineAccountId?: string | null;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>('/api/auto-replies', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: string, body: {
      keyword?: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      templateId?: string | null;
      lineAccountId?: string | null;
      isActive?: boolean;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/auto-replies/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/auto-replies/${id}`, {
        method: 'DELETE',
      }),
  },
  faqs: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?accountId=' + encodeURIComponent(params.accountId) : ''
      return fetchApi<ApiResponse<Array<{
        id: string;
        lineAccountId: string | null;
        question: string;
        variants: string[];
        answer: string;
        isActive: boolean;
        hitCount: number;
        createdAt: string;
        updatedAt: string;
      }>>>('/api/faqs' + query)
    },
    create: (body: {
      question: string;
      variants?: string[];
      answer: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>('/api/faqs', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: string, body: {
      question?: string;
      variants?: string[];
      answer?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/faqs/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/faqs/${id}`, { method: 'DELETE' }),
    unmatched: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?accountId=' + encodeURIComponent(params.accountId) : ''
      return fetchApi<ApiResponse<Array<{
        id: string;
        lineAccountId: string | null;
        friendId: string | null;
        question: string;
        topScore: number | null;
        resolvedFaqId: string | null;
        createdAt: string;
      }>>>('/api/faqs/unmatched' + query)
    },
    personalContextFields: () =>
      fetchApi<ApiResponse<Array<{ id: string; name: string }>>>(
        '/api/faqs/personal-context-fields',
      ),
    createFromUnmatched: (id: string, body: {
      answer: string;
      variants?: string[];
      question?: string;
      lineAccountId?: string | null;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/faqs/from-unmatched/${id}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // 一括登録 (A+)。fetchApi が CSRF を自動付与 (api.ts:87-92)。
    bulk: (body: {
      lineAccountId: string | null;
      items: Array<{
        question: string;
        variants?: string[];
        answer: string;
        isActive?: boolean;
        mode?: 'create' | 'overwrite';
        overwriteId?: string;
      }>;
    }) =>
      fetchApi<ApiResponse<{
        created: number;
        updated: number;
        skipped: number;
        errors: number;
        results: Array<{
          index: number;
          status: 'created' | 'updated' | 'skipped' | 'error';
          faqId?: string;
          error?: string;
        }>;
      }>>('/api/faqs/bulk', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    settings: {
      get: (params: { accountId: string }) =>
        fetchApi<ApiResponse<{
          enabled: boolean;
          threshold: number;
          handoffMessage: string;
          autoReplyNotice: string;
          maxRepliesPerDay: number;
          // 'draft'=草案保存のみ / 'auto'=自動送信 (worker faqs.ts:27)。
          answerMode: 'draft' | 'auto';
          personalContext: FaqPersonalContextSettingsPayload;
        }>>(`/api/account-settings/faq-bot?accountId=${encodeURIComponent(params.accountId)}`),
      put: (body: {
        accountId: string;
        enabled: boolean;
        threshold: number;
        handoffMessage: string;
        autoReplyNotice: string;
        maxRepliesPerDay: number;
        // PUT は部分更新でない — 全フィールド (answerMode 含む) を現在値のまま送る。
        answerMode: 'draft' | 'auto';
        personalContext: FaqPersonalContextSettingsPayload;
      }) =>
        fetchApi<ApiResponse<{
          enabled: boolean;
          threshold: number;
          handoffMessage: string;
          autoReplyNotice: string;
          maxRepliesPerDay: number;
          answerMode: 'draft' | 'auto';
          personalContext: FaqPersonalContextSettingsPayload;
        }>>('/api/account-settings/faq-bot', {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
    },
  },
  // B-5 取込ナレッジ管理 (資料 upload/一覧/削除/再取込 + AI ログ/コスト)。permission=faq (knowledge prefix)。
  knowledge: {
    // 取込 (kind=text: 抽出済テキスト or 貼付 / kind=url: URL 取込)。accountId は必須 (POST スコープ)。
    ingest: (body: { accountId: string; kind: 'text' | 'url'; content?: string; url?: string; title?: string }) =>
      fetchApi<ApiResponse<{ id: string; sourceType: string; chunkCount: number }>>(
        `/api/knowledge/ingest?accountId=${encodeURIComponent(body.accountId)}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    documents: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?accountId=' + encodeURIComponent(params.accountId) : ''
      return fetchApi<ApiResponse<Array<{
        id: string; lineAccountId: string | null; sourceType: 'url' | 'text'; sourceUrl: string | null;
        title: string | null; createdAt: string; updatedAt: string; chunkCount: number; embeddedCount: number;
      }>>>('/api/knowledge/documents' + query)
    },
    deleteDocument: (id: string, accountId?: string | null) =>
      fetchApi<ApiResponse<null>>(
        `/api/knowledge/documents/${encodeURIComponent(id)}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
        { method: 'DELETE' },
      ),
    reingest: (id: string, accountId?: string | null) =>
      fetchApi<{ success: boolean; data?: { id: string; chunkCount: number }; error?: string; reason?: string }>(
        `/api/knowledge/documents/${encodeURIComponent(id)}/reingest` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''),
        { method: 'POST' },
      ),
    aiUsage: (params: { accountId?: string | null; days?: number }) => {
      const p = new URLSearchParams()
      if (params.accountId) p.set('accountId', params.accountId)
      if (params.days) p.set('days', String(params.days))
      const qs = p.toString()
      return fetchApi<ApiResponse<{
        account: Array<{ usageDate: string; llmNeurons: number; embedNeurons: number; imageNeurons: number; replyCount: number }>;
        global: Array<{ usageDate: string; llmNeurons: number; embedNeurons: number; imageNeurons: number; replyCount: number }>;
        embeddedChunks: number;
      }>>(`/api/knowledge/ai-usage${qs ? `?${qs}` : ''}`)
    },
    aiDrafts: (params: { accountId?: string | null; status?: string; limit?: number }) => {
      const p = new URLSearchParams()
      if (params.accountId) p.set('accountId', params.accountId)
      if (params.status) p.set('status', params.status)
      if (params.limit) p.set('limit', String(params.limit))
      const qs = p.toString()
      return fetchApi<ApiResponse<Array<{ id: string; question: string; draftAnswer: string; status: string; createdAt: string }>>>(
        `/api/knowledge/ai-drafts${qs ? `?${qs}` : ''}`,
      )
    },
  },
  automations: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<Automation[]>>('/api/automations' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Automation & { logs?: AutomationLog[] }>>(`/api/automations/${id}`),
    create: (data: {
      name: string
      eventType: Automation['eventType']
      actions: Automation['actions']
      description?: string | null
      conditions?: Record<string, unknown>
      priority?: number
      lineAccountId?: string | null
    }) =>
      fetchApi<ApiResponse<Automation>>('/api/automations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Automation, 'name' | 'description' | 'eventType' | 'conditions' | 'actions' | 'isActive' | 'priority'>>) =>
      fetchApi<ApiResponse<Automation>>(`/api/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/automations/${id}`, { method: 'DELETE' }),
    logs: (id: string, limit?: number) =>
      fetchApi<ApiResponse<AutomationLog[]>>(
        `/api/automations/${id}/logs` + (limit ? `?limit=${limit}` : ''),
      ),
  },
  chats: {
    list: (params?: { status?: string; operatorId?: string; accountId?: string; unansweredOnly?: boolean }) => {
      const query: Record<string, string> = {}
      if (params?.status) query.status = params.status
      if (params?.operatorId) query.operatorId = params.operatorId
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.unansweredOnly) query.unansweredOnly = '1'
      return fetchApi<ApiResponse<Chat[]>>(
        '/api/chats?' + new URLSearchParams(query),
      )
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Chat & { messages?: { id: string; content: string; senderType: string; createdAt: string }[] }>>(
        `/api/chats/${id}`,
      ),
    create: (data: { friendId: string; operatorId?: string | null }) =>
      fetchApi<ApiResponse<Chat>>('/api/chats', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { operatorId?: string | null; status?: Chat['status']; notes?: string | null }) =>
      fetchApi<ApiResponse<Chat>>(`/api/chats/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    send: (id: string, data: { content: string; messageType?: string }) =>
      fetchApi<ApiResponse<unknown>>(`/api/chats/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  reminders: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<Reminder[]>>('/api/reminders' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Reminder & { steps: ReminderStep[] }>>(`/api/reminders/${id}`),
    create: (data: { name: string; description?: string | null; lineAccountId?: string | null }) =>
      fetchApi<ApiResponse<Reminder>>('/api/reminders', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Reminder, 'name' | 'description' | 'isActive'>>) =>
      fetchApi<ApiResponse<Reminder>>(`/api/reminders/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: { offsetMinutes: number; messageType: string; messageContent: string }) =>
      fetchApi<ApiResponse<ReminderStep>>(`/api/reminders/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteStep: (reminderId: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${reminderId}/steps/${stepId}`, {
        method: 'DELETE',
      }),
    // 友だち手動登録 (G57) — worker reminders.ts の enroll/friend-reminders route を叩く。
    // 登録一覧は worker が「友だち別」(GET /api/friends/:friendId/reminders) しか持たないため
    // listEnrollments(friendId) として実装 (リマインダ別一覧は worker 未対応 = batch1 スコープ外)。
    enroll: (reminderId: string, friendId: string, body: { targetDate: string }) =>
      fetchApi<ApiResponse<FriendReminderEnrollment>>(
        `/api/reminders/${reminderId}/enroll/${friendId}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    unenroll: (enrollmentId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friend-reminders/${enrollmentId}`, { method: 'DELETE' }),
    listEnrollments: (friendId: string) =>
      fetchApi<ApiResponse<FriendReminderEnrollment[]>>(`/api/friends/${friendId}/reminders`),
  },
  scoring: {
    rules: () =>
      fetchApi<ApiResponse<ScoringRule[]>>('/api/scoring-rules'),
    getRule: (id: string) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`),
    createRule: (data: { name: string; eventType: string; scoreValue: number }) =>
      fetchApi<ApiResponse<ScoringRule>>('/api/scoring-rules', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRule: (id: string, data: Partial<Pick<ScoringRule, 'name' | 'eventType' | 'scoreValue' | 'isActive'>>) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteRule: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scoring-rules/${id}`, { method: 'DELETE' }),
    friendScore: (friendId: string) =>
      fetchApi<ApiResponse<{ totalScore: number; history: { id: string; scoreChange: number; reason: string | null; createdAt: string }[] }>>(
        `/api/friends/${friendId}/score`,
      ),
  },
  webhooks: {
    incoming: {
      list: () =>
        fetchApi<ApiResponse<IncomingWebhook[]>>('/api/webhooks/incoming'),
      create: (data: { name: string; sourceType?: string; secret: string }) =>
        fetchApi<ApiResponse<IncomingWebhookCreated>>('/api/webhooks/incoming', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<IncomingWebhook, 'name' | 'sourceType' | 'isActive'>> & { secret?: string }) =>
        fetchApi<ApiResponse<IncomingWebhook>>(`/api/webhooks/incoming/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/incoming/${id}`, { method: 'DELETE' }),
    },
    outgoing: {
      list: () =>
        fetchApi<ApiResponse<OutgoingWebhook[]>>('/api/webhooks/outgoing'),
      create: (data: { name: string; url: string; eventTypes: string[]; secret: string }) =>
        fetchApi<ApiResponse<OutgoingWebhookCreated>>('/api/webhooks/outgoing', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<OutgoingWebhook, 'name' | 'url' | 'eventTypes' | 'isActive'>> & { secret?: string }) =>
        fetchApi<ApiResponse<OutgoingWebhook>>(`/api/webhooks/outgoing/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/outgoing/${id}`, { method: 'DELETE' }),
    },
  },
  notifications: {
    rules: {
      list: () =>
        fetchApi<ApiResponse<NotificationRule[]>>('/api/notifications/rules'),
      get: (id: string) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`),
      create: (data: { name: string; eventType: string; conditions?: Record<string, unknown>; channels?: string[] }) =>
        fetchApi<ApiResponse<NotificationRule>>('/api/notifications/rules', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<NotificationRule, 'name' | 'eventType' | 'conditions' | 'channels' | 'isActive'>>) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/notifications/rules/${id}`, { method: 'DELETE' }),
    },
    list: (params?: { status?: string; limit?: string }) =>
      fetchApi<ApiResponse<Notification[]>>(
        '/api/notifications?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  health: {
    accounts: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    getHealth: (accountId: string) =>
      fetchApi<ApiResponse<{ riskLevel: string; logs: AccountHealthLog[] }>>(
        `/api/accounts/${accountId}/health`,
      ),
    migrations: () =>
      fetchApi<ApiResponse<AccountMigration[]>>('/api/accounts/migrations'),
    migrate: (fromAccountId: string, data: { toAccountId: string }) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/${fromAccountId}/migrate`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getMigration: (migrationId: string) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/migrations/${migrationId}`),
  },
  staff: {
    list: () =>
      fetchApi<ApiResponse<StaffMember[]>>('/api/staff'),
    get: (id: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`),
    me: () =>
      fetchApi<ApiResponse<StaffMe>>('/api/staff/me'),
    create: (data: { name: string; email?: string; role: 'admin' | 'staff'; roleId?: string | null }) =>
      fetchApi<ApiResponse<StaffMember>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; email?: string | null; role?: string; isActive?: boolean; roleId?: string | null }) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/staff/${id}`, { method: 'DELETE' }),
    regenerateKey: (id: string) =>
      fetchApi<ApiResponse<{ apiKey: string }>>(`/api/staff/${id}/regenerate-key`, { method: 'POST' }),
  },
  roles: {
    list: () =>
      fetchApi<ApiResponse<Role[]>>('/api/roles'),
    get: (id: string) =>
      fetchApi<ApiResponse<Role>>(`/api/roles/${id}`),
    create: (data: { name: string; description?: string | null; template?: string; permissions?: Record<string, boolean> }) =>
      fetchApi<ApiResponse<Role>>('/api/roles', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; description?: string | null }) =>
      fetchApi<ApiResponse<Role>>(`/api/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    setPermissions: (id: string, permissions: Record<string, boolean>) =>
      fetchApi<ApiResponse<Role>>(`/api/roles/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) }),
    delete: (id: string, reassignTo: string | null) =>
      fetchApi<ApiResponse<null>>(`/api/roles/${id}`, { method: 'DELETE', body: JSON.stringify({ reassignTo }) }),
  },
  usersGrouped: {
    list: (opts?: {
      q?: string;
      onlyDups?: boolean;
      account?: string;
      page?: number;
      pageSize?: number;
      forceRefresh?: boolean;
    }) => {
      const p = new URLSearchParams();
      if (opts?.q) p.set('q', opts.q);
      if (opts?.onlyDups) p.set('onlyDups', '1');
      if (opts?.account) p.set('account', opts.account);
      if (opts?.page) p.set('page', String(opts.page));
      if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
      if (opts?.forceRefresh) p.set('refresh', '1');
      const qs = p.toString();
      return fetchApi<ApiResponse<{
        total: number;
        page: number;
        pageSize: number;
        computedAt: string;
        rows: Array<{
          identityKey: string;
          identityKeyKind: 'url_token' | 'uid' | 'solo';
          displayName: string | null;
          pictureUrl: string | null;
          accounts: Array<{
            accountId: string;
            accountName: string;
            lineUserId: string;
            isFollowing: boolean;
            joinedAt: string;
            friendId: string;
          }>;
          xUsername: string | null;
          emails: string[];
          phones: string[];
          lastActivityAt: string;
          isDuplicate: boolean;
        }>;
      }>>(`/api/users-grouped${qs ? `?${qs}` : ''}`);
    },
  },
  inbox: {
    unanswered: {
      list: (opts?: {
        q?: string;
        account?: string;
        minWaitMinutes?: number;
        page?: number;
        pageSize?: number;
      }) => {
        const p = new URLSearchParams();
        if (opts?.q) p.set('q', opts.q);
        if (opts?.account) p.set('account', opts.account);
        if (opts?.minWaitMinutes) p.set('minWaitMinutes', String(opts.minWaitMinutes));
        if (opts?.page) p.set('page', String(opts.page));
        if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
        const qs = p.toString();
        return fetchApi<ApiResponse<{
          total: number;
          page: number;
          pageSize: number;
          rows: Array<{
            friendId: string;
            displayName: string | null;
            pictureUrl: string | null;
            accountId: string;
            accountName: string;
            lastIncomingAt: string;
            lastManualAt: string | null;
            lastMachineAt: string | null;
            lastIncomingType: string;
            lastIncomingContent: string;
          }>;
        }>>(`/api/inbox/unanswered${qs ? `?${qs}` : ''}`);
      },
      count: () =>
        fetchApi<ApiResponse<{
          total: number;
          byAccount: Array<{ accountId: string; accountName: string; count: number }>;
          oldestWaitMinutes: number | null;
        }>>('/api/inbox/unanswered/count'),
    },
  },
  richMenuGroups: {
    list: (accountId: string) =>
      fetchApi<ApiResponse<Array<{
        id: string;
        accountId: string;
        name: string;
        chatBarText: string;
        size: 'large' | 'compact';
        defaultPageId: string | null;
        isDefaultForAll: boolean;
        status: 'draft' | 'published';
        publishingAt: string | null;
        scheduleStart: string | null;
        scheduleEnd: string | null;
        thumbnailR2Key: string | null;
        createdAt: string;
        updatedAt: string;
      }>>>(`/api/rich-menu-groups?accountId=${encodeURIComponent(accountId)}`),

    get: (groupId: string) =>
      fetchApi<ApiResponse<{
        id: string;
        accountId: string;
        name: string;
        chatBarText: string;
        size: 'large' | 'compact';
        defaultPageId: string | null;
        isDefaultForAll: boolean;
        status: 'draft' | 'published';
        publishingAt: string | null;
        createdAt: string;
        updatedAt: string;
        pages: Array<{
          id: string;
          orderIndex: number;
          name: string;
          aliasId: string;
          lineRichmenuId: string | null;
          imageR2Key: string | null;
          imageContentType: string | null;
          areas: Array<{
            id: string;
            boundsX: number;
            boundsY: number;
            boundsWidth: number;
            boundsHeight: number;
            actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch';
            actionData: Record<string, unknown>;
          }>;
        }>;
      }>>(`/api/rich-menu-groups/${groupId}`),

    create: (input: {
      accountId: string;
      name: string;
      chatBarText: string;
      size: 'large' | 'compact';
      pages: Array<{
        id?: string;
        name: string;
        orderIndex: number;
        areas: Array<{
          boundsX: number;
          boundsY: number;
          boundsWidth: number;
          boundsHeight: number;
          actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch';
          actionData: Record<string, unknown>;
        }>;
      }>;
    }) =>
      fetchApi<ApiResponse<{ id: string; pages: Array<{ id: string }> }>>('/api/rich-menu-groups', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    update: (groupId: string, input: {
      name?: string;
      chatBarText?: string;
      isDefaultForAll?: boolean;
      pages?: Array<{
        id?: string;
        name: string;
        orderIndex: number;
        areas: Array<{
          boundsX: number;
          boundsY: number;
          boundsWidth: number;
          boundsHeight: number;
          actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch';
          actionData: Record<string, unknown>;
        }>;
      }>;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/rich-menu-groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    delete: (groupId: string, opts?: { force?: boolean }) =>
      fetchApi<ApiResponse<null>>(
        `/api/rich-menu-groups/${groupId}${opts?.force ? '?force=true' : ''}`,
        { method: 'DELETE' },
      ),

    // G17 期間限定リッチメニュー。日時を保存するだけ (自動切替は dark-ship・owner 立会後に有効化)。
    updateSchedule: (groupId: string, accountId: string, body: { scheduleStart: string | null; scheduleEnd: string | null }) =>
      fetchApi<ApiResponse<unknown>>(`/api/rich-menu-groups/${groupId}/schedule?accountId=${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify(body) }),

    publish: (groupId: string) =>
      fetchApi<ApiResponse<{ pages: Array<{ pageId: string; newRichMenuId: string }> }>>(
        `/api/rich-menu-groups/${groupId}/publish`,
        { method: 'POST' },
      ),

    unpublish: (groupId: string) =>
      fetchApi<ApiResponse<{
        pages: Array<{ pageId: string; clearedRichMenuId: string | null }>;
        warnings: string[];
      }>>(`/api/rich-menu-groups/${groupId}/unpublish`, { method: 'POST' }),

    external: (accountId: string) =>
      fetchApi<ApiResponse<{
        currentDefault: string | null;
        lineMenus: Array<{
          richMenuId: string;
          name: string;
          chatBarText: string;
          size: { width: number; height: number };
          areasCount: number;
          isCurrentDefault: boolean;
          adminManaged: boolean;
          adminInfo: {
            groupId: string;
            groupName: string;
            pageName: string;
            groupStatus: 'draft' | 'published';
          } | null;
        }>;
      }>>(`/api/rich-menu-groups/external?accountId=${encodeURIComponent(accountId)}`),

    deleteExternal: (richMenuId: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/rich-menu-groups/external/${richMenuId}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),

    importFromLine: (richMenuId: string, accountId: string) =>
      fetchApi<ApiResponse<{ id: string; name: string }>>(
        `/api/rich-menu-groups/import?accountId=${encodeURIComponent(accountId)}&richMenuId=${encodeURIComponent(richMenuId)}`,
        { method: 'POST' },
      ),

    // LINE 上の rich menu 画像を admin proxy 経由で取得する URL。
    // <img src> として使う。staff 認証必要 (admin 経由なので browser fetch すると
    // クッキーや Authorization が必要 — 代わりに admin が cache-busting できる
    // タイムスタンプを付けるパターンで利用)。
    externalImageUrl: (richMenuId: string, accountId: string) =>
      `${API_URL}/api/rich-menu-groups/external/${richMenuId}/image?accountId=${encodeURIComponent(accountId)}`,

    applyToTag: (
      groupId: string,
      params:
        | { mode: 'bulk-link'; tagId: string | null }
        | { mode: 'set-default' },
    ) =>
      fetchApi<
        ApiResponse<{ chunks: number; total: number; message?: string; mode?: string }>
      >(`/api/rich-menu-groups/${groupId}/apply-to-tag`, {
        method: 'POST',
        body: JSON.stringify(params),
      }),

    // 画像 upload は Content-Type を image/* で送るので fetchApi を使わず直接 fetch。
    uploadImage: async (groupId: string, pageId: string, file: File) => {
      const csrf = getCsrfToken();
      const res = await fetch(
        `${API_URL}/api/rich-menu-groups/${groupId}/pages/${pageId}/image`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': file.type,
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          },
          body: file,
        },
      );
      const body = (await res.json()) as ApiResponse<{
        imageR2Key: string;
        imageContentType: string;
        size: 'large' | 'compact';
      }>;
      if (!body.success) {
        throw new Error(body.error ?? `upload failed: ${res.status}`);
      }
      return body;
    },

    // 注: <img src> では Authorization ヘッダを送れないため、Worker 側で
    //   この path のみ auth ミドルウェアの除外パスに加えるか、
    //   あるいは将来的に署名付き URL を発行する仕組みに切り替える必要がある。
    //   v1 ではドラフト編集中のプレビュー用 = 認証バイパスでも実害は低いので、
    //   後続 PR で worker 側を whitelist 化する想定。
    imageUrl: (key: string) =>
      `${API_URL}/api/rich-menu-images/${encodeURIComponent(key)}`,
  },
  messageTemplates: {
    list: () =>
      fetchApi<ApiResponse<Array<{
        id: string
        name: string
        messageType: string
        messageContent: string
        createdAt: string
        updatedAt: string
      }>>>('/api/message-templates'),
  },
  entryRoutes: {
    list: () => fetchApi<ApiResponse<EntryRoute[]>>('/api/entry-routes'),
    get: (id: string) => fetchApi<ApiResponse<EntryRoute>>(`/api/entry-routes/${id}`),
    create: (data: CreateEntryRouteInput) =>
      fetchApi<ApiResponse<EntryRoute>>('/api/entry-routes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<CreateEntryRouteInput>) =>
      fetchApi<ApiResponse<EntryRoute>>(`/api/entry-routes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/entry-routes/${id}`, { method: 'DELETE' }),
    funnel: (id: string) =>
      fetchApi<ApiResponse<EntryRouteFunnel>>(`/api/entry-routes/${id}/funnel`),
  },
  pools: {
    list: () => fetchApi<ApiResponse<TrafficPool[]>>('/api/traffic-pools'),
    get: (id: string) => fetchApi<ApiResponse<TrafficPool>>(`/api/traffic-pools/${id}`),
    create: (data: { slug: string; name: string; activeAccountId: string }) =>
      fetchApi<ApiResponse<TrafficPool>>('/api/traffic-pools', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: Partial<{ name: string; activeAccountId: string; isActive: boolean }>,
    ) =>
      fetchApi<ApiResponse<TrafficPool>>(`/api/traffic-pools/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/traffic-pools/${id}`, { method: 'DELETE' }),
    accounts: {
      list: (poolId: string) =>
        fetchApi<ApiResponse<PoolAccount[]>>(`/api/traffic-pools/${poolId}/accounts`),
      add: (poolId: string, lineAccountId: string) =>
        fetchApi<ApiResponse<PoolAccount>>(`/api/traffic-pools/${poolId}/accounts`, {
          method: 'POST',
          body: JSON.stringify({ lineAccountId }),
        }),
      toggle: (poolId: string, accountId: string, isActive: boolean) =>
        fetchApi<ApiResponse<PoolAccount>>(
          `/api/traffic-pools/${poolId}/accounts/${accountId}`,
          {
            method: 'PUT',
            body: JSON.stringify({ isActive }),
          },
        ),
      remove: (poolId: string, accountId: string) =>
        fetchApi<ApiResponse<null>>(
          `/api/traffic-pools/${poolId}/accounts/${accountId}`,
          { method: 'DELETE' },
        ),
    },
  },
  duplicates: {
    stats: (options?: { forceRefresh?: boolean }) =>
      fetchApi<ApiResponse<{
        totalFollowing: number;
        uniquePeople: number;
        friendDups: number;
        duplicateGroups: number;
        wastedPerBroadcastYen: number;
        msgUnitYen: number;
        perAccount: Array<{
          accountId: string;
          accountName: string;
          friends: number;
          dups: number;
          dupRate: number;
        }>;
        // Optional during rolling deploys when an older worker is live.
        pairwiseOverlap?: Array<{
          fromAccountId: string;
          toAccountId: string;
          overlap: number;
        }>;
        // Optional during rolling deploys when an older worker is live.
        computedAt?: string;
      }>>(options?.forceRefresh ? '/api/duplicates/stats?refresh=1' : '/api/duplicates/stats'),
  },
  uploads: {
    /**
     * 既存 /api/images エンドポイントを叩いて画像をアップロードする。
     * 10MB 超 / image/* 以外は 400 で返る。
     */
    image: async (file: File): Promise<ApiResponse<{ id: string; key: string; url: string; mimeType: string; size: number }>> => {
      const buf = await file.arrayBuffer()
      return fetchApi<ApiResponse<{ id: string; key: string; url: string; mimeType: string; size: number }>>('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: buf,
      })
    },
  },

  // メディアライブラリ (G15) — worker `GET /api/images` (R2 .list({prefix:'media/'})) と
  // `DELETE /api/images/:key`。アップロードは既存 `api.uploads.image` を再利用する (新 upload client を
  // 作らない = fetchApi の Content-Type: application/json 強制と衝突しないため)。
  images: {
    // media/ 配下の素材一覧。cursor があれば次ページ (R2 の 1000 件 cutoff 対応 = もっと見る)。
    list: (cursor?: string) =>
      fetchApi<ApiResponse<{ items: { key: string; url: string; size: number; uploaded: string }[]; cursor?: string }>>(
        cursor ? `/api/images?cursor=${encodeURIComponent(cursor)}` : '/api/images',
      ),
    // key は 'media/xxx.png' = slash 含み → encodeURIComponent。worker は wildcard param (:key{.+}) で受ける。
    remove: (key: string) =>
      fetchApi<ApiResponse<null>>(`/api/images/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  },

  // 計測リンク (tracked link) — worker `serializeTrackedLink` の 13 field を返す (tracked-links.ts)。
  // list は既存 (Flex ビルダーが最小形 TrackedLinkListItem で参照)。/tracked-links 画面用に
  // get/create/patch/delete を追加 (F1 batch1 / worker 無変更で既存 CRUD route を叩くだけ)。
  trackedLinks: {
    list: () =>
      fetchApi<ApiResponse<TrackedLinkItem[]>>('/api/tracked-links'),
    get: (id: string) =>
      fetchApi<ApiResponse<TrackedLinkItem>>(`/api/tracked-links/${id}`),
    create: (body: { name: string; originalUrl: string; tagId?: string | null }) =>
      fetchApi<ApiResponse<TrackedLinkItem>>('/api/tracked-links', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // 遷移先 URL の編集に対応 (batch2 C7)。worker PATCH に originalUrl 受理 + server URL 検証、
    // db updateTrackedLink SET 句に original_url を揃えたため silent-success の罠は根治済み。
    patch: (id: string, body: { name?: string; originalUrl?: string; tagId?: string | null }) =>
      fetchApi<ApiResponse<TrackedLinkItem>>(`/api/tracked-links/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/tracked-links/${id}`, { method: 'DELETE' }),
  },

  // Google カレンダー連携 — worker `/api/integrations/google-calendar/*` (calendar.ts)。
  // F1 batch1 で新設 (画面 /booking/calendar 用)。
  calendar: {
    list: () =>
      fetchApi<ApiResponse<CalendarConnection[]>>('/api/integrations/google-calendar'),
    connect: (body: {
      calendarId: string
      authType: string
      accessToken?: string
      refreshToken?: string
      apiKey?: string
    }) =>
      fetchApi<ApiResponse<CalendarConnection>>('/api/integrations/google-calendar/connect', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    disconnect: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/integrations/google-calendar/${id}`, { method: 'DELETE' }),
  },

  // 広告CV連携 (G34) — worker `ad-platforms.ts` の既存フル CRUD に対応 (worker 無変更)。
  // 画面 /ad-conversions が接続先の登録/編集/テスト送信/ログ閲覧/削除に使う。
  // 注意: GET list の config は worker が maskConfig() で secret をマスクして返す (先頭4****末尾4)。
  //   編集時にマスク値をそのまま送り返すと本物のトークンが壊れるため、画面は「空欄=今のまま維持」で
  //   入力があった欄だけ config に載せて PUT する (ad-conversions/page.tsx 側の責務)。
  adPlatforms: {
    list: () =>
      fetchApi<ApiResponse<AdPlatformItem[]>>('/api/ad-platforms'),
    create: (body: { name: string; displayName?: string; config: Record<string, unknown> }) =>
      fetchApi<ApiResponse<AdPlatformItem>>('/api/ad-platforms', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: string, body: { displayName?: string | null; config?: Record<string, unknown>; isActive?: boolean }) =>
      fetchApi<ApiResponse<AdPlatformItem>>(`/api/ad-platforms/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/ad-platforms/${id}`, { method: 'DELETE' }),
    test: (body: { platform: string; eventName: string; friendId?: string }) =>
      fetchApi<ApiResponse<{ message: string }>>('/api/ad-platforms/test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    logs: (id: string, limit = 50) =>
      fetchApi<ApiResponse<AdConversionLogItem[]>>(`/api/ad-platforms/${id}/logs?limit=${limit}`),
  },

  // F2 G3 キャンペーン集計 (account-scoped・送信ゼロ・集計/紐付けのみ)。
  campaigns: {
    list: (accountId: string) =>
      fetchApi<ApiResponse<CampaignSummary[]>>(
        `/api/campaigns?accountId=${encodeURIComponent(accountId)}`,
      ),
    get: (id: string, accountId: string) =>
      fetchApi<ApiResponse<CampaignDetail>>(
        `/api/campaigns/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
      ),
    create: (accountId: string, name: string) =>
      fetchApi<ApiResponse<CampaignSummary>>(
        `/api/campaigns?accountId=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ name }) },
      ),
    rename: (id: string, name: string, accountId: string) =>
      fetchApi<ApiResponse<CampaignSummary>>(
        `/api/campaigns/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      ),
    remove: (id: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/campaigns/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),
    // 配信の紐付け/解除 (linked=false で解除)。集計のグルーピングのみ・送信しない。
    linkBroadcast: (id: string, broadcastId: string, linked: boolean, accountId: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/campaigns/${encodeURIComponent(id)}/broadcasts?accountId=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ broadcastId, linked }) },
      ),
  },

  // F2 G25 送信者プリセット (account-scoped・送信ゼロ・なりすまし防止の値検証は server が正典)。
  senderPresets: {
    list: (accountId: string) =>
      fetchApi<ApiResponse<SenderPresetItem[]>>(
        `/api/sender-presets?accountId=${encodeURIComponent(accountId)}`,
      ),
    create: (accountId: string, data: { name: string; iconUrl?: string | null }) =>
      fetchApi<ApiResponse<SenderPresetItem>>(
        `/api/sender-presets?accountId=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (id: string, accountId: string, data: { name?: string; iconUrl?: string | null }) =>
      fetchApi<ApiResponse<SenderPresetItem>>(
        `/api/sender-presets/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      ),
    remove: (id: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/sender-presets/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),
  },

  // F2 G16 テンプレパック (account-scoped・挿入用 CRUD・送信ゼロ)。
  templatePacks: {
    list: (accountId: string) =>
      fetchApi<ApiResponse<TemplatePackListItem[]>>(
        `/api/template-packs?accountId=${encodeURIComponent(accountId)}`,
      ),
    get: (id: string, accountId: string) =>
      fetchApi<ApiResponse<TemplatePackDetail>>(
        `/api/template-packs/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
      ),
    create: (accountId: string, input: { name: string; items: TemplatePackItemInput[] }) =>
      fetchApi<ApiResponse<TemplatePackDetail>>(
        `/api/template-packs?accountId=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    update: (id: string, input: { name?: string; items?: TemplatePackItemInput[] }, accountId: string) =>
      fetchApi<ApiResponse<TemplatePackDetail>>(
        `/api/template-packs/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    remove: (id: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/template-packs/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),
  },

  // F2 G58 リッチメニュータップ数分析 (read-only 集計・postback系のみ・送信ゼロ)。
  richMenuTapAnalytics: {
    taps: (params: { accountId: string; groupId: string; startDate: string; endDate: string }) =>
      fetchApi<ApiResponse<RichMenuTapAnalyticsData>>(
        `/api/rich-menu-analytics/taps?` +
          new URLSearchParams({
            accountId: params.accountId,
            groupId: params.groupId,
            startDate: params.startDate,
            endDate: params.endDate,
          }).toString(),
      ),
  },
}

// ---- F2 batch2 response 型 (api client namespace 用) ----

export interface CampaignSummary {
  id: string
  accountId: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface SenderPresetItem {
  id: string
  accountId: string
  name: string
  iconUrl: string | null
  createdAt: string
}

export interface CampaignBroadcastSummary {
  broadcastId: string
  title: string | null
  sentAt: string | null
  targetCount: number
  opened: number | null
  clicked: number | null
}

export interface CampaignAggregate {
  broadcastCount: number
  totalTarget: number
  totalOpened: number | null
  totalClicked: number | null
  broadcasts: CampaignBroadcastSummary[]
}

export interface CampaignDetail extends CampaignSummary {
  aggregate: CampaignAggregate
}

export interface TemplatePackItemInput {
  messageType: 'text' | 'flex'
  messageContent: string
}

export interface TemplatePackListItem {
  id: string
  account_id: string
  name: string
  created_at: string
  updated_at: string
  itemCount: number
}

export interface TemplatePackItem {
  id: string
  pack_id: string
  order_index: number
  message_type: 'text' | 'flex'
  message_content: string
  created_at: string
  updated_at: string
}

export interface TemplatePackDetail {
  id: string
  account_id: string
  name: string
  created_at: string
  updated_at: string
  items: TemplatePackItem[]
}

export interface AreaTapResult {
  areaId: string
  pageId: string
  boundsX: number
  boundsY: number
  boundsWidth: number
  boundsHeight: number
  actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch'
  postbackData: string | null
  count: number | null
  measurable: boolean
  unmeasurableReason: 'non-postback' | 'ambiguous' | null
}

export interface RichMenuTapAnalyticsData {
  areas: AreaTapResult[]
  byPostbackData: { data: string; count: number }[]
  unattributedCount: number
  totalTaps: number
}

/** Flex ビルダーの link-picker が使う計測リンクの最小形 (worker serializeTrackedLink の一部)。 */
export interface TrackedLinkListItem {
  id: string
  name: string
  originalUrl: string
  trackingUrl: string
}

/**
 * 計測リンクの完全形 (worker serializeTrackedLink 全 13 field / tracked-links.ts)。
 * `/tracked-links` 管理画面が使う。TrackedLinkListItem は Flex ビルダーが import
 * している最小形なので互換のため残置し、こちらを新規 export として追加する。
 */
export interface TrackedLinkItem {
  id: string
  name: string
  originalUrl: string
  trackingUrl: string
  tagId: string | null
  scenarioId: string | null
  introTemplateId: string | null
  rewardTemplateId: string | null
  isActive: boolean
  clickCount: number
  createdAt: string
  updatedAt: string
}

/** Google カレンダー連携先 (worker calendar.ts GET serialize)。connect 直後は updatedAt 省略あり。 */
export interface CalendarConnection {
  id: string
  calendarId: string
  authType: string
  isActive: boolean
  createdAt: string
  updatedAt?: string
}

/**
 * 広告プラットフォーム接続先 (worker ad-platforms.ts GET/POST/PUT serialize)。
 * config は GET list では maskConfig() でマスク済み (secret は 先頭4****末尾4)。
 * name は 'meta' | 'x' | 'google' | 'tiktok' のいずれか (worker validNames)。
 */
export interface AdPlatformItem {
  id: string
  name: string
  displayName: string | null
  config: Record<string, unknown>
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 広告CV送信ログ (worker ad-platforms.ts GET /:id/logs serialize)。 */
export interface AdConversionLogItem {
  id: string
  adPlatformId: string
  friendId: string | null
  eventName: string
  clickId: string | null
  clickIdType: string | null
  status: string
  errorMessage: string | null
  createdAt: string
}

/**
 * リマインダへの友だち手動登録 (worker reminders.ts / friend_reminders テーブル serialize)。
 * enroll route は createdAt を返さず、GET /api/friends/:id/reminders は返すため optional。
 */
export interface FriendReminderEnrollment {
  id: string
  friendId: string
  reminderId: string
  targetDate: string
  status: string
  createdAt?: string
}

// ----------------------------------------------------------------
// Booking API client (admin endpoints scoped by ?account_id=)
// ----------------------------------------------------------------

export interface BookingMenu {
  id: string;
  name: string;
  category_label: string | null;
  description: string | null;
  duration_minutes: number;
  buffer_after_minutes: number;
  base_price: number;
  sort_order: number;
  is_active: number;
}

export interface BookingStaff {
  id: string;
  name: string;
  display_name: string;
  role: string | null;
  profile_image_url: string | null;
  bio: string | null;
  sort_order: number;
  is_designation_optional: number;
  is_active: number;
}

export interface BookingShift {
  id: string;
  work_date: string;
  start_time: string;
  end_time: string;
}

export interface StaffMenuMatrix {
  menu_id: string;
  name: string;
  is_offered: number;
  override_duration_minutes: number | null;
  override_price: number | null;
}

export interface BookingRequest {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  customer_note: string | null;
  internal_note: string | null;
  price_at_booking: number;
  menu_name: string;
  staff_name: string;
  friend_name: string | null;
}

function withAccount(path: string, accountId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}account_id=${encodeURIComponent(accountId)}`;
}

export const bookingApi = {
  // Menus
  listMenus: (accountId: string) =>
    fetchApi<{ menus: BookingMenu[] }>(withAccount('/api/booking/admin/menus', accountId)),
  createMenu: (accountId: string, body: Partial<BookingMenu>) =>
    fetchApi<{ id: string }>(withAccount('/api/booking/admin/menus', accountId), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateMenu: (accountId: string, id: string, body: Partial<BookingMenu>) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/menus/${id}`, accountId), {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteMenu: (accountId: string, id: string) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/menus/${id}`, accountId), {
      method: 'DELETE',
    }),
  // Staff
  listStaff: (accountId: string) =>
    fetchApi<{ staff: BookingStaff[] }>(withAccount('/api/booking/admin/staff', accountId)),
  createStaff: (accountId: string, body: Partial<BookingStaff>) =>
    fetchApi<{ id: string }>(withAccount('/api/booking/admin/staff', accountId), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateStaff: (accountId: string, id: string, body: Partial<BookingStaff>) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/staff/${id}`, accountId), {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteStaff: (accountId: string, id: string) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/staff/${id}`, accountId), {
      method: 'DELETE',
    }),
  // staff_menus matrix
  getStaffMenus: (accountId: string, staffId: string) =>
    fetchApi<{ matrix: StaffMenuMatrix[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/menus`, accountId),
    ),
  putStaffMenus: (
    accountId: string,
    staffId: string,
    menus: Array<{
      menu_id: string;
      is_offered: boolean;
      override_duration_minutes?: number | null;
      override_price?: number | null;
    }>,
  ) =>
    fetchApi<{ ok: true }>(
      withAccount(`/api/booking/admin/staff/${staffId}/menus`, accountId),
      { method: 'PUT', body: JSON.stringify({ menus }) },
    ),
  // Shifts
  getShifts: (accountId: string, staffId: string) =>
    fetchApi<{ shifts: BookingShift[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts`, accountId),
    ),
  putShifts: (
    accountId: string,
    staffId: string,
    shifts: Array<{ work_date: string; start_time: string; end_time: string }>,
  ) =>
    fetchApi<{ ok: true; count: number }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts`, accountId),
      { method: 'PUT', body: JSON.stringify({ shifts }) },
    ),
  deleteShift: (accountId: string, staffId: string, shiftId: string) =>
    fetchApi<{ ok: true }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts/${shiftId}`, accountId),
      { method: 'DELETE' },
    ),
  generateShifts: (
    accountId: string,
    staffId: string,
    body: {
      from_date: string;
      weeks: number;
      weekly_template: Record<string, { start: string; end: string } | null>;
    },
  ) =>
    fetchApi<{ inserted: number }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts/generate`, accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // Requests
  listRequests: (accountId: string, status: string = 'requested') =>
    fetchApi<{ requests: BookingRequest[] }>(
      withAccount(`/api/booking/admin/requests?status=${status}`, accountId),
    ),
  decideRequest: (
    accountId: string,
    id: string,
    action: 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete',
  ) =>
    fetchApi<{ status: string }>(
      withAccount(`/api/booking/admin/requests/${id}`, accountId),
      { method: 'PATCH', body: JSON.stringify({ action }) },
    ),
  pendingCount: (accountId: string) =>
    fetchApi<{ count: number }>(withAccount('/api/booking/admin/pending-count', accountId)),
};

// ============================================================
// Event-booking admin API
// ============================================================

export interface EventListItem {
  id: string;
  name: string;
  venue_name: string | null;
  venue_url: string | null;
  image_url: string | null;
  description: string | null;
  description_centered: number;
  max_bookings_per_friend: number | null;
  requires_approval: number;
  cancel_deadline_hours_before: number | null;
  reminder_day_before_enabled: number;
  reminder_hours_before: number | null;
  is_published: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  next_slot_starts_at: string | null;
  total_capacity: number | null;
  total_active: number;
  pending_count: number;
  // Multi-account fields (migration 040)
  target_type?: 'single' | 'multi-account-dedup';
  account_ids?: string | string[] | null;
  line_account_id?: string;
}

export interface EventDetail {
  id: string;
  name: string;
  venue_name: string | null;
  venue_url: string | null;
  image_url: string | null;
  description: string | null;
  description_centered: number;
  max_bookings_per_friend: number | null;
  requires_approval: number;
  cancel_deadline_hours_before: number | null;
  reminder_day_before_enabled: number;
  reminder_hours_before: number | null;
  is_published: number;
  sort_order: number;
  // Multi-account fields (migration 040, broadcasts と同パターン)
  target_type?: 'single' | 'multi-account-dedup';
  // Worker は JSON 文字列で返す。UI 側で parse して string[] を扱う。
  account_ids?: string | string[] | null;
  dedup_priority?: string | string[] | null;
  line_account_id?: string;
}

export interface EventSlot {
  id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  is_active: number;
  sort_order: number;
  active_count?: number;
}

export interface EventBookingItem {
  id: string;
  event_id: string;
  slot_id: string;
  friend_id: string;
  line_account_id: string;
  status: string;
  customer_note: string | null;
  internal_note: string | null;
  requested_at: string;
  decided_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  slot_starts_at: string;
  slot_ends_at: string;
  friend_display_name: string | null;
  friend_line_user_id: string | null;
}

export const eventsApi = {
  listEvents: (accountId: string) =>
    fetchApi<{ items: EventListItem[] }>(
      withAccount('/api/events/admin/events', accountId),
    ),
  getEvent: (accountId: string, id: string) =>
    fetchApi<EventDetail>(
      withAccount(`/api/events/admin/events/${id}`, accountId),
    ),
  createEvent: (accountId: string, body: Partial<EventDetail>) =>
    fetchApi<EventDetail>(
      withAccount('/api/events/admin/events', accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateEvent: (accountId: string, id: string, body: Partial<EventDetail>) =>
    fetchApi<EventDetail>(
      withAccount(`/api/events/admin/events/${id}`, accountId),
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deleteEvent: (accountId: string, id: string) =>
    fetchApi<void>(
      withAccount(`/api/events/admin/events/${id}`, accountId),
      { method: 'DELETE' },
    ),

  listSlots: (accountId: string, eventId: string) =>
    fetchApi<{ items: EventSlot[] }>(
      withAccount(`/api/events/admin/events/${eventId}/slots`, accountId),
    ),
  createSlots: (
    accountId: string,
    eventId: string,
    slots: Array<{ starts_at: string; ends_at: string; capacity: number | null; is_active?: number; sort_order?: number }>,
  ) =>
    fetchApi<{ items: EventSlot[] }>(
      withAccount(`/api/events/admin/events/${eventId}/slots`, accountId),
      { method: 'POST', body: JSON.stringify({ slots }) },
    ),
  updateSlot: (accountId: string, eventId: string, slotId: string, body: Partial<EventSlot>) =>
    fetchApi<EventSlot>(
      withAccount(`/api/events/admin/events/${eventId}/slots/${slotId}`, accountId),
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deleteSlot: (accountId: string, eventId: string, slotId: string) =>
    fetchApi<void>(
      withAccount(`/api/events/admin/events/${eventId}/slots/${slotId}`, accountId),
      { method: 'DELETE' },
    ),

  listBookings: (
    accountId: string,
    eventId: string,
    filters: { status?: string; slot_id?: string } = {},
  ) => {
    const qs: string[] = [];
    if (filters.status) qs.push(`status=${encodeURIComponent(filters.status)}`);
    if (filters.slot_id) qs.push(`slot_id=${encodeURIComponent(filters.slot_id)}`);
    const tail = qs.length > 0 ? `?${qs.join('&')}` : '';
    return fetchApi<{ items: EventBookingItem[] }>(
      withAccount(`/api/events/admin/events/${eventId}/bookings${tail}`, accountId),
    );
  },
  decideBooking: (
    accountId: string,
    eventId: string,
    bookingId: string,
    action: 'confirm' | 'reject',
    reason?: string,
  ) =>
    fetchApi<EventBookingItem>(
      withAccount(`/api/events/admin/events/${eventId}/bookings/${bookingId}/decide`, accountId),
      { method: 'POST', body: JSON.stringify({ action, reason }) },
    ),
  adminCancelBooking: (accountId: string, eventId: string, bookingId: string) =>
    fetchApi<{ ok: true }>(
      withAccount(`/api/events/admin/events/${eventId}/bookings/${bookingId}/cancel`, accountId),
      { method: 'POST' },
    ),
  updateBooking: (
    accountId: string,
    eventId: string,
    bookingId: string,
    body: { internal_note?: string | null; status?: 'attended' | 'no_show' },
  ) =>
    fetchApi<EventBookingItem>(
      withAccount(`/api/events/admin/events/${eventId}/bookings/${bookingId}`, accountId),
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  pendingCount: (accountId: string) =>
    fetchApi<{ count: number }>(
      withAccount('/api/events/admin/events/notifications/pending', accountId),
    ),
};
