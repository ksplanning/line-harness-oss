/**
 * broadcast 新メッセージ種別 (動画/音声/リッチメッセージ/リッチビデオ) の純ロジック。
 * React に依存しない (node 環境の vitest で単体テストできる)。UI は broadcast-media-inputs.tsx、
 * 保存時 client 検証は broadcast-form.tsx から本モジュールを使う。server が検証の正典。
 */

export type MediaMessageType = 'video' | 'audio' | 'imagemap' | 'richvideo'

export interface MediaRegion {
  x: string
  y: string
  width: string
  height: string
  actionType: 'uri' | 'message'
  value: string
}

export interface MediaState {
  videoUrl: string
  previewUrl: string
  audioUrl: string
  durationSec: string
  baseUrl: string
  baseW: string
  baseH: string
  regions: MediaRegion[]
  btnLabel: string
  btnLink: string
}

export const initialMediaState: MediaState = {
  videoUrl: '', previewUrl: '', audioUrl: '', durationSec: '',
  baseUrl: '', baseW: '1040', baseH: '1040', regions: [], btnLabel: '', btnLink: '',
}

export function num(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function isHttps(v: unknown): boolean {
  return typeof v === 'string' && /^https:\/\/\S+/.test(v)
}

/**
 * imagemap 領域をベース画像 (baseW×baseH) の内側に収める。負値は 0、幅/高さは
 * 残り領域を超えない整数に丸める。ドラッグエディタ / 数値入力どちらの出力でも本番 LINE
 * payload が baseSize を必ず満たすことを保証する単一の座標正典 (§2-2 / failure_observable
 * 「本番で領域がズレる」の構造対策)。baseW/baseH<=0 (未入力) の軸は clamp しない (0 幅化を防ぐ)。
 */
export function clampRegion(r: MediaRegion, baseW: number, baseH: number): MediaRegion {
  let x = Math.max(0, Math.round(num(r.x)))
  let y = Math.max(0, Math.round(num(r.y)))
  let w = Math.max(0, Math.round(num(r.width)))
  let h = Math.max(0, Math.round(num(r.height)))
  if (baseW > 0) { x = Math.min(x, baseW); w = Math.min(w, baseW - x) }
  if (baseH > 0) { y = Math.min(y, baseH); h = Math.min(h, baseH - y) }
  return { ...r, x: String(x), y: String(y), width: String(w), height: String(h) }
}

/** 現在の種別に応じた messageContent JSON を組み立てる。必須未入力でも部分 JSON を返す (最終検証は保存時)。 */
export function buildMediaJson(type: MediaMessageType, s: MediaState): string {
  if (type === 'video') {
    if (!s.videoUrl && !s.previewUrl) return ''
    return JSON.stringify({ originalContentUrl: s.videoUrl, previewImageUrl: s.previewUrl })
  }
  if (type === 'audio') {
    if (!s.audioUrl && !s.durationSec) return ''
    return JSON.stringify({ originalContentUrl: s.audioUrl, duration: Math.round(num(s.durationSec) * 1000) })
  }
  if (type === 'imagemap') {
    if (!s.baseUrl && s.regions.length === 0) return ''
    const bw = num(s.baseW), bh = num(s.baseH)
    return JSON.stringify({
      baseUrl: s.baseUrl,
      altText: 'リッチメッセージ',
      baseSize: { width: bw, height: bh },
      actions: s.regions.map((r0) => {
        const r = clampRegion(r0, bw, bh)
        const area = { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
        return r.actionType === 'uri'
          ? { type: 'uri', linkUri: r.value, area }
          : { type: 'message', text: r.value, area }
      }),
    })
  }
  // richvideo: imagemap + video (再生後アクションボタン)。base 画像 = プレビュー画像。
  if (!s.videoUrl && !s.previewUrl) return ''
  const w = num(s.baseW), h = num(s.baseH)
  return JSON.stringify({
    baseUrl: s.previewUrl,
    altText: '動画メッセージ',
    baseSize: { width: w, height: h },
    actions: [],
    video: {
      originalContentUrl: s.videoUrl,
      previewImageUrl: s.previewUrl,
      area: { x: 0, y: 0, width: w, height: h },
      ...(s.btnLabel || s.btnLink ? { externalLink: { linkUri: s.btnLink, label: s.btnLabel } } : {}),
    },
  })
}

/** 新 type の client 側検証 (即時フィードバック・server が正典)。OK なら null、不正なら日本語エラー。 */
export function validateMediaClient(type: MediaMessageType, content: string): string | null {
  let p: Record<string, unknown>
  try {
    p = JSON.parse(content || '{}') as Record<string, unknown>
  } catch {
    return 'メッセージ内容の形式が正しくありません'
  }
  if (type === 'video') {
    if (!isHttps(p.originalContentUrl) || !isHttps(p.previewImageUrl)) return '動画URLとプレビュー画像URLは https で入力してください'
  } else if (type === 'audio') {
    if (!isHttps(p.originalContentUrl)) return '音声URLは https で入力してください'
    if (typeof p.duration !== 'number' || p.duration <= 0) return '再生時間は正の数で入力してください'
  } else if (type === 'imagemap') {
    if (!isHttps(p.baseUrl)) return 'ベース画像URLは https で入力してください'
    const acts = p.actions as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(acts) || acts.length === 0) return '領域を1つ以上追加してください'
    for (const a of acts) if (a.type === 'uri' && !isHttps(a.linkUri)) return '領域のリンクURLは https で入力してください'
  } else {
    const v = p.video as Record<string, unknown> | undefined
    if (!v || !isHttps(v.originalContentUrl) || !isHttps(v.previewImageUrl)) return '動画URLとプレビュー画像URLは https で入力してください'
    const link = v.externalLink as Record<string, unknown> | undefined
    if (link && (link.linkUri || link.label) && !isHttps(link.linkUri)) return 'ボタンの飛び先は https で入力してください'
  }
  return null
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function numStr(v: unknown): string { return typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '0' }

/**
 * 保存済み messageContent (JSON) を編集 state (MediaState) に逆変換する (再編集経路 / Codex HIGH-5)。
 * buildMediaJson の逆写像で、buildMediaJson(parseMediaJson(json)) が元 JSON に戻る round-trip を保つ。
 * 空文字 / 壊れた JSON は初期 state を返す fail-safe (保存が壊れない)。server が検証の正典。
 */
export function parseMediaJson(type: MediaMessageType, content: string): MediaState {
  const base = { ...initialMediaState }
  if (!content || !content.trim()) return base
  let p: Record<string, unknown>
  try {
    p = JSON.parse(content) as Record<string, unknown>
  } catch {
    return base
  }
  if (type === 'video') {
    return { ...base, videoUrl: str(p.originalContentUrl), previewUrl: str(p.previewImageUrl) }
  }
  if (type === 'audio') {
    const durationMs = typeof p.duration === 'number' ? p.duration : 0
    return { ...base, audioUrl: str(p.originalContentUrl), durationSec: durationMs ? String(durationMs / 1000) : '' }
  }
  if (type === 'imagemap') {
    const bs = p.baseSize as { width?: unknown; height?: unknown } | undefined
    const acts = Array.isArray(p.actions) ? (p.actions as Array<Record<string, unknown>>) : []
    return {
      ...base,
      baseUrl: str(p.baseUrl),
      baseW: bs && typeof bs.width === 'number' ? String(bs.width) : base.baseW,
      baseH: bs && typeof bs.height === 'number' ? String(bs.height) : base.baseH,
      regions: acts.map((a) => {
        const area = (a.area ?? {}) as Record<string, unknown>
        const actionType: 'uri' | 'message' = a.type === 'message' ? 'message' : 'uri'
        return {
          x: numStr(area.x), y: numStr(area.y), width: numStr(area.width), height: numStr(area.height),
          actionType, value: actionType === 'uri' ? str(a.linkUri) : str(a.text),
        }
      }),
    }
  }
  // richvideo: base 画像 = プレビュー画像、video ブロックから復元。
  const v = (p.video ?? {}) as Record<string, unknown>
  const bs = p.baseSize as { width?: unknown; height?: unknown } | undefined
  const link = (v.externalLink ?? {}) as Record<string, unknown>
  return {
    ...base,
    videoUrl: str(v.originalContentUrl),
    previewUrl: str(v.previewImageUrl),
    baseW: bs && typeof bs.width === 'number' ? String(bs.width) : base.baseW,
    baseH: bs && typeof bs.height === 'number' ? String(bs.height) : base.baseH,
    btnLabel: str(link.label),
    btnLink: str(link.linkUri),
  }
}
