import { isDecorationType, DEFAULT_RATING_STAR_COLOR, type HarnessFieldType, type RatingSubType, type ImageWidth, type VariableSubType } from '@line-crm/shared'

// =============================================================================
// パレット field 種別メタ (F-2 / T-B1) — 素人向け日本語ラベル (英語 type 名を見せない / ui-design)。
// MVP subset を起点に、実装済み field を additive に公開する。
// =============================================================================

export type FieldCategory = '入力' | '選択' | '高度' | '装飾'

export interface FieldTypeHelp {
  /** このパーツで何ができるかを、初めて使う人向けに1行で示す。 */
  summary: string
  /** どんな質問に向くかと、設定の進め方を2〜3文で示す。 */
  howTo: string
  /** そのまま真似できる具体例を1つ示す。 */
  example: string
}

export interface FieldTypeMeta {
  type: HarnessFieldType
  label: string
  icon: string
  category: FieldCategory
  /** false は既存 field の表示・編集用メタだけを残し、パレットからの新規追加を止める。 */
  paletteVisible?: boolean
  /** パレットと高度パーツの設定欄が共有する、3層の説明正本。 */
  help: FieldTypeHelp
}

export const FIELD_TYPE_META: FieldTypeMeta[] = [
  {
    type: 'text', label: '1行テキスト', icon: '✏️', category: '入力',
    help: {
      summary: '短い文章を1行で入力してもらえます。',
      howTo: '名前や会社名など、短く答えられる質問に使います。必要なら入力できる文字数の上限も決めます。',
      example: '例：お名前を入力してもらう',
    },
  },
  {
    type: 'textarea', label: '複数行テキスト', icon: '📝', category: '入力',
    help: {
      summary: '長めの文章を複数行で入力してもらえます。',
      howTo: '感想や問い合わせ内容など、自由に詳しく書いてもらう質問に使います。質問文で、書いてほしい内容を具体的に伝えます。',
      example: '例：商品を使った感想を書いてもらう',
    },
  },
  {
    type: 'number', label: '数値', icon: '🔢', category: '入力',
    help: {
      summary: '数字を入力してもらえます。',
      howTo: '人数、個数、年齢など、数字で答える質問に使います。単位は質問文や補足説明に書き添えます。',
      example: '例：参加人数を数字で入力してもらう',
    },
  },
  {
    type: 'email', label: 'メール', icon: '✉️', category: '入力',
    help: {
      summary: 'メールアドレスを入力してもらえます。',
      howTo: '返信や案内の送り先を聞くときに使います。何の連絡に使うかを補足説明で伝えます。',
      example: '例：予約確認を送るメールアドレスを入力してもらう',
    },
  },
  {
    type: 'phone', label: '電話番号', icon: '📞', category: '入力',
    help: {
      summary: '電話番号を入力してもらえます。',
      howTo: '電話で連絡する可能性があるときに使います。補足説明に、つながりやすい時間なども書けます。',
      example: '例：日中につながる電話番号を入力してもらう',
    },
  },
  {
    type: 'date', label: '日付', icon: '📅', category: '入力',
    help: {
      summary: '年月日を選んでもらえます。',
      howTo: '予約日や生年月日など、日にちを聞く質問に使います。どの日付を答えるのかを質問文で示します。',
      example: '例：来店希望日を選んでもらう',
    },
  },
  // treasure-e1-field-parts: city は既存フォームの表示・編集用メタだけを残し、新規追加は止める。
  {
    type: 'time', label: '時刻', icon: '🕐', category: '入力',
    help: {
      summary: '時刻だけを入力してもらえます。',
      howTo: '予約時刻や連絡希望時刻など、時間を聞く質問に使います。日付も必要な場合は、日付のパーツを隣に置きます。',
      example: '例：電話を希望する時刻を入力してもらう',
    },
  },
  {
    type: 'website', label: 'URL', icon: '🔗', category: '入力',
    help: {
      summary: 'ホームページなどのURL（ページの住所）を入力してもらえます。',
      howTo: '会社サイトや参考ページの場所を答えてもらうときに使います。どのページを入力するのかを質問文で示します。',
      example: '例：会社ホームページのURLを入力してもらう',
    },
  },
  {
    type: 'city', label: '市区町村', icon: '🏙️', category: '入力', paletteVisible: false,
    help: {
      summary: '世界の都市名から英語で選んでもらう項目です。',
      howTo: '日本の住所入力には向いていません。既存フォームの内容を確認するときだけ使い、日本の住所入力には「1行テキスト」を使ってください。',
      example: '例：海外向けフォームで居住都市を選んでもらう',
    },
  },
  {
    type: 'choice', label: '単一選択', icon: '🔘', category: '選択',
    help: {
      summary: '並べた選択肢から1つだけ選んでもらえます。',
      howTo: '候補が少なく、すべてを見比べて選んでほしい質問に使います。答えの候補を1つずつ追加します。',
      example: '例：希望する連絡方法を「電話・メール」から選んでもらう',
    },
  },
  {
    type: 'yes_no', label: 'はい/いいえ', icon: '✅', category: '選択',
    help: {
      summary: '「はい」か「いいえ」で答えてもらえます。',
      howTo: '参加するか、同意するかなど、二択で確認したい質問に使います。質問文は、はい・いいえで答えられる形にします。',
      example: '例：イベントに参加するか答えてもらう',
    },
  },
  {
    type: 'dropdown', label: 'ドロップダウン', icon: '🔽', category: '選択',
    help: {
      summary: '一覧を開き、その中から1つだけ選んでもらえます。',
      howTo: '候補が多く、フォームを短く見せたい質問に使います。答えの候補を1つずつ追加します。',
      example: '例：希望する店舗を一覧から1つ選んでもらう',
    },
  },
  {
    type: 'multiple_select', label: '複数選択', icon: '☑️', category: '選択',
    help: {
      summary: '並べた選択肢から複数選んでもらえます。',
      howTo: '当てはまるものを、1つに絞らずすべて選んでほしい質問に使います。答えの候補を1つずつ追加します。',
      example: '例：興味のある商品をすべて選んでもらう',
    },
  },
  {
    type: 'choice_fetch', label: '動的選択肢', icon: '🔄', category: '選択',
    help: {
      summary: '外部のURL（選択肢を受け取る場所）から、表示する選択肢を読み込めます。',
      howTo: '先にフォームを保存し、選択肢の一覧を作るか選びます。店舗など、内容が変わる一覧に使います。',
      example: '例：最新の予約可能店舗を一覧から選んでもらう',
    },
  },
  {
    type: 'file', label: 'ファイル添付', icon: '📎', category: '高度',
    help: {
      summary: '画像や書類などのファイルを送ってもらえます。',
      howTo: '受け取るファイルの種類と最大サイズを決めます。必要なら、複数のファイルを送れるようにします。',
      example: '例：申し込みに必要な本人確認書類の画像を添付してもらう',
    },
  },
  {
    type: 'variable', label: '計算', icon: '🧮', category: '高度',
    help: {
      summary: 'ほかの欄に入った値を使い、答えを自動で計算できます。',
      howTo: '「計算式」を選び、計算に使う欄を入れます。足し算や掛け算などを組み合わせて式を作ります。',
      example: '例：単価と数量から合計金額を自動で計算する',
    },
  },
  {
    type: 'matrix', label: '行列', icon: '▦', category: '高度',
    help: {
      summary: '行と列を組み合わせた表で、行ごとに1つ選んでもらえます。',
      howTo: '評価する項目を行に、答えの候補を列に1つずつ書きます。複数の項目を同じ表で聞くときに使います。',
      example: '例：「接客・価格・品ぞろえ」を「満足・普通・不満」で評価してもらう',
    },
  },
  {
    type: 'repeating_section', label: '繰り返しセクション', icon: '🔁', category: '高度',
    help: {
      summary: '同じ欄の組み合わせを、回答者が必要な分だけ追加して入力できます。',
      howTo: '繰り返したい入力欄を先に作り、それらの欄を選びます。追加できる件数の最小と最大も決めます。',
      example: '例：同伴者ごとに「名前・年齢」を追加してもらう',
    },
  },
  // treasure-b1-palette: rating(入力)・signature(高度)・video(装飾) を additive。
  {
    type: 'rating', label: '評価', icon: '⭐', category: '入力',
    help: {
      summary: '満足度などを、星や数字で評価してもらえます。',
      howTo: '星5段階、良い・悪い、0〜10、点数から答え方を選びます。質問に合う評価の形を1つ選んでください。',
      example: '例：アンケートで満足度を星5段階で聞く',
    },
  },
  {
    type: 'signature', label: '署名', icon: '✍️', category: '高度',
    help: {
      summary: '画面に手書きで署名してもらえます。',
      howTo: '申し込み内容や同意事項を確認してもらうときに使います。回答者には、公開フォーム上でサインしてもらいます。',
      example: '例：利用規約を確認したあとに署名してもらう',
    },
  },
  {
    type: 'section', label: '見出し＋説明', icon: '🔖', category: '装飾',
    help: {
      summary: 'フォームの途中に見出しと説明文を表示できます。',
      howTo: '質問を内容ごとに分けるときに置きます。次の質問への案内や注意書きも添えられます。',
      example: '例：住所の質問の前に「お届け先について」と表示する',
    },
  },
  {
    type: 'page_break', label: '改ページ', icon: '➖', category: '装飾',
    help: {
      summary: 'フォームを次のページに分けられます。',
      howTo: '質問が多いときに、内容の区切りへ置きます。回答者が一度に見る質問を減らせます。',
      example: '例：基本情報の入力後にページを分け、アンケートを表示する',
    },
  },
  {
    type: 'video', label: '動画', icon: '🎬', category: '装飾',
    help: {
      summary: 'YouTubeやVimeoなどの動画をフォーム内で再生できます。',
      howTo: '対応する動画のURL（動画の場所）を貼ります。次に、見やすい表示サイズを選びます。',
      example: '例：商品紹介の動画を見てもらってから質問に答えてもらう',
    },
  },
  // form-image-decoration: 差し込み画像 (フォーム途中の画像 / 先頭に置けば帯ヘッダーにもなる)。additive。
  {
    type: 'image', label: '画像', icon: '🖼️', category: '装飾',
    help: {
      summary: '画像をフォームの途中に表示できます。',
      howTo: '画像を選ぶかURL（画像の場所）を指定します。表示幅と、画像が見えない人向けの説明も入力します。',
      example: '例：キャンペーンの案内画像を質問の前に表示する',
    },
  },
]

