/**
 * ビルダーの開始テンプレ (F8 / D-4)。ネイルサロン文脈の実用サンプル文言入り。
 *
 * 制約 (Codex HIGH / tasks C2):
 *   - プレースホルダ画像 URL は必ず https の実在 URL。http/相対だと validateFlex.fail になる。
 *     → https://placehold.co (公開 https placeholder サービス) を使用。運用者は画像部品で差し替える。
 *   - tracked link 部分はテンプレでは URL 直接 (https) を既定。tracked 選択は C3 で運用者が設定。
 *   - サムネは FlexPreview の縮小描画で出すため、別途画像ファイルは用意しない (常に実物と一致)。
 */
import type { BuilderModel } from './types';

/** テンプレ用プレースホルダ画像 (https 必須)。運用者がアップローダで差し替える。 */
const PH = {
  campaign: 'https://placehold.co/1040x676/06C755/ffffff?text=%E3%82%AD%E3%83%A3%E3%83%B3%E3%83%9A%E3%83%BC%E3%83%B3%E7%94%BB%E5%83%8F',
  booking: 'https://placehold.co/1040x676/eeeeee/333333?text=%E3%82%B5%E3%83%AD%E3%83%B3%E3%81%AE%E5%86%99%E7%9C%9F',
  product1: 'https://placehold.co/800x800/f4c2c2/333333?text=%E5%95%86%E5%93%811',
  product2: 'https://placehold.co/800x800/c2d4f4/333333?text=%E5%95%86%E5%93%812',
} as const;

let counter = 0;
/** テンプレ複製時に一意 id を振る (React key / 選択管理用)。 */
export function nextId(prefix = 'p'): string {
  counter += 1;
  return `${prefix}${counter}_${Math.random().toString(36).slice(2, 7)}`;
}

export interface FlexTemplate {
  key: string;
  label: string; // 運用者向けの日本語ラベル (専門語ゼロ)
  model: BuilderModel;
}

/** 「まっさら」= 空 1 枚。パレットから足していく。 */
export function blankModel(): BuilderModel {
  return { cards: [{ id: nextId('card'), parts: [] }] };
}

/** テンプレ実データ。id は固定 (テスト安定) だが、開くときは deep-clone して新 id を振る (cloneTemplate)。 */
export const NAIL_TEMPLATES: FlexTemplate[] = [
  {
    key: 'campaign',
    label: 'キャンペーン告知',
    model: {
      cards: [
        {
          id: 'campaign-card',
          parts: [
            { kind: 'image', id: 'campaign-img', url: PH.campaign, aspect: 'landscape', rounded: true },
            { kind: 'heading', id: 'campaign-h', text: '春の新色ネイル 20%OFF' },
            {
              kind: 'body',
              id: 'campaign-b',
              text: '3月末まで、人気の春カラーが全メニュー20%OFF。この機会にぜひご予約ください。',
            },
            { kind: 'separator', id: 'campaign-sep' },
            {
              kind: 'button',
              id: 'campaign-btn',
              label: '今すぐ予約する',
              style: 'primary',
              link: { type: 'url', uri: 'https://example.com/booking' },
            },
          ],
        },
      ],
    },
  },
  {
    key: 'booking',
    label: '予約案内',
    model: {
      cards: [
        {
          id: 'booking-card',
          parts: [
            { kind: 'image', id: 'booking-img', url: PH.booking, aspect: 'landscape', rounded: true },
            { kind: 'heading', id: 'booking-h', text: 'ご予約はこちらから' },
            {
              kind: 'body',
              id: 'booking-b',
              text: 'ネットで24時間いつでもご予約いただけます。お電話でのご予約も承っております。',
            },
            {
              kind: 'button',
              id: 'booking-btn1',
              label: 'ネットで予約',
              style: 'primary',
              link: { type: 'booking', uri: 'https://example.com/booking' },
            },
            { kind: 'spacer', id: 'booking-sp' },
            {
              kind: 'button',
              id: 'booking-btn2',
              label: '電話で予約',
              style: 'secondary',
              link: { type: 'tel', phone: '0312345678', uri: 'tel:0312345678' },
            },
          ],
        },
      ],
    },
  },
  {
    key: 'products',
    label: '商品を横に並べる',
    // carousel 実例: 最初から 2 カードで「横に並ぶ」を体感させる。
    model: {
      cards: [
        {
          id: 'product-card1',
          parts: [
            { kind: 'image', id: 'product-img1', url: PH.product1, aspect: 'square', rounded: true },
            { kind: 'heading', id: 'product-h1', text: 'ジェルネイル 定番コース' },
            { kind: 'body', id: 'product-b1', text: '長持ちで人気の定番。デザイン自由。', size: 'sm' },
            {
              kind: 'button',
              id: 'product-btn1',
              label: '詳しく見る',
              style: 'primary',
              link: { type: 'url', uri: 'https://example.com/menu/gel' },
            },
          ],
        },
        {
          id: 'product-card2',
          parts: [
            { kind: 'image', id: 'product-img2', url: PH.product2, aspect: 'square', rounded: true },
            { kind: 'heading', id: 'product-h2', text: 'ケア＋ハンドコース' },
            { kind: 'body', id: 'product-b2', text: '爪のケアとハンドマッサージ付き。', size: 'sm' },
            {
              kind: 'button',
              id: 'product-btn2',
              label: '詳しく見る',
              style: 'primary',
              link: { type: 'url', uri: 'https://example.com/menu/care' },
            },
          ],
        },
      ],
    },
  },
];

/** テンプレを開くときは deep-clone して全 id を新しく振る (元データを汚さない / 複数開いても衝突しない)。 */
export function cloneTemplate(tpl: FlexTemplate): BuilderModel {
  return {
    cards: tpl.model.cards.map((card) => ({
      id: nextId('card'),
      parts: card.parts.map((part) => ({ ...part, id: nextId('part') })),
    })),
  };
}
