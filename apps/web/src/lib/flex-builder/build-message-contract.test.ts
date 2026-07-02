/**
 * 契約テスト (T-A6 / success_observable 4) — C1 最上流の核。
 *
 * ビルダーの buildModelToFlex 出力を **実物の** worker buildMessage flex ロジック
 * (unwrapFlexMessageObject) に通し、MessageBuildError を投げず bare contents として
 * そのまま {type:'flex',...,contents} に包めることを保証する。
 *
 * これが崩れると「保存はできたのに送信時に初めて壊れる」= owner が報告した failure。
 * 再現テストではなく、worker の実 message-build.ts を vitest alias で import して往復する。
 */
import { describe, test, expect } from 'vitest';
// vitest.config.ts の alias で worker の本物を解決 (再現ではない実物)
import { unwrapFlexMessageObject, MessageBuildError } from '@worker/message-build';
import { buildModelToFlex } from './to-flex';
import { NAIL_TEMPLATES } from './templates';
import type { BuilderModel } from './types';

/**
 * worker buildMessage('flex', ...) の flex 分岐を実物ロジックで再現 (parse + unwrap のみ)。
 * unwrapFlexMessageObject は worker の本物なので、契約の核はここで実物検証される。
 */
function buildFlexMessage(messageContent: string): { type: 'flex'; contents: object } {
  const parsed = JSON.parse(messageContent);
  const { contents } = unwrapFlexMessageObject(parsed);
  return { type: 'flex', contents };
}

function toContent(model: BuilderModel): string {
  return JSON.stringify(buildModelToFlex(model));
}

describe('buildModelToFlex ↔ worker buildMessage 契約 (実物往復)', () => {
  test('T-A6: 1 カード bubble 出力が buildMessage を通り bare contents である', () => {
    const content = toContent({
      cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'p', text: 'お知らせ' }] }],
    });
    const msg = buildFlexMessage(content);
    expect(msg.type).toBe('flex');
    // bare contents = そのまま bubble (message object ラップされていない = unwrap 不要)
    expect((msg.contents as { type: string }).type).toBe('bubble');
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('bubble'); // 保存 JSON 自体が bare bubble
    expect(parsed.altText).toBeUndefined(); // message object でない証拠
  });

  test('T-A6: carousel 出力が buildMessage を通り bare carousel である', () => {
    const content = toContent({
      cards: [
        { id: 'a', parts: [{ kind: 'body', id: 'p1', text: 'A' }] },
        { id: 'b', parts: [{ kind: 'body', id: 'p2', text: 'B' }] },
      ],
    });
    const msg = buildFlexMessage(content);
    expect((msg.contents as { type: string }).type).toBe('carousel');
  });

  test('T-A6: 画像リンク hero-only bubble (画像リッチ化) が buildMessage を通る', () => {
    // 画像リッチ化 ON = hero 画像 1 枚だけの単一 bubble (plan 判断A)
    const content = toContent({
      cards: [
        {
          id: 'c',
          parts: [
            {
              kind: 'image',
              id: 'p',
              url: 'https://ex.com/hero.jpg',
              tapLink: { type: 'url', uri: 'https://ex.com/go' },
            },
          ],
        },
      ],
    });
    const msg = buildFlexMessage(content);
    expect(msg.type).toBe('flex');
    expect((msg.contents as { type: string }).type).toBe('bubble');
  });

  test('3 テンプレの出力がすべて buildMessage を投げずに通る', () => {
    for (const tpl of NAIL_TEMPLATES) {
      const content = JSON.stringify(buildModelToFlex(tpl.model));
      expect(() => buildFlexMessage(content)).not.toThrow();
    }
  });

  test('念のため: 実物 unwrapFlexMessageObject は不正 payload で MessageBuildError を投げる (fail-closed 生存確認)', () => {
    expect(() => unwrapFlexMessageObject('壊れた文字列' as unknown)).toThrow(MessageBuildError);
  });
});
