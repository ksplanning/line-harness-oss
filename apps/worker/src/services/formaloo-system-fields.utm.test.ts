/**
 * treasure-b2-form-settings / D-3・D-4 — UTM managed hidden fields。
 * UTM aliases は friend prefix の後ろ、通常回答 field の前に additive ensure し、pull/fingerprint へ逆流させない。
 */
import { describe, expect, test } from 'vitest';
import { formalooDefinitionFingerprint } from '@line-crm/shared';
import { buildPullResult } from './formaloo-pull.js';
import { ensureSystemHiddenFields, type SystemFieldClient } from './formaloo-system-fields.js';

interface RawField {
  slug: string;
  alias?: string | null;
  type: string;
  title?: string;
  position: number;
  required?: boolean;
}

function makeClient(initial: RawField[]) {
  const state = initial.map((field) => ({ ...field }));
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const moveToPosition = (slug: string, position: number) => {
    const ordered = [...state].sort((a, b) => a.position - b.position);
    const current = ordered.findIndex((field) => field.slug === slug);
    if (current < 0) return;
    const [field] = ordered.splice(current, 1);
    ordered.splice(position, 0, field);
    ordered.forEach((item, index) => { item.position = index; });
    state.splice(0, state.length, ...ordered);
  };

  const client: SystemFieldClient = {
    async get<T = unknown>(path: string) {
      calls.push({ method: 'GET', path });
      return {
        ok: true,
        status: 200,
        data: { data: { form: { fields_list: state.map((field) => ({ ...field })), logic: [] } } } as T,
      };
    },
    async post<T = unknown>(path: string, body?: unknown) {
      calls.push({ method: 'POST', path, body });
      const input = body as { alias: string; type: string; title?: string; position: number };
      const slug = `hidden_${input.alias}`;
      state.push({ slug, alias: input.alias, type: input.type, title: input.title, position: state.length });
      moveToPosition(slug, input.position);
      return { ok: true, status: 201, data: { data: { field: { slug } } } as T };
    },
    async request<T = unknown>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const slug = path.match(/\/v3\.0\/fields\/([^/]+)\//)?.[1];
      const position = (body as { position?: unknown } | undefined)?.position;
      if (method === 'PATCH' && slug && typeof position === 'number') moveToPosition(slug, position);
      return { ok: true, status: 200, data: {} as T };
    },
  };

  return { client, state, calls };
}

const EXPECTED_ALIASES = ['fr_id', 'fr_name', 'utm_source', 'utm_medium', 'utm_campaign'] as const;

describe('ensureSystemHiddenFields includeUtm', () => {
  test('includeUtm=true は friend prefix を守って3 UTM aliasesを通常fieldより前へ作る', async () => {
    const { client, state, calls } = makeClient([
      { slug: 'answer_name', type: 'short_text', title: '名前', position: 0, required: false },
    ]);

    const result = await ensureSystemHiddenFields(client, 'FORM_UTM', {
      includeOwnerGated: true,
      includeUtm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.outOfSync).toBe(false);
    expect(result.outcomes.map((outcome) => outcome.alias)).toEqual(EXPECTED_ALIASES);
    expect(result.outcomes.every((outcome) => outcome.status === 'created')).toBe(true);

    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => (call.body as { alias?: string }).alias).sort()).toEqual([...EXPECTED_ALIASES].sort());
    for (const alias of EXPECTED_ALIASES) {
      expect(posts.find((call) => (call.body as { alias?: string }).alias === alias)?.body).toMatchObject({
        form: 'FORM_UTM',
        type: 'hidden',
        alias,
        position: 0,
      });
    }

    expect([...state].sort((a, b) => a.position - b.position).map((field) => field.alias ?? field.slug)).toEqual([
      ...EXPECTED_ALIASES,
      'answer_name',
    ]);
  });

  test('同じ状態で2回目を実行するとPOST/PATCH 0の冪等 no-op', async () => {
    const fixture = makeClient([
      { slug: 'answer_name', type: 'short_text', title: '名前', position: 0, required: false },
    ]);

    await ensureSystemHiddenFields(fixture.client, 'FORM_UTM', { includeOwnerGated: true, includeUtm: true });
    const callsAfterFirst = fixture.calls.length;
    const second = await ensureSystemHiddenFields(fixture.client, 'FORM_UTM', { includeOwnerGated: true, includeUtm: true });
    const mutationsAfterFirst = fixture.calls
      .slice(callsAfterFirst)
      .filter((call) => call.method === 'POST' || call.method === 'PATCH');

    expect(second.ok).toBe(true);
    expect(second.outcomes.map((outcome) => [outcome.alias, outcome.status])).toEqual(
      EXPECTED_ALIASES.map((alias) => [alias, 'present']),
    );
    expect(mutationsAfterFirst).toEqual([]);
  });

  test('includeUtm未指定は従来どおりUTM fieldを作らない', async () => {
    const { client, calls } = makeClient([
      { slug: 'answer_name', type: 'short_text', title: '名前', position: 0, required: false },
    ]);

    const result = await ensureSystemHiddenFields(client, 'FORM_OFF', { includeOwnerGated: true });

    expect(result.outcomes.map((outcome) => outcome.alias)).toEqual(['fr_id', 'fr_name']);
    expect(calls.some((call) => (
      (call.body as { alias?: string } | undefined)?.alias?.startsWith('utm_')
    ))).toBe(false);
  });

  test('owner gate OFFでも既在fr_nameをprefix anchorとして保持し、UTMより後ろへ押し出さない', async () => {
    const { client, state } = makeClient([
      { slug: 'hidden_fr_id', alias: 'fr_id', type: 'hidden', title: 'friend id', position: 0 },
      { slug: 'hidden_fr_name', alias: 'fr_name', type: 'hidden', title: 'friend name', position: 1 },
      { slug: 'answer_name', type: 'short_text', title: '名前', position: 2, required: false },
    ]);

    const result = await ensureSystemHiddenFields(client, 'FORM_UTM_GATE', {
      includeOwnerGated: false,
      includeUtm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.alias)).toEqual(EXPECTED_ALIASES);
    expect([...state].sort((a, b) => a.position - b.position).map((field) => field.alias ?? field.slug)).toEqual([
      ...EXPECTED_ALIASES,
      'answer_name',
    ]);
  });
});

