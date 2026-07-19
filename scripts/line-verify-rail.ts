#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySignature } from '../packages/line-sdk/src/webhook.js';

export const LINE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Line/14.10.0';
export const WRANGLER_TAIL_SETTLE_MS = 2_000;
export const TAIL_BRANCH_MAX_ATTEMPTS = 3;
const TAIL_BRANCH_ATTEMPT_TIMEOUT_MS = 5_000;

type JsonRecord = Record<string, unknown>;

export interface RailWebhookEvent {
  type: 'follow' | 'message' | 'postback';
  timestamp: number;
  source: { type: 'group'; groupId: string } | { type: 'user'; userId: string };
  webhookEventId: string;
  deliveryContext: { isRedelivery: boolean };
  mode: 'active';
  replyToken: string;
  message?: { id: string; type: 'text'; text: string };
  postback?: { data: string };
}

export interface RailWebhookFixture {
  destination: string;
  events: RailWebhookEvent[];
}

export interface WebhookTarget {
  id: string;
  testOnly: boolean;
  url: string;
  allowedOrigin: string;
  allowedPath: string;
  sourcePolicy: 'group-without-user';
  workerName?: string;
  wranglerConfig?: string;
}

export interface FormTarget {
  id: string;
  testOnly: boolean;
  formId: string;
  localFormId?: string;
  url: string;
  allowedOrigins: string[];
  markerText: string;
  formSelector?: string;
  fieldId: string;
  fieldSelector: string;
  submitSelector: string;
  successText: string;
  submissionOrigins: string[];
  submissionPath: string;
  prefillParam: string;
  initialValue: string;
  editedValue: string;
  reentryUrl?: string;
}

interface VerificationDefinition {
  kind: 'webhook-local' | 'webhook-deployed' | 'form-probe';
  target: string;
  description: string;
}

export interface ScenarioRegistry {
  schemaVersion: number;
  verifications: Record<string, VerificationDefinition>;
  caseTypes: Record<string, string[]>;
  targets: {
    webhook: Record<string, WebhookTarget>;
    forms: Record<string, FormTarget>;
  };
}

export interface FormProbeStep {
  phase: 'initial' | 'prefill' | 'submit' | 'reentry' | 'edit';
  url: string;
  action: 'inspect' | 'submit' | 'edit-and-submit';
  expectedValue?: string;
}

export interface LiveFormIdentity {
  formId: string;
  address: string;
  title: string;
  successMessage: string;
  fieldSlugs: string[];
}

export interface ObservedNetworkResponse {
  requestId: string;
  method: string;
  url: string;
  status: number;
  mimeType: string;
}

export function createLineSignature(channelSecret: string, rawBody: string): string {
  if (!channelSecret) throw new Error('LINE channel secret is required');
  return createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest('base64');
}

export function tamperSignature(signature: string): string {
  if (!signature) throw new Error('signature is required');
  const replacement = signature[0] === 'A' ? 'B' : 'A';
  return replacement + signature.slice(1);
}

export function buildWebhookFixture(nowMs = Date.now()): RailWebhookFixture {
  const source = { type: 'group' as const, groupId: 'line-verify-rail-test-group' };
  const common = (suffix: string) => ({
    timestamp: nowMs,
    source: { ...source },
    webhookEventId: `line-verify-rail-${suffix}-${nowMs}`,
    deliveryContext: { isRedelivery: false },
    mode: 'active' as const,
    replyToken: 'line-verify-rail-no-reply',
  });

  return {
    destination: 'U-line-verify-rail-test-destination',
    events: [
      { type: 'follow', ...common('follow') },
      {
        type: 'message',
        ...common('message'),
        message: {
          id: `line-verify-rail-message-${nowMs}`,
          type: 'text',
          text: 'LINE verification rail test-only fixture',
        },
      },
      {
        type: 'postback',
        ...common('postback'),
        postback: { data: 'line_verify_rail_test_only=1' },
      },
    ],
  };
}

function assertHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use https`);
  return url;
}

export function assertSafeWebhookRequest(
  target: WebhookTarget,
  requestUrl: string,
  fixture: RailWebhookFixture,
): void {
  if (target.testOnly !== true) throw new Error('webhook target is not test-only');
  if (target.sourcePolicy !== 'group-without-user') {
    throw new Error('webhook target does not enforce the no-user source policy');
  }

  const configured = assertHttpsUrl(target.url, 'webhook target URL');
  const requested = assertHttpsUrl(requestUrl, 'webhook request URL');
  if (
    requested.href !== configured.href ||
    requested.origin !== target.allowedOrigin ||
    requested.pathname !== target.allowedPath
  ) {
    throw new Error('webhook URL is outside the exact allowlist');
  }

  const types = fixture.events.map((event) => event.type);
  if (types.join(',') !== 'follow,message,postback') {
    throw new Error('webhook fixture must contain follow, message, and postback exactly once');
  }
  for (const event of fixture.events) {
    if (event.source.type !== 'group') {
      throw new Error('user-scoped webhook events are forbidden by the verification rail');
    }
    if ('userId' in event.source) {
      throw new Error('group webhook fixtures must not contain a userId');
    }
  }
}

export function assertAllowedNavigation(target: FormTarget, value: string): URL {
  const url = assertHttpsUrl(value, 'form navigation URL');
  const allowedLocations = [target.url, target.reentryUrl]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => assertHttpsUrl(candidate, 'allowlisted form URL'));
  const exactTarget = allowedLocations.some(
    (allowed) => allowed.origin === url.origin && allowed.pathname === url.pathname,
  );
  if (!target.allowedOrigins.includes(url.origin) || !exactTarget) {
    throw new Error(`form navigation URL is outside the exact allowlist: ${url.origin}${url.pathname}`);
  }
  return url;
}

export function assertSafeFormTarget(target: FormTarget): void {
  if (target.testOnly !== true) throw new Error('form target is not test-only');
  if (!target.formId.trim()) throw new Error('test form id is required');
  if (!target.markerText.trim()) throw new Error('test marker text is required');
  if (!target.fieldId.trim() || !target.fieldSelector.trim() || !target.submitSelector.trim()) {
    throw new Error('form field and submit selectors are required');
  }
  if (!Array.isArray(target.submissionOrigins) || target.submissionOrigins.length === 0) {
    throw new Error('form submission origin allowlist is required');
  }
  for (const origin of target.submissionOrigins) {
    const parsed = assertHttpsUrl(origin, 'form submission origin');
    if (parsed.origin !== origin) throw new Error('form submission origin must be an exact origin');
  }
  if (!target.submissionPath.startsWith('/') || !target.submissionPath.includes(target.formId)) {
    throw new Error('form submission path must be exact and contain the allowlisted form id');
  }
  if (!target.prefillParam.trim()) throw new Error('prefill parameter is required');
  if (!target.initialValue || !target.editedValue) throw new Error('probe values are required');
  assertAllowedNavigation(target, target.url);
  if (target.reentryUrl) assertAllowedNavigation(target, target.reentryUrl);
}

export function assertLiveFormIdentity(target: FormTarget, identity: LiveFormIdentity): void {
  const expectedAddress = assertHttpsUrl(target.url, 'form target URL').pathname.replace(/^\/+|\/+$/g, '');
  if (identity.formId !== target.formId) {
    throw new Error(`live form id does not match the allowlist: ${identity.formId}`);
  }
  if (identity.address !== expectedAddress) {
    throw new Error(`live form address does not match the allowlist: ${identity.address}`);
  }
  if (identity.title !== target.markerText) {
    throw new Error('live form title does not match the dedicated test marker');
  }
  if (identity.successMessage !== target.successText) {
    throw new Error('live form success contract does not match the allowlist');
  }
  if (!identity.fieldSlugs.includes(target.fieldId)) {
    throw new Error(`live form does not contain the allowlisted field id: ${target.fieldId}`);
  }
}

export function findSuccessfulSubmissionResponse(
  target: FormTarget,
  responses: ObservedNetworkResponse[],
  startIndex: number,
): ObservedNetworkResponse | undefined {
  return responses.slice(startIndex).find((response) => {
    if (response.method !== 'POST' || response.status < 200 || response.status >= 400) return false;
    try {
      const url = new URL(response.url);
      return (
        target.submissionOrigins.includes(url.origin) && url.pathname === target.submissionPath
      );
    } catch {
      return false;
    }
  });
}

function withPrefill(target: FormTarget, baseUrl: string): string {
  const url = assertAllowedNavigation(target, baseUrl);
  url.searchParams.set(target.prefillParam, target.initialValue);
  return url.href;
}

export function buildFormProbePlan(target: FormTarget): FormProbeStep[] {
  assertSafeFormTarget(target);
  const prefillUrl = withPrefill(target, target.url);
  const reentryUrl = withPrefill(target, target.reentryUrl ?? target.url);
  return [
    { phase: 'initial', url: target.url, action: 'inspect', expectedValue: '' },
    { phase: 'prefill', url: prefillUrl, action: 'inspect', expectedValue: target.initialValue },
    { phase: 'submit', url: prefillUrl, action: 'submit', expectedValue: target.initialValue },
    { phase: 'reentry', url: reentryUrl, action: 'inspect', expectedValue: target.initialValue },
    { phase: 'edit', url: reentryUrl, action: 'edit-and-submit', expectedValue: target.editedValue },
  ];
}

export function validateScenarioRegistry(value: unknown): asserts value is ScenarioRegistry {
  if (!value || typeof value !== 'object') throw new Error('scenario registry must be an object');
  const registry = value as Partial<ScenarioRegistry>;
  if (registry.schemaVersion !== 1) throw new Error('scenario registry schemaVersion must be 1');
  if (!registry.verifications || typeof registry.verifications !== 'object') {
    throw new Error('scenario registry verifications are required');
  }
  if (!registry.caseTypes || typeof registry.caseTypes !== 'object') {
    throw new Error('scenario registry caseTypes are required');
  }
  const known = new Set(Object.keys(registry.verifications));
  for (const [caseType, verificationIds] of Object.entries(registry.caseTypes)) {
    if (!Array.isArray(verificationIds) || verificationIds.length === 0) {
      throw new Error(`case type ${caseType} must reference at least one verification`);
    }
    for (const id of verificationIds) {
      if (!known.has(id)) throw new Error(`case type ${caseType} references unknown verification ${id}`);
    }
  }
  if (!registry.targets?.webhook || !registry.targets.forms) {
    throw new Error('scenario registry targets are required');
  }
}

function redactString(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  try {
    const url = new URL(result);
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[REDACTED]');
    result = url.href;
  } catch {
    // Not a URL; secret replacement above is sufficient.
  }
  return result;
}

export function sanitizeEvidence(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, secrets));
  if (!value || typeof value !== 'object') return value;

  const output: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
    const sensitiveKey =
      normalizedKey.includes('secret') ||
      normalizedKey.includes('token') ||
      normalizedKey === 'authorization' ||
      normalizedKey === 'signature' ||
      normalizedKey === 'xlinesignature';
    if (sensitiveKey) output[key] = '[REDACTED]';
    else output[key] = sanitizeEvidence(child, secrets);
  }
  return output;
}

async function writeJson(path: string, value: unknown, secrets: string[] = []): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const safe = sanitizeEvidence(value, secrets);
  await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
}

async function runLocalWebhook(
  target: WebhookTarget,
  channelSecret: string,
  evidenceDir: string,
): Promise<JsonRecord> {
  const fixture = buildWebhookFixture();
  assertSafeWebhookRequest(target, target.url, fixture);
  const rawBody = JSON.stringify(fixture);
  const signature = createLineSignature(channelSecret, rawBody);
  const invalidSignature = tamperSignature(signature);
  const valid = await verifySignature(channelSecret, rawBody, signature);
  const invalidRejected = !(await verifySignature(channelSecret, rawBody, invalidSignature));
  if (!valid || !invalidRejected) throw new Error('local worker signature contract failed');

  const result = {
    status: 'PASS',
    target: target.id,
    eventTypes: fixture.events.map((event) => event.type),
    sourcePolicy: target.sourcePolicy,
    validSignatureAccepted: valid,
    invalidSignatureRejected: invalidRejected,
    signatureLength: signature.length,
    observedAt: new Date().toISOString(),
  };
  await writeJson(resolve(evidenceDir, 'webhook-local.json'), result, [channelSecret, signature, invalidSignature]);
  return result;
}

function boundedAppend(current: string, chunk: string, limit = 256_000): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function waitForText(
  getText: () => string,
  pattern: RegExp,
  timeoutMs: number,
  failure: () => string,
): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pattern.test(getText())) {
        clearInterval(timer);
        resolveWait();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(failure()));
      }
    }, 100);
  });
}

interface TailSession {
  child: ChildProcessWithoutNullStreams;
  text: () => string;
  stop: () => Promise<void>;
}

export function buildWranglerTailArgs(target: WebhookTarget): string[] {
  if (!target.wranglerConfig) throw new Error('wranglerConfig is required for deployed evidence');
  const args = ['exec', 'wrangler', 'tail'];
  if (target.workerName) args.push(target.workerName);
  // Wrangler 4.110 emits no readiness line in JSON mode. Pretty mode keeps the
  // readiness contract and still exposes the two branch log messages we assert.
  args.push('--config', target.wranglerConfig, '--format', 'pretty');
  return args;
}

export function isWranglerTailReady(output: string): boolean {
  return /Connected to [^\n]+, waiting for logs/i.test(output);
}

export function extractSafeTailEvidence(output: string, target: WebhookTarget): string[] {
  const requestPrefix = `POST ${target.url} `;
  const allowedBranchLines = new Set([
    '(error) Failed to parse webhook body',
    '(error) Invalid LINE signature',
  ]);
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim())
    .filter((line) => line.startsWith(requestPrefix) || allowedBranchLines.has(line));
}

async function startWranglerTail(target: WebhookTarget): Promise<TailSession> {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for deployed tail');
  }

  const args = buildWranglerTailArgs(target);
  const child = spawn('pnpm', args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: '1',
      WRANGLER_LOG_PATH: resolve('/tmp', 'line-verify-rail-wrangler.log'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = boundedAppend(output, String(chunk));
  });
  child.stderr.on('data', (chunk) => {
    output = boundedAppend(output, String(chunk));
  });
  child.on('error', (error) => {
    output = boundedAppend(output, `\n${error.message}`);
  });

  try {
    await waitForText(
      () => output,
      /Connected to [^\n]+, waiting for logs/i,
      20_000,
      () => `wrangler tail did not become ready: ${redactString(output.slice(-800), [])}`,
    );
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGINT');
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else {
        const timeout = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGTERM');
          resolveExit();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolveExit();
        });
      }
    });
    throw error;
  }

  return {
    child,
    text: () => output,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGINT');
      await new Promise<void>((resolveStop) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGTERM');
          resolveStop();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolveStop();
        });
      });
    },
  };
}

async function postWebhook(url: string, rawBody: string, signature: string): Promise<{ status: number; url: string }> {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': signature,
    },
    body: rawBody,
  });
  await response.arrayBuffer();
  return { status: response.status, url: response.url };
}

async function postUntilTailBranch(
  tail: TailSession,
  url: string,
  rawBody: string,
  signature: string,
  pattern: RegExp,
  label: string,
): Promise<{ response: { status: number; url: string }; attempts: number }> {
  for (let attempt = 1; attempt <= TAIL_BRANCH_MAX_ATTEMPTS; attempt++) {
    const response = await postWebhook(url, rawBody, signature);
    if (response.status !== 200) {
      throw new Error(`${label} probe returned HTTP ${response.status}`);
    }
    try {
      await waitForText(
        tail.text,
        pattern,
        TAIL_BRANCH_ATTEMPT_TIMEOUT_MS,
        () => `${label} log was not observed`,
      );
      return { response, attempts: attempt };
    } catch (error) {
      if (attempt === TAIL_BRANCH_MAX_ATTEMPTS) throw error;
    }
  }
  throw new Error(`${label} log was not observed`);
}

async function runDeployedWebhook(
  target: WebhookTarget,
  channelSecret: string,
  evidenceDir: string,
): Promise<JsonRecord> {
  const fixture = buildWebhookFixture();
  assertSafeWebhookRequest(target, target.url, fixture);
  const fixtureRawBody = JSON.stringify(fixture);
  const fixtureSignature = createLineSignature(channelSecret, fixtureRawBody);
  const malformedBody = '{"lineVerifyRail":"test-only"';
  const malformedValidSignature = createLineSignature(channelSecret, malformedBody);
  const malformedInvalidSignature = tamperSignature(malformedValidSignature);
  const tail = await startWranglerTail(target);

  try {
    // The CLI prints its connected line just before Cloudflare begins reliably
    // forwarding events. Give that subscription a short, bounded settle window
    // so the first verification request is not lost at the readiness boundary.
    await new Promise((resolveWait) => setTimeout(resolveWait, WRANGLER_TAIL_SETTLE_MS));
    const validMalformed = await postUntilTailBranch(
      tail,
      target.url,
      malformedBody,
      malformedValidSignature,
      /Failed to parse webhook body/,
      'valid-signature parser-branch',
    );
    const invalidMalformed = await postUntilTailBranch(
      tail,
      target.url,
      malformedBody,
      malformedInvalidSignature,
      /Invalid LINE signature/,
      'invalid-signature rejection',
    );
    const safeEventBatch = await postWebhook(target.url, fixtureRawBody, fixtureSignature);

    for (const response of [validMalformed.response, invalidMalformed.response, safeEventBatch]) {
      const final = new URL(response.url);
      if (final.origin !== target.allowedOrigin || final.pathname !== target.allowedPath) {
        throw new Error('webhook response escaped the exact allowlist');
      }
      if (response.status !== 200) throw new Error(`deployed webhook returned HTTP ${response.status}`);
    }

    const tailEvidenceLines = extractSafeTailEvidence(tail.text(), target);
    if (
      !tailEvidenceLines.includes('(error) Failed to parse webhook body') ||
      !tailEvidenceLines.includes('(error) Invalid LINE signature')
    ) {
      throw new Error('safe raw tail evidence is incomplete');
    }
    await writeFile(
      resolve(evidenceDir, 'webhook-tail.log'),
      `${tailEvidenceLines.join('\n')}\n`,
      'utf8',
    );

    const result = {
      status: 'PASS',
      target: target.id,
      url: target.url,
      eventTypes: fixture.events.map((event) => event.type),
      validSignatureBranch: 'Failed to parse webhook body',
      invalidSignatureBranch: 'Invalid LINE signature',
      validMalformedStatus: validMalformed.response.status,
      validMalformedAttempts: validMalformed.attempts,
      invalidMalformedStatus: invalidMalformed.response.status,
      invalidMalformedAttempts: invalidMalformed.attempts,
      safeEventBatchStatus: safeEventBatch.status,
      writesPermitted: false,
      tailEvidence: 'webhook-tail.log',
      tailEvidenceLines,
      observedAt: new Date().toISOString(),
    };
    await writeJson(resolve(evidenceDir, 'webhook-deployed.json'), result, [
      channelSecret,
      fixtureSignature,
      malformedValidSignature,
      malformedInvalidSignature,
    ]);
    return result;
  } finally {
    await tail.stop();
  }
}

type CdpParams = Record<string, unknown>;

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventWaiters = new Map<string, Array<(params: unknown) => void>>();
  private readonly requestMethods = new Map<string, string>();
  readonly responses: ObservedNetworkResponse[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP command failed'));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === 'Network.requestWillBeSent') {
        const params = message.params as { requestId?: string; request?: { method?: string } };
        if (params.requestId && params.request?.method) {
          this.requestMethods.set(params.requestId, params.request.method);
        }
      } else if (message.method === 'Network.responseReceived') {
        const params = message.params as {
          requestId?: string;
          response?: { url?: string; status?: number; mimeType?: string };
        };
        if (params.requestId && params.response?.url && typeof params.response.status === 'number') {
          this.responses.push({
            requestId: params.requestId,
            method: this.requestMethods.get(params.requestId) ?? 'UNKNOWN',
            url: params.response.url,
            status: params.response.status,
            mimeType: params.response.mimeType ?? '',
          });
        }
      }
      if (message.method) {
        const waiters = this.eventWaiters.get(message.method) ?? [];
        this.eventWaiters.delete(message.method);
        for (const waiter of waiters) waiter(message.params);
      }
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveConnect, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP websocket connection timed out')), 8_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolveConnect();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('CDP websocket connection failed'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async send<T = unknown>(method: string, params: CdpParams = {}): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<T>((resolveCommand, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolveCommand(value as T),
        reject,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  waitForEvent(method: string, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolveEvent, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CDP event timed out: ${method}`)), timeoutMs);
      const listener = (params: unknown) => {
        clearTimeout(timeout);
        resolveEvent(params);
      };
      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push(listener);
      this.eventWaiters.set(method, waiters);
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface CdpTargetInfo {
  id: string;
  webSocketDebuggerUrl: string;
}

