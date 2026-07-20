import { describe, expect, test } from 'vitest';
import { formalooDefinitionFingerprint } from '@line-crm/shared';
import { decideDriftAction } from './formaloo-drift';

const LIVE_GET_FIELDS = ['yes_no', 'time', 'website', 'city'].map((type, position) => ({
  slug: `remote-${type}`,
  type,
  title: `${type} label`,
  required: position % 2 === 0,
  position,
  config: {},
  invisible: false,
  admin_only: false,
  read_only: false,
}));

describe('treasure E1 field parts — drift projection', () => {
  test('GET read-backのserver defaultsだけではfalse-driftを出さず、意味変更だけ通知する', async () => {
    const baseline = await formalooDefinitionFingerprint(LIVE_GET_FIELDS, []);
    const semanticallySame = LIVE_GET_FIELDS.map(({ invisible: _i, admin_only: _a, read_only: _r, config: _c, ...field }) => field);
    const sameFingerprint = await formalooDefinitionFingerprint(semanticallySame, []);
    expect(sameFingerprint).toBe(baseline);
    expect(decideDriftAction({
      baseline,
      fingerprint: sameFingerprint,
      weakened: false,
      syncStatus: 'idle',
      autoApplyEnabled: false,
    })).toBe('none');

    const changedFingerprint = await formalooDefinitionFingerprint(
      LIVE_GET_FIELDS.map((field, index) => index === 0 ? { ...field, title: 'changed label' } : field),
      [],
    );
    expect(decideDriftAction({
      baseline,
      fingerprint: changedFingerprint,
      weakened: false,
      syncStatus: 'idle',
      autoApplyEnabled: false,
    })).toBe('notified');
  });
});
