import { describe, expect, test } from 'vitest';
import { isFriendSystemAlias, toFormalooFieldPayload, type HarnessField } from '@line-crm/shared';
import { buildPullResult } from './formaloo-pull.js';

// =============================================================================
// fr-id-capture-fix / T-C6 (codex#13): admin 一覧/編集/copy レスポンスで system hidden field を露出しない +
//   予約 alias (fr_id/fr_name) を user が builder/import から作成できない。
//   - admin editor / copy は Formaloo 定義を buildPullResult (harness 変換) で読む。system field は harness fields に
//     混入しない (C4) = 編集画面に「編集可能フィールド」として現れない (非表示)。
//   - harness field モデルに alias は無く toFormalooFieldPayload は alias を emit しない = user は予約 alias を作れない。
// =============================================================================
const resolveId = (slug: string) => slug;
function body(fieldsList: unknown[]) {
  return { data: { form: { fields_list: fieldsList } } };
}

describe('admin system-field exposure (T-C6)', () => {
  test('admin 編集/コピー: hidden な fr_id/fr_name も、user が Formaloo UI で作った visible fr_id も harness fields に露出しない', () => {
    const res = buildPullResult(
      body([
        { slug: 's1', type: 'short_text', title: '名前', position: 0, required: true },
        { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'sys id', position: 1 },
        { slug: 'h2', type: 'hidden', alias: 'fr_name', title: 'sys name', position: 2 },
        // user が Formaloo 管理画面で誤って alias=fr_id の visible field を作ったケースも editor に出さない
        { slug: 'u1', type: 'short_text', alias: 'fr_id', title: 'user visible fr_id', position: 3 },
      ]),
      resolveId,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 通常 field のみ (system alias 系は全除外 = admin editor が「編集可能フィールド」として描画しない)
    expect(res.fields.map((f) => f.id)).toEqual(['s1']);
    expect(res.fields.some((f) => isFriendSystemAlias(f.id))).toBe(false);
  });

  test('user は builder/import から予約 alias を持つ field を作れない (harness field 変換は alias を emit しない)', () => {
    // ラベルに fr_id/fr_name を入れても alias にはならない (alias は harness モデルに存在しない)。
    const attempts: HarnessField[] = [
      { id: 'x', type: 'text', label: 'fr_id', required: false, position: 0, config: {} },
      { id: 'y', type: 'text', label: 'fr_name', required: false, position: 1, config: { description: 'fr_id' } },
      { id: 'z', type: 'dropdown', label: 'fr_id 選択', required: false, position: 2, config: { choices: ['fr_id'] } },
    ];
    for (const f of attempts) {
      const payload = toFormalooFieldPayload(f);
      expect('alias' in payload).toBe(false);
    }
  });
});
