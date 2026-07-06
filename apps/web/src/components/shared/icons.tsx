/**
 * 単色ライン SVG アイコン集 (batch A / M-19 対策)。
 *
 * 目的: Flex ビルダー / 配信フォームの装飾を「絵文字文字」でなく inline SVG で描く。
 *   VS16 無しの text-presentation 絵文字 (🅰 U+1F170 / 🖼 U+1F5BC / 🗑 U+1F5D1 等) は
 *   owner の Windows / 一般フォント環境で □(豆腐) 化する。SVG は字形フォントに依存しないため
 *   どの環境でも同じ形で描かれ、豆腐が構造的に発生しない。
 *
 * 図案は ui-design.md A-1 のメタファに対応:
 *   見出し=A字 / 本文=文書 / 画像=山と太陽 / ボタン=丸角 / 区切り=横線 / 余白=点線枠。
 *
 * 全アイコンは currentColor を使うので、親の text 色でそのまま色が付く (既存の緑/グレー配色を維持)。
 * public OSS repo のため lineicons(private-licensed) の実体は同梱せず、自前パスで描く。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { title?: string }

function Svg({ title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

/** 見出し = 大きな「A」字 (太字の文字を表す)。 */
export function HeadingIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 19 L12 5 L19 19" />
      <path d="M7.5 14 H16.5" />
    </Svg>
  )
}

/** 本文 = 文書 (複数行の文章)。 */
export function BodyTextIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6 H19" />
      <path d="M5 10 H19" />
      <path d="M5 14 H15" />
      <path d="M5 18 H12" />
    </Svg>
  )
}

/** 画像 = 山と太陽 (写真・バナー)。 */
export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M4 17 L9 12 L13 15 L16 12 L20 16" />
    </Svg>
  )
}

/** ボタン = 丸角の枠 (押すとリンク先へ)。 */
export function ButtonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="8" width="18" height="8" rx="4" />
      <path d="M8 12 H16" />
    </Svg>
  )
}

/** 区切り線 = 横線。 */
export function SeparatorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12 H20" />
    </Svg>
  )
}

/** 余白 = 点線枠 (すき間)。 */
export function SpacerIcon(props: IconProps) {
  return (
    <Svg {...props} strokeDasharray="3 3">
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
    </Svg>
  )
}

/** 削除 = ゴミ箱。 */
export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7 H20" />
      <path d="M9 7 V5 a1 1 0 0 1 1 -1 h4 a1 1 0 0 1 1 1 V7" />
      <path d="M6 7 L7 20 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 L18 7" />
      <path d="M10 11 V17" />
      <path d="M14 11 V17" />
    </Svg>
  )
}

/** 編集 = 鉛筆。 */
export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 5 L19 9 L9 19 L5 20 L6 16 Z" />
      <path d="M13.5 6.5 L17.5 10.5" />
    </Svg>
  )
}

/** ビジュアル作成 = パレット。 */
export function PaletteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 a9 9 0 0 0 0 18 c1.5 0 2 -1 1.4 -2 c-0.6 -1 0 -2 1.1 -2 H17 a4 4 0 0 0 4 -4 A9 9 0 0 0 12 3 Z" />
      <circle cx="8" cy="10" r="1" />
      <circle cx="12" cy="7.5" r="1" />
      <circle cx="16" cy="10" r="1" />
    </Svg>
  )
}

/** リンク: ウェブページ = 地球。 */
export function GlobeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12 H21" />
      <path d="M12 3 a13 13 0 0 1 0 18 a13 13 0 0 1 0 -18" />
    </Svg>
  )
}

/** リンク: 計測リンク = 棒グラフ。 */
export function ChartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20 H20" />
      <path d="M7 20 V13" />
      <path d="M12 20 V7" />
      <path d="M17 20 V10" />
    </Svg>
  )
}

/** リンク: 電話。 */
export function PhoneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3 h3 l2 5 l-2.5 1.5 a11 11 0 0 0 5 5 L21 12 v3 a2 2 0 0 1 -2 2 A15 15 0 0 1 4 5 a2 2 0 0 1 2 -2 Z" />
    </Svg>
  )
}

/** リンク: 予約 = カレンダー。 */
export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 9 H20" />
      <path d="M8 3 V6" />
      <path d="M16 3 V6" />
    </Svg>
  )
}

/** 上へ移動 = 山形(上向き)。 */
export function ChevronUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 15 L12 9 L18 15" />
    </Svg>
  )
}

/** 下へ移動 = 山形(下向き)。 */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9 L12 15 L18 9" />
    </Svg>
  )
}

/** パスワード表示 = 目。 */
export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 12 s3.5 -7 10 -7 s10 7 10 7 s-3.5 7 -10 7 s-10 -7 -10 -7 Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

/** パスワード非表示 = 目に斜線。 */
export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4 L20 20" />
      <path d="M9.5 5.4 A9.6 9.6 0 0 1 12 5 c6.5 0 10 7 10 7 a17 17 0 0 1 -2.6 3.3" />
      <path d="M6.3 7.8 A16.6 16.6 0 0 0 2 12 s3.5 7 10 7 a9.7 9.7 0 0 0 3.3 -0.6" />
      <path d="M9.9 9.9 A3 3 0 0 0 14.1 14.1" />
    </Svg>
  )
}

/** ログイン = 錠前。 */
export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10 V7 a4 4 0 0 1 8 0 v3" />
      <path d="M12 14 V16" />
    </Svg>
  )
}
