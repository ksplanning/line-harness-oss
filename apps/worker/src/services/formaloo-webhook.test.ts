import { describe, expect, test } from 'vitest';
import {
  timingSafeEqualStr,
  verifyWebhookToken,
  parseWebhookPayload,
  verifyHmacSignature,
} from './formaloo-webhook.js';
import { signFriendToken } from './formaloo-friend-token.js';

// =============================================================================
// F-3 / T-C1 — Formaloo webhook 認証 & payload 正規化 (純関数)。
//   - path token 検証 (推測不能 shared-secret / N-4)
//   - HMAC 署名 + timestamp 窓 (±5分 replay 拒否 / N-12)
//   - payload whitelist 抽出 (submission id / slug / answers / friend / M-21)
// =============================================================================

describe('timingSafeEqualStr', () => {
  test('等値は true / 非等値・長さ違いは false', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});

describe('verifyWebhookToken (path token / N-4)', () => {
  test('expected 未設定なら常に false (fail-closed: dev では token 検証不能=非承認)', () => {
    expect(verifyWebhookToken('anything', undefined)).toBe(false);
    expect(verifyWebhookToken('anything', '')).toBe(false);
  });
  test('一致で true / 不一致で false', () => {
    expect(verifyWebhookToken('s3cr3t-token', 's3cr3t-token')).toBe(true);
    expect(verifyWebhookToken('wrong', 's3cr3t-token')).toBe(false);
  });
});

describe('parseWebhookPayload (whitelist 抽出 / M-21)', () => {
  const now = '2026-07-10T09:00:00+09:00';
  test('submission id 欠落は null (dedup キー無しは処理不能)', async () => {
    expect(await parseWebhookPayload({ data: { answers: {} } }, now)).toBeNull();
    expect(await parseWebhookPayload(null, now)).toBeNull();
    expect(await parseWebhookPayload('not-object', now)).toBeNull();
  });
  test('data.slug + data.form.slug + answers を抽出', async () => {
    const p = await parseWebhookPayload(
      {
        data: {
          slug: 'sub_123',
          form: { slug: 'form_abc' },
          answers: { q1: '田中', friend_id: 'fr_1' },
          created_at: '2026-07-10T08:59:00+09:00',
        },
      },
      now,
    );
    expect(p).not.toBeNull();
    expect(p!.submissionId).toBe('sub_123');
    expect(p!.slug).toBe('form_abc');
    expect(p!.answers).toEqual({ q1: '田中', friend_id: 'fr_1' });
    expect(p!.friendId).toBe('fr_1');
    expect(p!.submittedAt).toBe('2026-07-10T08:59:00+09:00');
  });
  test('submitted_at 欠落は now を採用', async () => {
    const p = await parseWebhookPayload({ id: 'sub_x', answers: {} }, now);
    expect(p!.submissionId).toBe('sub_x');
    expect(p!.submittedAt).toBe(now);
    expect(p!.friendId).toBeNull();
  });
  test('friend は answers の複数キー候補から解決 (f / line_friend_id など)', async () => {
    expect((await parseWebhookPayload({ id: 's', answers: { f: 'fr_2' } }, now))!.friendId).toBe('fr_2');
    expect((await parseWebhookPayload({ id: 's', answers: { line_friend_id: 'fr_3' } }, now))!.friendId).toBe('fr_3');
  });
  test('未知プロパティは answers 以外に漏らさない (whitelist)', async () => {
    const p = (await parseWebhookPayload({ id: 's', evil: 'x', answers: { a: 1 } }, now))!;
    expect(Object.keys(p).sort()).toEqual(['answers', 'friendId', 'rowSlug', 'slug', 'submissionId', 'submittedAt']);
  });
});

describe('parseWebhookPayload — 署名 fr_id 復元 (T-A6 / 順方向)', () => {
  const now = '2026-07-10T09:00:00+09:00';
  const SECRET = 'frtok_parse_test_secret';
  const FRIEND = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  test('rendered_data[fr_id] の署名トークンを verify して friendId を復元 (実 payload 形)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const p = await parseWebhookPayload(
      {
        event_type: 'form_submit',
        data: { slug: 'sub_1', form: { slug: 'form_abc' }, answers: { q1: '田中' } },
        rendered_data: { fr_id: token, fr_name: '田中' },
      },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p).not.toBeNull();
    expect(p!.friendId).toBe(FRIEND);
    // 出力 shape は不変 (whitelist / 5 キー) — event_type 等は 1a では出力に足さない
    expect(Object.keys(p!).sort()).toEqual(['answers', 'friendId', 'rowSlug', 'slug', 'submissionId', 'submittedAt']);
  });

  test('改ざんした fr_id は verify で reject され friendId=null (誤タグ防止 / R-F4)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const tampered = token!.slice(0, -1) + (token!.endsWith('A') ? 'B' : 'A');
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_1', form: { slug: 'form_abc' } }, rendered_data: { fr_id: tampered } },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p!.friendId).toBeNull();
  });

  test('fr_id 欠落 payload (HP 経由) は friendId=null (legacy 候補も無い)', async () => {
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_2', form: { slug: 'form_abc' }, answers: { q1: '匿名' } }, rendered_data: { q1: '匿名' } },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p!.friendId).toBeNull();
  });

  test('署名 fr_id が完全に absent の時のみ legacy 候補 chain で解決 (後方互換 / 旧 hidden field)', async () => {
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_3', form: { slug: 'form_abc' }, answers: { friend_id: 'legacy_fr' } } },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p!.friendId).toBe('legacy_fr');
  });

  test('F-2: 署名 fr_id が present かつ invalid なら legacy chain に落とさず null 確定 (別人誤タグ封鎖 / R-R7)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const tampered = token!.slice(0, -1) + (token!.endsWith('A') ? 'B' : 'A');
    // 攻撃者が「改ざん fr_id + 別 friendId(legacy field)」を同時注入しても別人に解決しない
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_5', form: { slug: 'form_abc' }, answers: { friend_id: 'attacker_other', f: 'attacker_other2' } }, rendered_data: { fr_id: tampered } },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p!.friendId).toBeNull();
  });

  test('F-2: 署名 fr_id が present だが secret 未供給でも legacy chain に落とさず null (検証迂回を許さない)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_6', form: { slug: 'form_abc' }, answers: { friend_id: 'legacy_other' } }, rendered_data: { fr_id: token } },
      now,
      // secret 未供給 (rollback/dev) → 署名検証不能は null 確定 (未署名 chain を信用しない)
    );
    expect(p!.friendId).toBeNull();
  });

  test('F-3: 実 payload 形 (top-level submit_code=row / slug=form / rendered_data=alias) を正しく mapping', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const p = await parseWebhookPayload(
      {
        event_type: 'form_submit',
        submit_code: 'ROW_ABC123',               // row/submission id (top-level)
        slug: 'form_xyz',                         // FORM slug (top-level)
        data: { field_1: '田中', field_2: 'x' },  // field-id map (submission id ではない)
        rendered_data: { fr_id: token, fr_name: '田中', q1: '田中' },
        created_at: '2026-07-11T10:00:00+09:00',
      },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p).not.toBeNull();
    expect(p!.submissionId).toBe('ROW_ABC123');   // submit_code → submission (form-slug へ誤代入しない)
    expect(p!.slug).toBe('form_xyz');             // top-level slug → form slug
    expect(p!.friendId).toBe(FRIEND);             // rendered_data 署名 fr_id 復元
    expect(p!.submittedAt).toBe('2026-07-11T10:00:00+09:00');
    expect(p!.answers).toEqual({ field_1: '田中', field_2: 'x' }); // CX-2: data(field map)→answers 非空
  });

  test('CX-2: 実 payload の data(field map) が answers へ mapping され blank upsert しない (S-1 blocker)', async () => {
    const p = await parseWebhookPayload(
      { submit_code: 'ROW_9', slug: 'form_z', data: { field_a: 'x', field_b: 'y' }, rendered_data: {} },
      now,
    );
    expect(p!.submissionId).toBe('ROW_9');
    expect(Object.keys(p!.answers).length).toBeGreaterThan(0);
    expect(p!.answers).toEqual({ field_a: 'x', field_b: 'y' });
  });

  test('CX-2: legacy 形 (data.answers) は従来どおり data.answers を採り data 全体を混ぜない (回帰なし)', async () => {
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_l', form: { slug: 'form_l' }, answers: { q1: 'A' } } },
      now,
    );
    expect(p!.answers).toEqual({ q1: 'A' }); // slug/form を answers へ混入しない
  });

  test('F-3: submit_code 不在 (legacy 形) では root.slug を form-slug に誤採用しない', async () => {
    // legacy: data.slug=submission / data.form.slug=form。root.slug は無い前提だが、あっても submission 候補のみ。
    const p = await parseWebhookPayload(
      { slug: 'ambiguous', data: { slug: 'sub_leg', form: { slug: 'form_leg' } } },
      now,
    );
    // data.slug が submission に勝ち、form は data.form.slug。root.slug は form-slug に採られない。
    expect(p!.submissionId).toBe('sub_leg');
    expect(p!.slug).toBe('form_leg');
    expect(p!.rowSlug).toBeNull(); // submit_code 不在 = rowSlug capture しない (rows-list resolver に委ねる)
  });

  // ── 弾M (form-post-edit / T-A3): rowSlug additive capture ────────────────────
  describe('T-A3: rowSlug additive capture (root.slug = ROW slug の real 形のみ)', () => {
    test('real 形 (top-level form=form slug / slug=row slug) は rowSlug=root.slug を capture', async () => {
      // 実 Formaloo serialization (live-confirm 2026-07-12): `form` は文字列 form slug・top-level `slug` は ROW slug。
      const p = await parseWebhookPayload(
        {
          submit_code: 'ROW_9x',
          form: 'FORM_SLUG',          // 文字列 form slug (formObj でない = data.form/root.form 経路)
          slug: 'ROWSLUG_20CHARS',    // top-level = ROW slug (form slug と distinct)
          data: { field_1: 'A' },
        },
        now,
      );
      expect(p!.submissionId).toBe('ROW_9x');       // submit_code = harness stored id
      expect(p!.slug).toBe('FORM_SLUG');            // form 文字列 = form slug (台帳照合)
      expect(p!.rowSlug).toBe('ROWSLUG_20CHARS');   // top-level slug = addressable ROW slug (edit 用)
      expect(p!.answers).toEqual({ field_1: 'A' });
    });

    test('fallback 形 (top-level slug が form-slug に消費される) は rowSlug=null', async () => {
      // form キー無し = slug は `submitCode ? root.slug` 経由で form-slug に採られる → row slug 不明 → null。
      const p = await parseWebhookPayload(
        { submit_code: 'ROW_10', slug: 'form_only', data: { field_a: 'x' } },
        now,
      );
      expect(p!.submissionId).toBe('ROW_10');
      expect(p!.slug).toBe('form_only');
      expect(p!.rowSlug).toBeNull(); // root.slug === form slug ゆえ ROW slug として採らない (rows-list resolver 委譲)
    });

    test('既存 real-payload fixture (form キー無し) は rowSlug=null で回帰しない', async () => {
      const p = await parseWebhookPayload(
        { submit_code: 'ROW_ABC123', slug: 'form_xyz', data: { field_1: '田中' } },
        now,
      );
      expect(p!.slug).toBe('form_xyz');
      expect(p!.rowSlug).toBeNull();
    });
  });

  test('alias は上書き可 (friendTokenAlias)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_4', form: { slug: 'form_abc' } }, rendered_data: { line_fr: token } },
      now,
      { friendTokenSecret: SECRET, friendTokenAlias: 'line_fr' },
    );
    expect(p!.friendId).toBe(FRIEND);
  });
});

