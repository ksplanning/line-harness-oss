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
    return JSON.stringify({
      baseUrl: s.baseUrl,
      altText: 'リッチメッセージ',
      baseSize: { width: num(s.baseW), height: num(s.baseH) },
      actions: s.regions.map((r) =>
        r.actionType === 'uri'
          ? { type: 'uri', linkUri: r.value, area: { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) } }
          : { type: 'message', text: r.value, area: { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) } },
      ),
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