async function createCdpTarget(endpoint: string): Promise<CdpTargetInfo> {
  const base = endpoint.replace(/\/$/, '');
  const response = await fetch(`${base}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`CDP target creation failed: HTTP ${response.status}`);
  const target = (await response.json()) as Partial<CdpTargetInfo>;
  if (!target.id || !target.webSocketDebuggerUrl) throw new Error('CDP target response is incomplete');
  return target as CdpTargetInfo;
}

async function closeCdpTarget(endpoint: string, targetId: string): Promise<void> {
  const base = endpoint.replace(/\/$/, '');
  await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const result = await client.send<{ result?: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error('browser evaluation failed');
  return result.result?.value as T;
}

async function waitForBrowserCondition(
  client: CdpClient,
  expression: string,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate<boolean>(client, expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`browser condition timed out: ${description}`);
}

async function readLiveFormIdentity(client: CdpClient): Promise<LiveFormIdentity> {
  const identity = await evaluate<LiveFormIdentity | null>(
    client,
    `(() => {
      const element = document.querySelector('#____FORMALOO_FORM_DATA____');
      if (!element?.textContent) return null;
      try {
        let value = JSON.parse(element.textContent);
        if (typeof value === 'string') value = JSON.parse(value);
        return {
          formId: String(value.slug || ''),
          address: String(value.address || ''),
          title: String(value.title || ''),
          successMessage: String(value.success_message || ''),
          fieldSlugs: Array.isArray(value.fields_list)
            ? value.fields_list.map((field) => String(field.slug || ''))
            : [],
        };
      } catch {
        return null;
      }
    })()`,
  );
  if (!identity) throw new Error('live form identity payload is missing or invalid');
  return identity;
}

async function waitForSuccessfulSubmissionResponse(
  client: CdpClient,
  target: FormTarget,
  startIndex: number,
  timeoutMs = 20_000,
): Promise<ObservedNetworkResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = findSuccessfulSubmissionResponse(target, client.responses, startIndex);
    if (response) return response;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('successful deployed form submission response was not observed');
}

async function navigate(client: CdpClient, target: FormTarget, url: string): Promise<void> {
  assertAllowedNavigation(target, url);
  const loaded = client.waitForEvent('Page.loadEventFired');
  const result = await client.send<{ errorText?: string }>('Page.navigate', { url });
  if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`);
  await loaded;
  await waitForBrowserCondition(
    client,
    `document.body && document.body.innerText.includes(${JSON.stringify(target.markerText)})`,
    'exact test marker',
  );
  const currentUrl = await evaluate<string>(client, 'location.href');
  assertAllowedNavigation(target, currentUrl);
}

