/**
 * 画像で伝わるヘルプの静的カタログ (G66 / H-1)。helpKey → { title, imageSrc, altText, text }。
 *
 * DB を使わない静的 TS (owner 決定 Q6=いいえ / migration ゼロ)。文言は「専門語ゼロ・おばあちゃん
 * 基準」で、意味は主に画像 (public/help/*.webp・gpt-image-2 生成の手描き風手順図) が伝える。
 * 画像を差し替える時は本カタログの imageSrc と public/help/ を対で更新する (単一正典)。
 *
 * H-1 は ★6 高優先 (ImageMap x3 / Flex x2 / シナリオ x1)。残りは H-2/H-3 で追記する。
 */

export interface HelpEntry {
  /** ポップオーバー見出し (短い) */
  title: string
  /** public/ 配下の画像パス (/help/*.webp) */
  imageSrc: string
  /** 画像の代替テキスト (a11y 必須) */
  altText: string
  /** 説明の短文 (専門語ゼロ) */
  text: string
}

export const HELP_CATALOG = {
  'imagemap.base': {
    title: 'ベース画像を用意',
    imageSrc: '/help/imagemap-base.webp',
    altText: '1枚の写真がスマホ画面いっぱいに表示され、緑の矢印で画像が読み込まれる様子を示すイラスト',
    text: 'まず、土台になる画像を1枚用意します。',
  },
  'imagemap.regions': {
    title: '押せる範囲を描く',
    imageSrc: '/help/imagemap-regions.webp',
    altText: '写真の上に指で点線の四角をなぞって描き、画像が3つの領域に分かれている様子を示すイラスト',
    text: '画像の上をなぞるだけで、四角い範囲（タップできる場所）を描けます。',
  },
  'imagemap.action': {
    title: '押した先を決める',
    imageSrc: '/help/imagemap-action.webp',
    altText: '3つに分かれた画像の各領域から、それぞれ別のアイコンへ矢印が伸びている様子を示すイラスト',
    text: '押す場所によって、飛び先や送る言葉を変えられます。',
  },
  'flex.parts': {
    title: 'パーツを積み重ねる',
    imageSrc: '/help/flex-parts.webp',
    altText: '色違いの四角いパーツが上から下へ積み重なってカードになる様子を示すイラスト',
    text: 'パーツを上から順に積み重ねて、1つのカードを作ります。',
  },
  'flex.link': {
    title: 'ボタンに行き先',
    imageSrc: '/help/flex-link.webp',
    altText: 'ボタンの形をした図形から鎖のアイコンを通じて行き先アイコンへつながる様子を示すイラスト',
    text: 'ボタンを押したときに開く行き先を設定できます。',
  },
  'scenario.condition': {
    title: '条件で道が分かれる',
    imageSrc: '/help/scenario-condition.webp',
    altText: '分かれ道の標識から2本の道が分かれ、一方はチェックマーク、もう一方はバツ印につながる様子を示すイラスト',
    text: '選んだ目印（条件）によって、その先の道が分かれます。',
  },
} satisfies Record<string, HelpEntry>

export type HelpKey = keyof typeof HELP_CATALOG

/** helpKey からヘルプ内容を引く。未登録なら undefined (呼び出し側は非表示にする)。 */
export function getHelp(key: string): HelpEntry | undefined {
  return (HELP_CATALOG as Record<string, HelpEntry>)[key]
}
