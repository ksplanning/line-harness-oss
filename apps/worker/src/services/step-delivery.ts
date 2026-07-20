import { extractFlexAltText } from '../utils/flex-alt-text.js';
import { MessageBuildError, unwrapFlexMessageObject } from '../utils/message-build.js';
import {
  getFriendScenariosDueForDelivery,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  claimFriendScenarioForDelivery,
  getFriendById,
  jstNow,
  computeNextDeliveryAt,
  resolveStepContent,
  addTagToFriend,
  listFriendFieldDefinitions,
  type DeliveryMode,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { jitterDeliveryTime, addJitter, sleep } from './stealth.js';
import { getEffectiveFriendMetadataValue } from './friend-metadata-condition.js';
import { renderMessageContent } from './render-message.js';

// resolveMetadata must keep the legacy metadata object enumerable shape intact.
// The active-definition projection travels out-of-band so {{metadata.KEY}} keeps
// working while {{field:KEY}} cannot consume inactive or undefined keys.
const resolvedCustomFields = new WeakMap<
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>
>();
const ACTIVE_FIELD_DEFINITION_CACHE_MS = 5_000;
type ActiveFriendFieldDefinitions = Awaited<ReturnType<typeof listFriendFieldDefinitions>>;
const activeFieldDefinitionCache = new WeakMap<
  D1Database,
  { expiresAt: number; value: Promise<ActiveFriendFieldDefinitions> }
>();

async function getActiveFriendFieldDefinitions(
  db: D1Database,
): Promise<ActiveFriendFieldDefinitions> {
  const now = Date.now();
  const cached = activeFieldDefinitionCache.get(db);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = listFriendFieldDefinitions(db, { activeOnly: true });
  const entry = { expiresAt: now + ACTIVE_FIELD_DEFINITION_CACHE_MS, value };
  activeFieldDefinitionCache.set(db, entry);
  try {
    return await value;
  } catch (error) {
    if (activeFieldDefinitionCache.get(db) === entry) activeFieldDefinitionCache.delete(db);
    throw error;
  }
}

/**
 * Replace template variables in message content.
 *
 * Supported variables:
 * - {{name}}                → friend's display name
 * - {{uid}}                 → friend's user UUID
 * - {{friend_id}}           → friend's internal ID
 * - {{auth_url:CHANNEL_ID}} → full /auth/line URL with uid for cross-account linking
 * - {{metadata.KEY}}       → friend's metadata value (from form responses etc.)
 */
export function expandVariables(
  content: string,
  friend: { id: string; display_name: string | null; user_id: string | null; ref_code?: string | null; metadata?: Record<string, unknown> | string | null },
  apiOrigin?: string,
): string {
  // Legacy variables are expanded before the shared renderer for backwards
  // compatibility. Mask their recipient-controlled values so a value that
  // happens to contain a new {{display_name}}/{{field:*}} token stays literal.
  let literalPrefix = '\uE000line_harness_literal_';
  while (content.includes(literalPrefix)) literalPrefix += '_';
  const literalSuffix = '\uE001';
  const literalValues: string[] = [];
  const maskLiteral = (value: string): string => {
    const index = literalValues.push(value) - 1;
    return `${literalPrefix}${index}${literalSuffix}`;
  };

  let result = content;
  result = result.replace(/\{\{name\}\}/g, () => maskLiteral(friend.display_name || ''));
  result = result.replace(/\{\{uid\}\}/g, () => maskLiteral(friend.user_id || ''));
  result = result.replace(/\{\{friend_id\}\}/g, () => maskLiteral(friend.id));
  result = result.replace(/\{\{ref\}\}/g, () => maskLiteral(friend.ref_code || ''));
  // Conditional block: {{#if_ref}}...{{/if_ref}} — only shown if ref_code exists
  if (friend.ref_code) {
    result = result.replace(/\{\{#if_ref\}\}([\s\S]*?)\{\{\/if_ref\}\}/g, '$1');
  } else {
    result = result.replace(/\{\{#if_ref\}\}[\s\S]*?\{\{\/if_ref\}\}/g, '');
  }
  // Metadata variables: {{metadata.KEY}} → value from friend's metadata
  const meta = friend.metadata
    ? (typeof friend.metadata === 'string' ? JSON.parse(friend.metadata) as Record<string, unknown> : friend.metadata)
    : {};
  // Conditional block: {{#if_metadata.KEY}}...{{/if_metadata.KEY}} — only shown if metadata key has a value
  // When inside JSON arrays, removes the element and fixes trailing/leading commas
  result = result.replace(/\{\{#if_metadata\.([^}]+)\}\}([\s\S]*?)\{\{\/if_metadata\.\1\}\}/g, (_match, key, inner) => {
    const val = meta[key];
    if (val == null || val === '') return '';
    return inner;
  });
  // Clean up broken JSON commas from removed conditional blocks (e.g. ",," or "[," or ",]")
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/\[\s*,/g, '[');
  result = result.replace(/,\s*\]/g, ']');
  result = result.replace(/\{\{metadata\.([^}]+)\}\}/g, (_match, key) => {
    const val = meta[key];
    if (val == null) return maskLiteral('');
    return maskLiteral(Array.isArray(val) ? val.join(', ') : String(val));
  });
  if (apiOrigin) {
    result = result.replace(/\{\{auth_url:([^}]+)\}\}/g, (_match, channelId) => {
      const params = new URLSearchParams({ account: channelId, ref: 'cross-link' });
      if (friend.user_id) params.set('uid', friend.user_id);
      return maskLiteral(`${apiOrigin}/auth/line?${params.toString()}`);
    });
  }
  const rendered = renderMessageContent(result, null, {
    displayName: friend.display_name,
    customFields: resolvedCustomFields.get(meta),
  });
  const literalPattern = new RegExp(`${literalPrefix}(\\d+)${literalSuffix}`, 'g');
  return rendered.replace(literalPattern, (match, index: string) => (
    literalValues[Number(index)] ?? match
  ));
}

/**
 * Resolve metadata for a friend, merging across all UUID-linked records.
 * Falls back to the friend's own metadata if no user_id.
 */
export async function resolveMetadata(
  db: D1Database,
  friend: { user_id?: string | null; metadata?: string | null },
): Promise<Record<string, unknown>> {
  let rawMetadata: Record<string, unknown> = {};
  // If friend has a UUID, merge metadata from all linked records
  if (friend.user_id) {
    const { getMergedMetadataByUserId } = await import('@line-crm/db');
    rawMetadata = await getMergedMetadataByUserId(db, friend.user_id);
  } else if (friend.metadata) {
    // Fallback: parse own metadata
    try {
      const parsed = JSON.parse(friend.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawMetadata = parsed as Record<string, unknown>;
      }
    } catch {
      rawMetadata = {};
    }
  }

  const metadata = { ...rawMetadata };
  try {
    const definitions = await getActiveFriendFieldDefinitions(db);
    resolvedCustomFields.set(metadata, Object.fromEntries(definitions.map((definition) => [
      definition.name,
      Object.prototype.hasOwnProperty.call(metadata, definition.name)
        ? metadata[definition.name]
        : definition.defaultValue,
    ])));
  } catch {
    // Existing messages must remain sendable if definitions cannot be read.
    // In that case field tokens stay literal instead of being guessed or erased.
    resolvedCustomFields.set(metadata, {});
  }
  return metadata;
}

const MAX_SENDS_PER_CRON = 40; // CF Free plan: 50 subrequests limit (margin for other jobs)

export async function processStepDeliveries(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const now = jstNow();
  const dueFriendScenarios = await getFriendScenariosDueForDelivery(db, now);

  let sendCount = 0;
  for (let i = 0; i < dueFriendScenarios.length; i++) {
    if (sendCount >= MAX_SENDS_PER_CRON) break;
    const fs = dueFriendScenarios[i];
    try {
      // Stealth: add small random delay between deliveries to avoid burst patterns
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }
      const sent = await processSingleDelivery(db, lineClient, fs, workerUrl);
      if (sent) sendCount++;
    } catch (err) {
      console.error(`Error processing friend_scenario ${fs.id}:`, err);
      // Continue with next one
    }
  }
}

async function processSingleDelivery(
  db: D1Database,
  lineClient: LineClient,
  fs: {
    id: string;
    friend_id: string;
    scenario_id: string;
    current_step_order: number;
    status: string;
    next_delivery_at: string | null;
    started_at: string;
  },
  workerUrl?: string,
): Promise<boolean> {
  // Optimistic lock: claim this delivery (prevents duplicate sends from parallel workers)
  const claimed = await claimFriendScenarioForDelivery(db, fs.id, fs.current_step_order);
  if (!claimed) return false;

  const friend = await getFriendById(db, fs.friend_id);
  if (!friend || !friend.is_following) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // Fetch scenario row for delivery_mode (needed by computeNextDeliveryAt below)
  const scenarioRow = await db
    .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
    .bind(fs.scenario_id)
    .first<{ delivery_mode: DeliveryMode }>();
  if (!scenarioRow) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // Get all steps for this scenario
  const steps = await getScenarioSteps(db, fs.scenario_id);
  if (steps.length === 0) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // computeNextDeliveryAt は「JST clock-time を UTC として表現する Date」前提
  // (setHours/getDate が JST clock 通りに動くようにオフセット済みの Date)。
  // fs.started_at は "+09:00" 付き ISO で本物の UTC instant として parse されるため、
  // +9h ずらして JST clock-time 表現に揃える必要がある。
  const enrolledAtDate = new Date(new Date(fs.started_at).getTime() + 9 * 60 * 60_000);
  const nowJstDate = new Date(Date.now() + 9 * 60 * 60_000);
  const nextDeliveryFor = (step: { delay_minutes: number; offset_days: number | null; offset_minutes: number | null; delivery_time: string | null }): Date =>
    computeNextDeliveryAt(
      { delivery_mode: scenarioRow.delivery_mode },
      step,
      { enrolledAt: enrolledAtDate, previousDeliveredAt: nowJstDate, now: nowJstDate },
    );

  // Steps are sorted by step_order but may not be contiguous (e.g., 1, 3, 5 after deletions).
  // Find the next step whose step_order > current_step_order.
  const currentStep = steps.find((s) => s.step_order > fs.current_step_order);

  if (!currentStep) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // Check step condition before sending
  if (currentStep.condition_type) {
    const conditionMet = await evaluateCondition(db, fs.friend_id, currentStep);
    if (!conditionMet) {
      if (currentStep.next_step_on_false !== null && currentStep.next_step_on_false !== undefined) {
        const jumpStep = steps.find((s) => s.step_order === currentStep.next_step_on_false);
        // Forward-only branch jump: set the cursor to jumpStep.step_order - 1 so the next
        // cron's `find(s => s.step_order > cursor)` lands exactly on jumpStep. step_order is
        // INTEGER + per-scenario UNIQUE, so the open interval (J-1, J) contains no other step
        // (same sentinel shape as enroll's current_step_order = -1). Backward/self jumps are
        // refused (logged) and fall through to the sequential skip below — this keeps the cursor
        // monotonic and structurally prevents an infinite re-delivery loop across crons. A
        // persisted transition counter would need a friend_scenarios column (migration — banned
        // for this case), so the stateless monotonic guard gives the same termination safety.
        if (jumpStep && jumpStep.step_order > currentStep.step_order) {
          const jitteredDate = jitterDeliveryTime(nextDeliveryFor(jumpStep));
          await advanceFriendScenario(db, fs.id, jumpStep.step_order - 1, jitteredDate.toISOString().slice(0, -1) + '+09:00');
          return false;
        }
        if (jumpStep) {
          console.error(`[scenario] refusing non-forward branch jump fs=${fs.id} step_order=${currentStep.step_order} -> ${jumpStep.step_order} (loop guard)`);
        }
      }
      const nextIndex = steps.indexOf(currentStep) + 1;
      if (nextIndex < steps.length) {
        const nextStep = steps[nextIndex];
        const jitteredDate = jitterDeliveryTime(nextDeliveryFor(nextStep));
        await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
      } else {
        await completeFriendScenario(db, fs.id);
      }
      return false;
    }
  }

  // Resolve template_id → templates table (参照型). template_id 未設定なら step 値そのまま。
  const resolved = await resolveStepContent(db, currentStep);

  // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}}, {{metadata.KEY}}, etc.)
  const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
  const friendWithMeta = { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1];
  const expandedContent = expandVariables(resolved.messageContent, friendWithMeta, workerUrl);
  // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
  let trackedType: string = resolved.messageType;
  let trackedContent = expandedContent;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, resolved.messageType, expandedContent, workerUrl);
    trackedType = tracked.messageType;
    trackedContent = tracked.content;
  }
  const message = buildMessage(trackedType, trackedContent);
  // Resolve the correct LINE client for this friend's account
  let deliveryClient = lineClient;
  const friendAccountId = (friend as unknown as Record<string, string | null>).line_account_id;
  if (friendAccountId) {
    const { getLineAccountById } = await import('@line-crm/db');
    const account = await getLineAccountById(db, friendAccountId);
    if (account) {
      const { LineClient: LC } = await import('@line-crm/line-sdk');
      deliveryClient = new LC(account.channel_access_token);
    }
  }
  await deliveryClient.pushMessage(friend.line_user_id, [message]);

  // Log what we actually pushed: variables expanded, URLs auto-tracked, AND
  // any cleanEmptyNodes() mutation applied by buildMessage(). Parse failures no
  // longer fall back to text — buildMessage() now throws (fail-closed, W5 T-E2)
  // and the caller loop skips + logs. Use scenario_step_id to recover the template.
  const logId = crypto.randomUUID();
  const logPayload = messageToLogPayload(message);
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, template_id_at_send, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'scenario', ?, ?)`,
    )
    .bind(logId, friend.id, logPayload.messageType, logPayload.content, currentStep.id, resolved.templateIdAtSend, jstNow())
    .run();

  // Determine next step (find the step after currentStep in the sorted list)
  const currentIndex = steps.indexOf(currentStep);
  const nextStep = currentIndex + 1 < steps.length ? steps[currentIndex + 1] : null;

  if (nextStep) {
    const jitteredDate = jitterDeliveryTime(nextDeliveryFor(nextStep));
    await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
  } else {
    // This was the last step
    await completeFriendScenario(db, fs.id);
  }

  // 到達タグ付与 (advance / complete の後 = 再送が起きてもタグ付与は影響しない順序)
  // 失敗してもログに残すだけで配信フローは止めない。
  if (currentStep.on_reach_tag_id) {
    try {
      await addTagToFriend(db, friend.id, currentStep.on_reach_tag_id);
    } catch (err) {
      console.error(`[scenario] tag attach failed step=${currentStep.id}:`, err);
    }
  }
  return true;
}

export function normalizeForContains(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

export const SUPPORTED_CONDITION_TYPES = [
  'tag_exists',
  'tag_not_exists',
  'metadata_equals',
  'metadata_not_equals',
  'metadata_contains',
  'metadata_not_contains',
  'tag_name_contains',
  'tag_name_not_contains',
] as const;

export function isSupportedConditionType(value: unknown): value is (typeof SUPPORTED_CONDITION_TYPES)[number] {
  return typeof value === 'string' && (SUPPORTED_CONDITION_TYPES as readonly string[]).includes(value);
}

export interface ConditionValueResolver {
  hasTag(tagId: string): Promise<boolean>;
  getMetadata(key: string): Promise<unknown>;
  getTagNames(): Promise<string[]>;
}

async function evaluateConditionWithResolverInternal(
  resolver: ConditionValueResolver,
  step: { condition_type: string | null; condition_value: string | null },
  throwOnFailure: boolean,
): Promise<boolean> {
  if (!step.condition_type) return true;
  if (!isSupportedConditionType(step.condition_type)) {
    console.error(`[scenario] unsupported condition_type: ${step.condition_type}`);
    return false;
  }
  if (!step.condition_value) {
    console.error(`[scenario] missing condition_value for condition_type: ${step.condition_type}`);
    return false;
  }

  try {
    switch (step.condition_type) {
      case 'tag_exists': {
        return await resolver.hasTag(step.condition_value);
      }
      case 'tag_not_exists': {
        return !await resolver.hasTag(step.condition_value);
      }
      case 'metadata_equals':
      case 'metadata_not_equals': {
        const parsed = JSON.parse(step.condition_value) as { key?: unknown; value?: unknown };
        if (typeof parsed.key !== 'string' || !Object.prototype.hasOwnProperty.call(parsed, 'value')) {
          console.error('[scenario] malformed metadata condition_value');
          return false;
        }
        const actual = await resolver.getMetadata(parsed.key);
        const matches = actual === parsed.value;
        return step.condition_type === 'metadata_equals' ? matches : !matches;
      }
      case 'metadata_contains':
      case 'metadata_not_contains': {
        const parsed = JSON.parse(step.condition_value) as { key?: unknown; value?: unknown };
        if (typeof parsed.key !== 'string' || typeof parsed.value !== 'string') {
          console.error('[scenario] malformed metadata contains condition_value');
          return false;
        }
        const needleNorm = normalizeForContains(parsed.value).trim();
        if (needleNorm === '') {
          console.error(`[scenario] empty contains needle for condition_type: ${step.condition_type}`);
          return false;
        }
        const actual = await resolver.getMetadata(parsed.key);
        const haystackValue = actual === undefined ? '' : actual;
        const haystackNorm = normalizeForContains(haystackValue === undefined ? '' : String(haystackValue));
        const matches = haystackNorm.includes(needleNorm);
        return step.condition_type === 'metadata_contains' ? matches : !matches;
      }
      case 'tag_name_contains':
      case 'tag_name_not_contains': {
        const needleNorm = normalizeForContains(step.condition_value).trim();
        if (needleNorm === '') {
          console.error(`[scenario] empty contains needle for condition_type: ${step.condition_type}`);
          return false;
        }
        const tagNames = await resolver.getTagNames();
        const matches = tagNames.some((name) => normalizeForContains(name).includes(needleNorm));
        return step.condition_type === 'tag_name_contains' ? matches : !matches;
      }
    }
  } catch (err) {
    if (throwOnFailure) throw err;
    console.error('[scenario] condition evaluation failed', err);
    return false;
  }
}

function d1ConditionResolver(db: D1Database, friendId: string): ConditionValueResolver {
  return {
    async hasTag(tagId) {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, tagId)
        .first();
      return !!tag;
    },
    getMetadata(key) {
      return getEffectiveFriendMetadataValue(db, friendId, key);
    },
    async getTagNames() {
      const tags = await db
        .prepare('SELECT t.name AS name FROM friend_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.friend_id = ?')
        .bind(friendId)
        .all<{ name: string }>();
      return tags.results.map((tag) => tag.name);
    },
  };
}

export function evaluateCondition(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  return evaluateConditionWithResolverInternal(d1ConditionResolver(db, friendId), step, false);
}

/**
 * Rich-menu selection must distinguish a real mismatch from an unavailable
 * condition lookup. Input validation still returns false, while DB/JSON
 * failures escape so the caller can preserve the current menu and retry.
 */
export function evaluateConditionStrict(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  return evaluateConditionWithResolverInternal(d1ConditionResolver(db, friendId), step, true);
}

export function evaluateConditionWithResolverStrict(
  resolver: ConditionValueResolver,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  return evaluateConditionWithResolverInternal(resolver, step, true);
}


/** Remove empty text nodes and boxes with empty text from Flex JSON */
function cleanEmptyNodes(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  const node = obj as Record<string, unknown>;
  for (const key of ['header', 'body', 'footer']) {
    if (node[key]) cleanEmptyNodes(node[key]);
  }
  if (Array.isArray(node.contents)) {
    // First clean children recursively
    for (const c of node.contents as unknown[]) cleanEmptyNodes(c);
    // Then filter out empty nodes
    node.contents = (node.contents as unknown[]).filter((c) => {
      if (!c || typeof c !== 'object') return true;
      const child = c as Record<string, unknown>;
      // Remove empty text nodes
      if (child.type === 'text') {
        const text = child.text;
        return typeof text === 'string' && text.trim().length > 0;
      }
      // Remove box nodes where any text child is empty (metadata rows with no value)
      if (child.type === 'box' && Array.isArray(child.contents)) {
        const texts = (child.contents as Array<Record<string, unknown>>).filter(t => t.type === 'text');
        if (texts.length >= 2) {
          // horizontal box with label + value — remove if value is empty
          const hasEmptyText = texts.some(t => typeof t.text === 'string' && t.text.trim() === '');
          if (hasEmptyText) return false;
        }
      }
      return true;
    });
  }
}

/**
 * Derive (messageType, content) from a built `Message` object so that what
 * lands in messages_log mirrors what was actually pushed to LINE — including
 * cleanEmptyNodes() mutations and any parse-failure text fallback inside
 * buildMessage(). Use this whenever you log a message you just pushed.
 */
export function messageToLogPayload(message: Message): { messageType: string; content: string } {
  if (message.type === 'text') return { messageType: 'text', content: message.text };
  if (message.type === 'flex') return { messageType: 'flex', content: JSON.stringify(message.contents) };
  if (message.type === 'image') {
    return {
      messageType: 'image',
      content: JSON.stringify({
        originalContentUrl: message.originalContentUrl,
        previewImageUrl: message.previewImageUrl,
      }),
    };
  }
  return { messageType: message.type, content: JSON.stringify(message) };
}

export function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    // messageContent is expected to be JSON: { originalContentUrl, previewImageUrl }
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
    } catch (err) {
      // fail-closed: 生 JSON を text 送信せず送信スキップ (findings HIGH/flex-image, W5 T-E2)
      throw new MessageBuildError('image', err);
    }
  }

  if (messageType === 'flex') {
    try {
      const parsed = JSON.parse(messageContent);
      // top-level が message object ({type:'flex',altText,contents}) の丸ごと貼付を自動アンラップ (W5 T-E3)
      const { contents, altText: unwrappedAlt } = unwrapFlexMessageObject(parsed);
      // Remove empty text nodes (from {{#if_ref}} conditional blocks)
      cleanEmptyNodes(contents);
      // Extract first text element for altText (shown in notifications)
      return { type: 'flex', altText: altText || unwrappedAlt || extractFlexAltText(contents), contents };
    } catch (err) {
      if (err instanceof MessageBuildError) throw err;
      throw new MessageBuildError('flex', err);
    }
  }

  // Fallback
  return { type: 'text', text: messageContent };
}
