/**
 * broadcast 種別の日本語ラベル + 詳細プレビューのサマリ (単一の正典)。
 * broadcast-form / broadcasts 一覧 / broadcast-detail が本モジュールを共有し、種別ラベルを重複定義しない
 * (3分岐 ternary で新 type が「Flex」に落ちる回帰の再発防止)。
 */
import type { BroadcastMessageType } from '@line-crm/shared'

export const messageTypeLabels: Record<BroadcastMessageType, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flexメッセージ',
  video: '動画',
  audio: '音声',
  imagemap: 'リッチメッセージ (画像分割)',
  richvideo: 'リッチビデオ',
}

// 種別ごとの1行説明 (配信作成フォームで運用者が迷わないよう)。
export const messageTypeHints: Partial<Record<BroadcastMessageType, string>> = {
  video: '動画ファイルのURLを送ります',
  audio: '音声ファイルのURLを送ります',
  imagemap: '1枚の画像を複数の領域に分けてリンクを付けられます',
  richvideo: '動画の再生後にボタンを出せます',
}

/**
 * 詳細画面のメッセージプレビュー用。新 type (video/audio/imagemap/richvideo) は生 JSON を吹き出しに
 * 出さず、type に応じた簡潔なサマリを返す (過剰なプレイヤー埋め込みはしない)。対象外 type は null。
 */
export function mediaPreviewSummary(type: BroadcastMessageType, content: string): string | null {
  if (type !== 'video' && type !== 'audio' && type !== 'imagemap' && type !== 'richvideo') return null
  let p: Record<string, unknown>
  try {
    p = JSON.parse(content || '{}') as Record<string, unknown>
  } catch {
    return 'メッセージ内容の形式が正しくありません'
  }
  if (type === 'video') return `動画: ${(p.originalContentUrl as string) || '(URL未設定)'}`
  if (type === 'audio') {
    const ms = typeof p.duration === 'number' ? p.duration : 0
    return `音声: ${(p.originalContentUrl as string) || '(URL未設定)'}（${Math.round(ms / 1000)}秒）`
  }
  if (type === 'imagemap') {
    const acts = Array.isArray(p.actions) ? p.actions.length : 0
    return `リッチメッセージ: ${(p.baseUrl as string) || '(画像未設定)'}（領域${acts}件）`
  }
  // richvideo
  const v = p.video as Record<string, unknown> | undefined
  return `リッチビデオ: ${(v?.originalContentUrl as string) || '(URL未設定)'}`
}
