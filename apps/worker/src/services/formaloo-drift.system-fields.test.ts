import { describe, expect, test } from 'vitest';
import { formalooDefinitionFingerprint } from '@line-crm/shared';
import { decideDriftAction } from './formaloo-drift.js';
import { checkSystemFieldHealth } from './formaloo-system-fields.js';

// =============================================================================
// fr-id-capture-fix / T-C5: drift/fingerprint は予約 friend system field を除外する (false-drift ゼロ)。
//   (1) system field 有無で fingerprint/drift 判定不変 — auto-push した hidden field が「未知 field」として
//       drift 誤検知・pull 逆流を起こさない (共通 projection = canonicalDefinitionProjection 経由)。
//   (3) 通常 drift とは別建ての system-field 健全性チェックが削除/visible化/型変更/重複を検知する。
// =============================================================================

const baseFields = [
  { slug: 's1', type: 'short_text', title: '名前', position: 0, required: true },
  { slug: 's2', type: 'email', title: 'メール', position: 1, required: false },
];

describe('fingerprint/drift system-field exclusion (T-C5(1))', () => {
  test('type=hidden の fr_id/fr_name を足しても fingerprint byte 不変 (false-drift ゼロ)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    const withSys = [
      ...baseFields,
      { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'sys id', position: 2 },
      { slug: 'h2', type: 'hidden', alias: 'fr_name', title: 'sys name', position: 3 },
    ];
    expect(await formalooDefinitionFingerprint(withSys, [])).toBe(fpBase);
  });

  test('subset 型(short_text)の予約 alias でも fingerprint 不変 (type filter でなく alias filter が効く芯)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    // 予約 alias を subset 型で作ると、alias 除外が無ければ fingerprint が変わってしまう = false-drift。
    const withSysSubset = [
      ...baseFields,
      { slug: 'h1', type: 'short_text', alias: 'fr_id', title: 'sys id', position: 2 },
    ];
    expect(await formalooDefinitionFingerprint(withSysSubset, [])).toBe(fpBase);
  });

  test('drift 判定: system field 追加後も baseline と一致 → decideDriftAction=none (誤検知しない)', async () => {
    const baseline = await formalooDefinitionFingerprint(baseFields, []);
    const withSys = [...baseFields, { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'x', position: 2 }];
    const fingerprint = await formalooDefinitionFingerprint(withSys, []);
    const action = decideDriftAction({ baseline, fingerprint, weakened: 0, syncStatus: 'idle', autoApplyEnabled: false });
    expect(action).toBe('none');
  });

  test('通常 field の変更は依然 fingerprint を変える (除外が通常 drift 検知を潰していない)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    const changed = [{ ...baseFields[0], title: '氏名変更' }, baseFields[1]];
    expect(await formalooDefinitionFingerprint(changed, [])).not.toBe(fpBase);
  });
});

describe('system-field 健全性チェック (T-C5(3): drift とは別建て)', () => {
  test('exactly-one hidden なら健全 / 削除・visible化・重複を検知', () => {
    const healthy = [
      ...baseFields,
      { slug: 'h1', alias: 'fr_id', type: 'hidden' },
      { slug: 'h2', alias: 'fr_name', type: 'hidden' },
    ];
    expect(checkSystemFieldHealth(healthy, { includeOwnerGated: true }).ok).toBe(true);

    // 削除 (fr_id 消失)
    expect(checkSystemFieldHealth(baseFields, { includeOwnerGated: false }).issues.find((i) => i.alias === 'fr_id')?.issue).toBe('missing');
    // visible 化 (型変更)
    expect(
      checkSystemFieldHealth([{ slug: 'h1', alias: 'fr_id', type: 'short_text' }], { includeOwnerGated: false }).issues.find((i) => i.alias === 'fr_id')?.issue,
    ).toBe('not_hidden');
  });
});