async function observedFieldValue(client: CdpClient, selector: string): Promise<string | null> {
  return evaluate<string | null>(
    client,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && 'value' in el ? String(el.value) : null; })()`,
  );
}

async function setFieldValue(client: CdpClient, selector: string, value: string): Promise<void> {
  const changed = await evaluate<boolean>(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return false;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  if (!changed) throw new Error(`form field was not found: ${selector}`);
}

async function clickElement(client: CdpClient, selector: string): Promise<void> {
  const rect = await evaluate<{ x: number; y: number } | null>(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!rect) throw new Error(`click target was not found: ${selector}`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

async function capturePhase(
  client: CdpClient,
  target: FormTarget,
  evidenceDir: string,
  phase: FormProbeStep['phase'],
  expectedValue: string,
): Promise<JsonRecord> {
  const currentUrl = await evaluate<string>(client, 'location.href');
  assertAllowedNavigation(target, currentUrl);
  const value = await observedFieldValue(client, target.fieldSelector);
  const markerVisible = await evaluate<boolean>(
    client,
    `document.body.innerText.includes(${JSON.stringify(target.markerText)})`,
  );
  const html = await evaluate<string>(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(target.formSelector ?? 'form')}) || document.body;
      return el.outerHTML.slice(0, 50000);
    })()`,
  );
  const screenshot = await client.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const prefix = `${String(['initial', 'prefill', 'submit', 'reentry', 'edit'].indexOf(phase) + 1).padStart(2, '0')}-${phase}`;
  const screenshotPath = resolve(evidenceDir, `${prefix}.png`);
  const htmlPath = resolve(evidenceDir, `${prefix}.html`);
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await writeFile(htmlPath, `${html}\n`, 'utf8');
  return {
    phase,
    url: currentUrl,
    markerVisible,
    observedValue: value,
    expectedValue,
    screenshot: screenshotPath,
    html: htmlPath,
    capturedAt: new Date().toISOString(),
  };
}