describe('parseWebhookPayload — S-1 実 Formaloo serialization live-confirm (rendered_data=array / form=string)', () => {
  // 実 Formaloo REST row serialization (S-1 live capture 2026-07-12・使い捨てフォームで実測)。fixture が仮定した
  // 「rendered_data=alias 直引き object / top-level slug=form slug」と実物が乖離していたことを固定する:
  //   - rendered_data は **配列** ([{slug, alias, value}]) = alias 直引き object ではない。
  //   - form slug は 文字列の `form` フィールド。top-level `slug` は ROW(submission) slug (form slug ではない)。
  //   - 署名 fr_id は data[<auto-slug>] と rendered_data[i].value (alias==='fr_id') に載る (data['fr_id'] ではない)。
  const now = '2026-07-10T09:00:00+09:00';
  const SECRET = 'frtok_parse_test_secret';
  const FRIEND = 'fr_testfriend_0001';

  // 実測ペイロード (使い捨てフォーム hatDzKMp の実 row を逐語再現・auto-slug も実物由来)。
  async function realPayload() {
    const token = await signFriendToken(FRIEND, SECRET); // 実 sign アルゴ (base64url HMAC-SHA256[:27])
    return {
      payload: {
        event_type: 'form_submit',
        submit_code: 'gz06eufzfk8skjrhez7w', // top-level = submission(row) id
        slug: 'IdfWDQcstLvY8nC8YmDI', // ⚠️ top-level slug = ROW slug (decoy・form slug ではない)
        form: 'hatDzKMp', // 文字列 form slug (これが台帳照合キー)
        data: {
          // field-id(auto-slug) map。署名 fr_id は hidden field の auto-slug 配下 (alias 'fr_id' ではない)。
          RUEBj39b: token,
          TvIxv7XD: 'テスト太郎',
          oChQGxYk: 'テスト太郎',
        },
        rendered_data: [
          { slug: 'oChQGxYk', alias: null, value: 'テスト太郎' },
          { slug: 'RUEBj39b', alias: 'fr_id', value: token },
          { slug: 'TvIxv7XD', alias: 'fr_name', value: 'テスト太郎' },
        ],
        created_at: '2026-07-12T05:00:00Z',
      },
      token,
    };
  }

  test('submissionId=submit_code (row) ・ slug=文字列 form (row slug に誤代入しない)', async () => {
    const { payload } = await realPayload();
    const p = await parseWebhookPayload(payload, now, { friendTokenSecret: SECRET });
    expect(p).not.toBeNull();
    expect(p!.submissionId).toBe('gz06eufzfk8skjrhez7w'); // = submit_code
    expect(p!.slug).toBe('hatDzKMp'); // = 文字列 form (ROW slug 'IdfWDQ…' ではない)
  });

  test('answers = data(field-id map) 非空 (blank upsert しない / CX-2 実物照合)', async () => {
    const { payload, token } = await realPayload();
    const p = await parseWebhookPayload(payload, now, { friendTokenSecret: SECRET });
    expect(Object.keys(p!.answers).length).toBe(3);
    expect(p!.answers).toEqual({ RUEBj39b: token, TvIxv7XD: 'テスト太郎', oChQGxYk: 'テスト太郎' });
  });

  test('D-3: matrix object / repeating array を opaque な回答値として無変換で保持し fr_id 解決も壊さない', async () => {
    const { payload } = await realPayload();
    // 実回答の exact shape は host 実測待ち。ここでは provider が返す JSON 構造を
    // flatten / String 化せず透過保存する契約だけを固定する。
    const matrixValue = {
      row_a: { col_yes: true, col_note: '第一希望' },
      row_b: { col_yes: false, col_note: null },
    };
    const repeatingValue = [
      { name: '申込者A', quantity: 1 },
      { name: '申込者B', quantity: 2 },
    ];
    Object.assign(payload.data, {
      matrix_field_slug: matrixValue,
      repeating_field_slug: repeatingValue,
    });

    const p = await parseWebhookPayload(payload, now, { friendTokenSecret: SECRET });

    expect(p!.answers.matrix_field_slug).toEqual(matrixValue);
    expect(p!.answers.repeating_field_slug).toEqual(repeatingValue);
    expect(p!.answers.oChQGxYk).toBe('テスト太郎'); // 既存 scalar は不変
    expect(p!.friendId).toBe(FRIEND);
    expect(p!.rowSlug).toBe('IdfWDQcstLvY8nC8YmDI');
  });

  test('fr_id 署名を rendered_data 配列 (alias==="fr_id") の value から復元 (本番 payload 実測)', async () => {
    const { payload } = await realPayload();
    const p = await parseWebhookPayload(payload, now, { friendTokenSecret: SECRET });
    expect(p!.friendId).toBe(FRIEND); // 配列 rendered_data から alias 一致 value を verify して復元
  });

  test('改ざんした fr_id (配列形) は verify で reject → friendId=null (誤タグ防止 / R-F4)', async () => {
    const { payload, token } = await realPayload();
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
    payload.rendered_data = payload.rendered_data.map((e) => (e.alias === 'fr_id' ? { ...e, value: tampered } : e));
    payload.data.RUEBj39b = tampered;
    const p = await parseWebhookPayload(payload, now, { friendTokenSecret: SECRET });
    expect(p!.friendId).toBeNull();
  });

  test('HP 経由 (fr_id alias 不在の配列) は friendId=null (署名も legacy も無い)', async () => {
    const { payload } = await realPayload();
    payload.rendered_data = payload.rendered_data.filter((e) => e.alias !== 'fr_id');
    delete payload.data.RUEBj39b;
    const p = await parseWebhookPayload(payload, now, { friendTokenSecret: SECRET });
    expect(p!.friendId).toBeNull();
    expect(Object.keys(p!.answers).length).toBeGreaterThan(0); // answers は非空のまま
  });
});

