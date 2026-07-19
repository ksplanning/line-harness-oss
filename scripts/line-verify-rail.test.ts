import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { verifySignature } from '../packages/line-sdk/src/webhook.js';

const railPath = resolve(process.cwd(), 'scripts/line-verify-rail.ts');
const registryPath = resolve(process.cwd(), 'scripts/line-verify-scenarios.json');

type RailModule = typeof import('./line-verify-rail.js');

async function loadRail(): Promise<RailModule> {
  expect(existsSync(railPath), 'rail implementation must exist').toBe(true);
  return import('./line-verify-rail.js');
}

describe('LINE verification rail', () => {
  test('generates a LINE-compatible signature and rejects a tampered signature', async () => {
    const rail = await loadRail();
    const rawBody = JSON.stringify({ destination: 'U-test-destination', events: [] });
    const signature = rail.createLineSignature('test-channel-secret', rawBody);

    await expect(verifySignature('test-channel-secret', rawBody, signature)).resolves.toBe(true);
    await expect(
      verifySignature('test-channel-secret', rawBody, rail.tamperSignature(signature)),
    ).resolves.toBe(false);
  });

  test('builds follow/message/postback fixtures that cannot address a LINE user', async () => {
    const rail = await loadRail();
    const fixture = rail.buildWebhookFixture(1_721_350_800_000);

    expect(fixture.events.map((event) => event.type)).toEqual([
      'follow',
      'message',
      'postback',
    ]);
    for (const event of fixture.events) {
      expect(event.source).toEqual({ type: 'group', groupId: 'line-verify-rail-test-group' });
      expect('userId' in event.source).toBe(false);
    }
  });

  test('fails closed before network I/O for non-test or write-capable webhook targets', async () => {
    const rail = await loadRail();
    const fixture = rail.buildWebhookFixture(1_721_350_800_000);
    const safeTarget = {
      id: 'safe',
      testOnly: true,
      url: 'https://worker.example.test/webhook',
      allowedOrigin: 'https://worker.example.test',
      allowedPath: '/webhook',
      sourcePolicy: 'group-without-user' as const,
    };

    expect(() => rail.assertSafeWebhookRequest(safeTarget, safeTarget.url, fixture)).not.toThrow();
    expect(() =>
      rail.assertSafeWebhookRequest({ ...safeTarget, testOnly: false }, safeTarget.url, fixture),
    ).toThrow(/test-only/i);
    expect(() =>
      rail.assertSafeWebhookRequest(safeTarget, 'https://other.example.test/webhook', fixture),
    ).toThrow(/allowlist/i);

    const writeCapable = structuredClone(fixture);
    writeCapable.events[0]!.source = { type: 'user', userId: 'U-owner' } as never;
    expect(() => rail.assertSafeWebhookRequest(safeTarget, safeTarget.url, writeCapable)).toThrow(
      /user/i,
    );
  });

  test('keeps the scenario registry machine-readable and rejects unknown verification ids', async () => {
    const rail = await loadRail();
    expect(existsSync(registryPath), 'scenario registry must exist').toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

    expect(() => rail.validateScenarioRegistry(registry)).not.toThrow();
    expect(Object.keys(registry.caseTypes)).toEqual(
      expect.arrayContaining(['webhook', 'liff-form', 'worker-change', 'all']),
    );

    const invalid = structuredClone(registry);
    invalid.caseTypes.webhook.push('unknown-verification');
    expect(() => rail.validateScenarioRegistry(invalid)).toThrow(/unknown-verification/);
    expect(() => rail.parseCli(['--registry', '/tmp/unreviewed.json'])).toThrow(/unknown option/i);
  });

  test('plans the complete LINE-UA form flow and requires an exact test marker', async () => {
    const rail = await loadRail();
    const target = {
      id: 'test-form',
      testOnly: true,
      formId: 'form-test-1',
      url: 'https://forms.example.test/test-form',
      allowedOrigins: ['https://forms.example.test'],
      markerText: 'LINE VERIFY RAIL TEST ONLY',
      fieldId: 'rail_name',
      fieldSelector: 'input[name="rail_name"]',
      submitSelector: 'button[type="submit"]',
      successText: 'LINE VERIFY RAIL SUBMITTED',
      submissionOrigins: ['https://api.forms.example.test'],
      submissionPath: '/v3.0/form-displays/slug/form-test-1/submit/',
      prefillParam: 'rail_name',
      initialValue: 'rail-prefill',
      editedValue: 'rail-edited',
    };

    expect(() => rail.assertSafeFormTarget(target)).not.toThrow();
    expect(rail.buildFormProbePlan(target).map((step) => step.phase)).toEqual([
      'initial',
      'prefill',
      'submit',
      'reentry',
      'edit',
    ]);
    expect(rail.LINE_USER_AGENT).toContain('Line/');
    expect(() => rail.assertSafeFormTarget({ ...target, testOnly: false })).toThrow(/test-only/i);
    expect(() => rail.assertSafeFormTarget({ ...target, markerText: '' })).toThrow(/marker/i);
    expect(() =>
      rail.assertAllowedNavigation(target, 'https://redirect.example.test/escaped'),
    ).toThrow(/allowlist/i);
    expect(() =>
      rail.assertAllowedNavigation(target, 'https://forms.example.test/other-form'),
    ).toThrow(/allowlist/i);

    const liveIdentity = {
      formId: 'form-test-1',
      address: 'test-form',
      title: 'LINE VERIFY RAIL TEST ONLY',
      successMessage: 'LINE VERIFY RAIL SUBMITTED',
      fieldSlugs: ['rail_name'],
    };
    expect(() => rail.assertLiveFormIdentity(target, liveIdentity)).not.toThrow();
    expect(() =>
      rail.assertLiveFormIdentity(target, { ...liveIdentity, formId: 'owner-form' }),
    ).toThrow(/form id/i);
  });

  test('requires a successful submission response after each form action', async () => {
    const rail = await loadRail();
    const target = {
      id: 'test-form',
      testOnly: true,
      formId: 'form-test-1',
      url: 'https://forms.example.test/test-form',
      allowedOrigins: ['https://forms.example.test'],
      markerText: 'LINE VERIFY RAIL TEST ONLY',
      fieldId: 'rail_name',
      fieldSelector: 'input[name="rail_name"]',
      submitSelector: 'button[type="submit"]',
      successText: 'LINE VERIFY RAIL SUBMITTED',
      submissionOrigins: ['https://api.forms.example.test'],
      submissionPath: '/v3.0/form-displays/slug/form-test-1/submit/',
      prefillParam: 'rail_name',
      initialValue: 'rail-prefill',
      editedValue: 'rail-edited',
    };
    const responses = [
      { requestId: '1', method: 'GET', url: target.url, status: 200, mimeType: 'text/html' },
      { requestId: '2', method: 'POST', url: 'https://owner-api.example.test/rows', status: 201, mimeType: 'application/json' },
      { requestId: 'owner', method: 'POST', url: 'https://api.forms.example.test/v3.0/form-displays/slug/owner-form/submit/', status: 201, mimeType: 'application/json' },
      { requestId: '3', method: 'POST', url: 'https://api.forms.example.test/v3.0/form-displays/slug/form-test-1/submit/', status: 201, mimeType: 'application/json' },
    ];

    expect(rail.findSuccessfulSubmissionResponse(target, responses, 1)).toMatchObject({
      requestId: '3',
      method: 'POST',
      status: 201,
    });
    expect(rail.findSuccessfulSubmissionResponse(target, responses, 4)).toBeUndefined();
  });

  test('redacts secrets, signature headers, and query values from persisted evidence', async () => {
    const rail = await loadRail();
    const evidence = rail.sanitizeEvidence(
      {
        headers: {
          'X-Line-Signature': 'signed-value',
          Authorization: 'Bearer owner-secret',
        },
        url: 'https://forms.example.test/test?rail_name=private-value',
        channelSecret: 'owner-secret',
        validSignatureAccepted: true,
        nested: { ok: true },
      },
      ['owner-secret', 'signed-value', 'private-value'],
    );
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain('owner-secret');
    expect(serialized).not.toContain('signed-value');
    expect(serialized).not.toContain('private-value');
    expect(serialized).toContain('[REDACTED]');
    expect(evidence).toMatchObject({ validSignatureAccepted: true });
  });

  test('uses Wrangler pretty tail output because JSON mode suppresses readiness messages', async () => {
    const rail = await loadRail();
    const args = rail.buildWranglerTailArgs({
      id: 'safe',
      testOnly: true,
      url: 'https://worker.example.test/webhook',
      allowedOrigin: 'https://worker.example.test',
      allowedPath: '/webhook',
      sourcePolicy: 'group-without-user',
      workerName: 'test-worker',
      wranglerConfig: 'apps/worker/wrangler.test.toml',
    });

    expect(args).toContain('pretty');
    expect(args).not.toContain('json');
    expect(rail.isWranglerTailReady('Successfully created tail, expires later')).toBe(false);
    expect(rail.isWranglerTailReady('Connected to test-worker, waiting for logs...')).toBe(true);
    expect(rail.WRANGLER_TAIL_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
    expect(rail.TAIL_BRANCH_MAX_ATTEMPTS).toBe(3);
  });
});