async function runFormProbe(
  target: FormTarget,
  evidenceDir: string,
  cdpEndpoint: string,
): Promise<JsonRecord> {
  assertSafeFormTarget(target);
  const plan = buildFormProbePlan(target);
  await mkdir(evidenceDir, { recursive: true });
  const cdpTarget = await createCdpTarget(cdpEndpoint);
  const client = await CdpClient.connect(cdpTarget.webSocketDebuggerUrl);
  const phaseEvidence: JsonRecord[] = [];
  const submissionResponses: Array<JsonRecord> = [];
  let liveIdentity: LiveFormIdentity | undefined;

  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setUserAgentOverride', {
      userAgent: LINE_USER_AGENT,
      platform: 'Android',
    });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });

    await navigate(client, target, plan[0]!.url);
    liveIdentity = await readLiveFormIdentity(client);
    assertLiveFormIdentity(target, liveIdentity);
    await waitForBrowserCondition(
      client,
      `document.querySelector(${JSON.stringify(target.fieldSelector)}) !== null`,
      'initial form field',
    );
    const initialValue = await observedFieldValue(client, target.fieldSelector);
    if (initialValue !== '') throw new Error(`initial field was not empty: ${JSON.stringify(initialValue)}`);
    phaseEvidence.push(await capturePhase(client, target, evidenceDir, 'initial', ''));

    await navigate(client, target, plan[1]!.url);
    await waitForBrowserCondition(
      client,
      `(() => { const el = document.querySelector(${JSON.stringify(target.fieldSelector)}); return el && el.value === ${JSON.stringify(target.initialValue)}; })()`,
      'prefill value',
    );
    phaseEvidence.push(await capturePhase(client, target, evidenceDir, 'prefill', target.initialValue));

    const submitResponseStart = client.responses.length;
    await clickElement(client, target.submitSelector);
    await waitForBrowserCondition(
      client,
      `document.body.innerText.includes(${JSON.stringify(target.successText)})`,
      'submit success text',
      20_000,
    );
    submissionResponses.push({
      phase: 'submit',
      ...(await waitForSuccessfulSubmissionResponse(client, target, submitResponseStart)),
    });
    phaseEvidence.push(await capturePhase(client, target, evidenceDir, 'submit', target.initialValue));

    await navigate(client, target, plan[3]!.url);
    await waitForBrowserCondition(
      client,
      `(() => { const el = document.querySelector(${JSON.stringify(target.fieldSelector)}); return el && el.value === ${JSON.stringify(target.initialValue)}; })()`,
      'reentry prefill value',
    );
    phaseEvidence.push(await capturePhase(client, target, evidenceDir, 'reentry', target.initialValue));

    await setFieldValue(client, target.fieldSelector, target.editedValue);
    if ((await observedFieldValue(client, target.fieldSelector)) !== target.editedValue) {
      throw new Error('edited field value did not stick');
    }
    const editResponseStart = client.responses.length;
    await clickElement(client, target.submitSelector);
    await waitForBrowserCondition(
      client,
      `document.body.innerText.includes(${JSON.stringify(target.successText)})`,
      'edit submit success text',
      20_000,
    );
    submissionResponses.push({
      phase: 'edit',
      ...(await waitForSuccessfulSubmissionResponse(client, target, editResponseStart)),
    });
    phaseEvidence.push(await capturePhase(client, target, evidenceDir, 'edit', target.editedValue));

    const allowedResponses = client.responses
      .filter((entry) => {
        try {
          return target.allowedOrigins.includes(new URL(entry.url).origin);
        } catch {
          return false;
        }
      })
      .map((entry) => ({ ...entry, url: redactString(entry.url, [target.initialValue, target.editedValue]) }));
    if (!allowedResponses.some((entry) => entry.status >= 200 && entry.status < 400)) {
      throw new Error('no successful deployed network response was observed');
    }
    const result = {
      status: 'PASS',
      target: target.id,
      formId: target.formId,
      localFormId: target.localFormId,
      liveFormIdentity: liveIdentity,
      lineUserAgentApplied: true,
      viewport: { width: 390, height: 844 },
      phases: phaseEvidence,
      submissionResponses,
      networkResponses: allowedResponses,
      observedAt: new Date().toISOString(),
    };
    await writeJson(resolve(evidenceDir, 'form-probe.json'), result, [target.initialValue, target.editedValue]);
    return result;
  } finally {
    client.close();
    await closeCdpTarget(cdpEndpoint, cdpTarget.id);
  }
}