/**
 * rating の sub_type UI 露出リスト (treasure-b1-palette / picker が参照)。
 * embeded は pull 安全のため型は受理するが UI には出さない (4 種)。star = 既定 (UI は star 選択時 config.ratingSubType を undefined に写像)。
 */
export const RATING_SUB_TYPE_OPTIONS: { value: RatingSubType; label: string }[] = [
  { value: 'star', label: '星（5段階）' },
  { value: 'like_dislike', label: '良い / 悪い' },
  { value: 'nps', label: 'NPS（0〜10）' },
  { value: 'score', label: '点数' },
]

/** Formaloo variable field で実測済みの sub_type 4 種。 */
export const VARIABLE_SUB_TYPE_OPTIONS: { value: VariableSubType; label: string }[] = [
  { value: 'int', label: '整数（計算しない値）' },
  { value: 'string', label: '文字（計算しない値）' },
  { value: 'decimal', label: '小数（計算しない値）' },
  { value: 'formula', label: '計算式' },
]

/**
 * b1-field-polish: video(oembed) の表示サイズ preset (小/中/大→高さ px)。builder の per-field 動画サイズ select が参照。
 * 全 preset が再生可能サイズ (既定 100px 薄帯より大)。値は videoHeight whitelist (/^\d{2,4}(px|vw)$/) を満たす。
 * 未選択 (空) は push 時 DEFAULT_VIDEO_HEIGHT (250px) を補完 = builder は「（既定）」表示。
 */