describe('UTM managed aliases — fingerprint/pull exclusion', () => {
  test('5 hidden prefixによる通常field再採番をfingerprintへ含めない', async () => {
    const base = [
      { slug: 'q1', type: 'short_text', title: '名前', required: false, position: 0 },
      { slug: 'q2', type: 'email', title: 'メール', required: false, position: 1 },
    ];
    const managedPrefix = [
      { slug: 'h-fr-id', type: 'hidden', alias: 'fr_id', title: 'friend id', position: 0 },
      { slug: 'h-fr-name', type: 'hidden', alias: 'fr_name', title: 'friend name', position: 1 },
      { slug: 'h-source', type: 'hidden', alias: 'utm_source', title: 'UTM source', position: 2 },
      { slug: 'h-medium', type: 'hidden', alias: 'utm_medium', title: 'UTM medium', position: 3 },
      { slug: 'h-campaign', type: 'hidden', alias: 'utm_campaign', title: 'UTM campaign', position: 4 },
      { ...base[0], position: 5 },
      { ...base[1], position: 6 },
    ];

    expect(await formalooDefinitionFingerprint(managedPrefix, [])).toBe(
      await formalooDefinitionFingerprint(base, []),
    );
  });

  test('可視UTM aliasは通常回答fieldとしてfingerprint対象に残す', async () => {
    const visible = { slug: 'utm-user-field', type: 'short_text', title: '既存UTM入力', required: false, position: 0 };
    expect(await formalooDefinitionFingerprint([{ ...visible, alias: 'utm_source' }], [])).toBe(
      await formalooDefinitionFingerprint([visible], []),
    );
  });

  test('既存の可視UTM aliasはsystem field扱いせずbuilder pullに残す（既定OFFフォーム不変）', () => {
    const result = buildPullResult(
      {
        data: {
          form: {
            fields_list: [
              { slug: 'q1', type: 'short_text', title: '名前', required: false, position: 0 },
              { slug: 'h-source', type: 'short_text', alias: 'utm_source', title: 'UTM source', required: false, position: 1 },
              { slug: 'h-medium', type: 'short_text', alias: 'utm_medium', title: 'UTM medium', required: false, position: 2 },
              { slug: 'h-campaign', type: 'short_text', alias: 'utm_campaign', title: 'UTM campaign', required: false, position: 3 },
            ],
            logic: [],
          },
        },
      },
      (slug) => slug,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.map((field) => field.id)).toEqual(['q1', 'h-source', 'h-medium', 'h-campaign']);
    expect(result.fieldSlugById).toEqual({
      q1: 'q1',
      'h-source': 'h-source',
      'h-medium': 'h-medium',
      'h-campaign': 'h-campaign',
    });
  });
});