describe('verifyHmacSignature (HMAC-SHA256 + timestamp 窓 / N-12)', () => {
  const secret = 'whsec_test';
  const body = '{"data":{"slug":"sub_1"}}';

  async function sign(raw: string, ts?: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const msg = ts ? `${ts}.${raw}` : raw;
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  test('secret 未設定なら false (署名検証不能)', async () => {
    expect(await verifyHmacSignature({ rawBody: body, signature: 'x', secret: undefined })).toBe(false);
  });
  test('正しい署名 (timestamp 無し) は true', async () => {
    const sig = await sign(body);
    expect(await verifyHmacSignature({ rawBody: body, signature: sig, secret })).toBe(true);
  });
  test('改竄 body は false', async () => {
    const sig = await sign(body);
    expect(await verifyHmacSignature({ rawBody: body + 'x', signature: sig, secret })).toBe(false);
  });
  test('timestamp 付き署名: 窓内は true / 窓外は false (replay 拒否)', async () => {
    const ts = '2026-07-10T09:00:00+09:00';
    const nowMs = new Date(ts).getTime();
    const sig = await sign(body, ts);
    expect(await verifyHmacSignature({ rawBody: body, signature: sig, secret, timestamp: ts, nowMs })).toBe(true);
    // 10 分後 = ±5 分窓の外
    expect(await verifyHmacSignature({ rawBody: body, signature: sig, secret, timestamp: ts, nowMs: nowMs + 10 * 60_000 })).toBe(false);
  });
  test('署名フォーマット不正 (空/非 hex) は false', async () => {
    expect(await verifyHmacSignature({ rawBody: body, signature: '', secret })).toBe(false);
    expect(await verifyHmacSignature({ rawBody: body, signature: 'zzzz', secret })).toBe(false);
  });
});