export const VIDEO_SIZE_PRESETS: { value: string; label: string }[] = [
  { value: '200px', label: '小' },
  { value: '280px', label: '中' },
  { value: '400px', label: '大' },
]

/**
 * form-image-decoration: 差し込み画像の表示幅プリセット (小40%/中70%/全幅100% / owner ②「ストレス無く」)。
 * image-field-panel の幅 picker が参照。値は shared ImageWidth enum → canonical <img> の max-width % に射影
 * (spike S-1 実測: max-width % が hosted で効く = スマホでも親コンテナ相対で破綻しない)。既定 medium。
 */
export const IMAGE_WIDTH_OPTIONS: { value: ImageWidth; label: string }[] = [
  { value: 'small', label: '小（40%）' },
  { value: 'medium', label: '中（70%）' },
  { value: 'full', label: '全幅（100%）' },
]

/**
 * b1-field-polish: 評価スター色の curated パレット (form-level 星色 picker が参照)。先頭 = 既定黄 (単一正本)。
 * 各色は白地/黒地の両方で視認可能なレンジに curated (相対輝度 40〜230 = コントラスト保証 / R3)。
 */
export const RATING_STAR_PALETTE: { value: string; label: string }[] = [
  { value: DEFAULT_RATING_STAR_COLOR, label: '黄' }, // #F5B301 (既定)
  { value: '#E39A00', label: '金' },
  { value: '#FB8C00', label: '橙' },
  { value: '#E53935', label: '赤' },
  { value: '#EC407A', label: '桃' },
  { value: '#3B82F6', label: '青' },
  { value: '#22C55E', label: '緑' },
  { value: '#8B5CF6', label: '紫' },
]