interface CliOptions {
  scenario: string;
  evidenceDir: string;
  cdpEndpoint: string;
}

export function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenario: 'all',
    evidenceDir: '.sola/evidence/line-verify-rail',
    cdpEndpoint: 'http://127.0.0.1:9222',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--scenario' && value) options.scenario = value;
    else if (key === '--evidence-dir' && value) options.evidenceDir = value;
    else if (key === '--cdp-endpoint' && value) options.cdpEndpoint = value;
    else if (key === '--help') {
      console.log('Usage: pnpm exec tsx scripts/line-verify-rail.ts --scenario <case-type> [--evidence-dir <path>]');
      process.exit(0);
    } else if (key?.startsWith('--') && !['--scenario', '--evidence-dir', '--cdp-endpoint'].includes(key)) {
      throw new Error(`unknown option: ${key}`);
    }
    if (key && ['--scenario', '--evidence-dir', '--cdp-endpoint'].includes(key)) i += 1;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const registry = JSON.parse(
    await readFile(resolve('scripts/line-verify-scenarios.json'), 'utf8'),
  ) as unknown;
  validateScenarioRegistry(registry);
  const verificationIds = registry.caseTypes[options.scenario];
  if (!verificationIds) throw new Error(`unknown scenario: ${options.scenario}`);
  const channelSecret = process.env.LINE_CHANNEL_SECRET ?? process.env.LINE_VERIFY_CHANNEL_SECRET ?? '';
  const results: JsonRecord[] = [];
  await mkdir(resolve(options.evidenceDir), { recursive: true });

  for (const verificationId of verificationIds) {
    const verification = registry.verifications[verificationId]!;
    if (verification.kind === 'webhook-local') {
      const target = registry.targets.webhook[verification.target];
      if (!target) throw new Error(`unknown webhook target: ${verification.target}`);
      if (!channelSecret) throw new Error('LINE_CHANNEL_SECRET is required for webhook verification');
      results.push({ verificationId, ...(await runLocalWebhook(target, channelSecret, options.evidenceDir)) });
    } else if (verification.kind === 'webhook-deployed') {
      const target = registry.targets.webhook[verification.target];
      if (!target) throw new Error(`unknown webhook target: ${verification.target}`);
      if (!channelSecret) throw new Error('LINE_CHANNEL_SECRET is required for webhook verification');
      results.push({ verificationId, ...(await runDeployedWebhook(target, channelSecret, options.evidenceDir)) });
    } else if (verification.kind === 'form-probe') {
      const target = registry.targets.forms[verification.target];
      if (!target) throw new Error(`unknown form target: ${verification.target}`);
      results.push({ verificationId, ...(await runFormProbe(target, options.evidenceDir, options.cdpEndpoint)) });
    }
  }

  const summary = {
    status: 'PASS',
    scenario: options.scenario,
    verificationIds,
    results,
    evidenceDir: resolve(options.evidenceDir),
    completedAt: new Date().toISOString(),
  };
  await writeJson(resolve(options.evidenceDir, 'summary.json'), summary, [channelSecret]);
  console.log(`LINE verification rail PASS: ${verificationIds.join(', ')}; evidence=${resolve(options.evidenceDir)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`LINE verification rail FAIL: ${redactString(message, [
      process.env.LINE_CHANNEL_SECRET ?? '',
      process.env.LINE_VERIFY_CHANNEL_SECRET ?? '',
      process.env.CLOUDFLARE_API_TOKEN ?? '',
    ])}`);
    process.exitCode = 1;
  });
}