export const FIELD_CATEGORIES: FieldCategory[] = ['入力', '選択', '高度', '装飾']

export { isDecorationType }
export const isDecoration = isDecorationType

/** 既存の計算式・条件分岐から参照できる scalar field。構造 field だけを additive に除外する。 */
export function isScalarReferenceType(type: HarnessFieldType): boolean {
  return !isDecorationType(type) && type !== 'matrix' && type !== 'repeating_section'
}

/** repeating_section の列として選べる通常入力 field（計算 variable は列コンテナへ入れない）。 */
export function isRepeatingColumnType(type: HarnessFieldType): boolean {
  return isScalarReferenceType(type) && type !== 'variable'
}

export function fieldTypeLabel(type: HarnessFieldType): string {
  return FIELD_TYPE_META.find((m) => m.type === type)?.label ?? type
}
export function fieldTypeIcon(type: HarnessFieldType): string {
  return FIELD_TYPE_META.find((m) => m.type === type)?.icon ?? '❓'
}

/** 種別が「選択肢を持つ」か (choice/dropdown/multiple_select)。 */
export function hasChoices(type: HarnessFieldType): boolean {
  return type === 'choice' || type === 'dropdown' || type === 'multiple_select'
}
/** 種別が「文字数制限を持つ」か (text/textarea)。 */
export function hasLength(type: HarnessFieldType): boolean {
  return type === 'text' || type === 'textarea'
}
/**
 * 種別が「公開フォームで実効する最大文字数を設定できる」か。
 * 一行テキスト (short_text) のみ = Formaloo が max_length を hosted で enforce する唯一の型 (spike 実測 / OD-2)。
 * 複数行 (long_text) は Formaloo が max_length を無視するため対象外 (効かない欄=footgun を出さない)。
 */
export function hasMaxLength(type: HarnessFieldType): boolean {
  return type === 'text'
}
/** 種別が「評価スタイル(sub_type)を選べる」か (treasure-b1-palette / rating のみ)。 */
export function hasRatingSubType(type: HarnessFieldType): boolean {
  return type === 'rating'
}
