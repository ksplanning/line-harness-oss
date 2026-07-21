import type { ImageMapVideo, Message, MessageSender } from '@line-crm/line-sdk';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import { MessageBuildError, unwrapFlexMessageObject } from '../utils/message-build.js';

export const OUTBOUND_MESSAGE_TYPES = [
  'text',
  'image',
  'flex',
  'video',
  'audio',
  'sticker',
  'imagemap',
  'richvideo',
] as const;

export type OutboundMessageType = (typeof OUTBOUND_MESSAGE_TYPES)[number];

interface BuildOutboundMessageOptions {
  altText?: string;
  sender?: MessageSender;
  /** step/auto-reply keeps its legacy conditional-Flex empty-node cleanup. */
  transformFlexContents?: (contents: object) => void;
}

function attachSender(message: Message, sender?: MessageSender): Message {
  if (sender) message.sender = sender;
  return message;
}

function requireString(value: unknown, label: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} は非空文字列が必要`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new Error(`${label} は${maxLength}文字以内で指定してください`);
  }
  return value;
}

function requireOptionalString(value: unknown, label: string, maxLength: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${label} は${maxLength}文字以内で指定してください`);
  }
}

/**
 * Keep send-time Flex checks structural only. Persist-time content policy lives
 * in guardFlexContent so legacy rows are not re-judged by today's URL rules.
 */
function requireFlexContainer(contents: object): void {
  const container = contents as Record<string, unknown>;
  if (container.type === 'bubble') return;
  if (
    container.type === 'carousel'
    && Array.isArray(container.contents)
    && container.contents.every((item) => (
      item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).type === 'bubble'
    ))
  ) return;
  throw new Error('contents は bubble または carousel の形式が必要');
}

function requireNumericId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!/^\d+$/.test(id)) throw new Error(`${label} は数字のみで指定してください`);
  return id;
}

function requireHttpsUrl(value: unknown, label: string): string {
  const url = requireString(value, label, 2000);
  if (!/^https:\/\/\S+$/.test(url)) throw new Error(`${label} は https URL が必要`);
  return url;
}

function requireImagemapLink(value: unknown, label: string): string {
  const url = requireString(value, label, 1000);
  if (!/^(?:https?|line|tel):\S+$/.test(url)) {
    throw new Error(`${label} は http / https / line / tel URL が必要`);
  }
  return url;
}

type ImagemapArea = { x: number; y: number; width: number; height: number };

function requireImagemapArea(
  value: unknown,
  baseSize: { width: number; height: number },
  label: string,
): ImagemapArea {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} は座標オブジェクトが必要`);
  }
  const area = value as Record<string, unknown>;
  const keys = ['x', 'y', 'width', 'height'] as const;
  for (const key of keys) {
    if (typeof area[key] !== 'number' || !Number.isInteger(area[key])) {
      throw new Error(`${label}.${key} は整数が必要`);
    }
  }
  const normalized = area as ImagemapArea;
  if (
    normalized.x < 0
    || normalized.y < 0
    || normalized.width <= 0
    || normalized.height <= 0
    || normalized.x + normalized.width > baseSize.width
    || normalized.y + normalized.height > baseSize.height
  ) {
    throw new Error(`${label} は baseSize の範囲内で指定してください`);
  }
  return normalized;
}

function requireImagemapActions(
  value: unknown,
  baseSize: { width: number; height: number },
): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('actions は配列が必要');
  if (value.length > 50) throw new Error('actions は50件までです');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`actions[${index}] はオブジェクトが必要`);
    }
    const action = raw as Record<string, unknown>;
    requireImagemapArea(action.area, baseSize, `actions[${index}].area`);
    requireOptionalString(action.label, `actions[${index}].label`, 100);
    if (action.type === 'uri') {
      requireImagemapLink(action.linkUri, `actions[${index}].linkUri`);
    } else if (action.type === 'message') {
      requireString(action.text, `actions[${index}].text`, 400);
    } else if (action.type === 'clipboard') {
      requireString(action.clipboardText, `actions[${index}].clipboardText`, 1000);
    } else {
      throw new Error(`actions[${index}].type が未対応です`);
    }
    return action;
  });
}

function requireImagemapVideo(
  value: unknown,
  baseSize: { width: number; height: number },
): ImageMapVideo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('richvideo は video オブジェクトが必要');
  }
  const video = value as unknown as ImageMapVideo;
  requireHttpsUrl(video.originalContentUrl, 'video.originalContentUrl');
  requireHttpsUrl(video.previewImageUrl, 'video.previewImageUrl');
  requireImagemapArea(video.area, baseSize, 'video.area');
  if (video.externalLink !== undefined) {
    if (!video.externalLink || typeof video.externalLink !== 'object') {
      throw new Error('video.externalLink はオブジェクトが必要');
    }
    requireImagemapLink(video.externalLink.linkUri, 'video.externalLink.linkUri');
    requireString(video.externalLink.label, 'video.externalLink.label', 30);
  }
  return video;
}

function parseImagemapContent(messageContent: string): {
  baseUrl: string;
  altText?: string;
  baseSize: { width: number; height: number };
  actions: Record<string, unknown>[];
  video?: ImageMapVideo;
} {
  const parsed = JSON.parse(messageContent) as Record<string, unknown>;
  const baseUrl = requireHttpsUrl(parsed.baseUrl, 'baseUrl');
  const baseSize = parsed.baseSize as { width?: unknown; height?: unknown } | undefined;
  if (!baseSize || typeof baseSize.width !== 'number' || typeof baseSize.height !== 'number') {
    throw new Error('baseSize は { width, height } (数値) が必要');
  }
  if (baseSize.width !== 1040 || !Number.isInteger(baseSize.height) || baseSize.height <= 0) {
    throw new Error('baseSize は width=1040 かつ正の height が必要');
  }
  const normalizedBaseSize = { width: baseSize.width, height: baseSize.height };
  let altText: string | undefined;
  if (parsed.altText !== undefined) {
    altText = requireString(parsed.altText, 'altText', 1500);
  }
  return {
    baseUrl,
    altText,
    baseSize: normalizedBaseSize,
    actions: requireImagemapActions(parsed.actions, normalizedBaseSize),
    video: parsed.video as ImageMapVideo | undefined,
  };
}

/**
 * Convert persisted message type/content into one outbound LINE Message.
 * Every non-text type is parsed fail-closed; unknown types always throw instead
 * of silently sending JSON/URLs as text.
 */
export function buildOutboundMessage(
  messageType: string,
  messageContent: string,
  options: BuildOutboundMessageOptions = {},
): Message {
  const { altText, sender, transformFlexContents } = options;

  if (messageType === 'text') {
    try {
      return attachSender({ type: 'text', text: requireString(messageContent, 'text', 5000) }, sender);
    } catch (error) {
      throw new MessageBuildError('text', error);
    }
  }

  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(messageContent) as Record<string, unknown>;
      return attachSender({
        type: 'image',
        originalContentUrl: requireHttpsUrl(parsed.originalContentUrl, 'originalContentUrl'),
        previewImageUrl: requireHttpsUrl(parsed.previewImageUrl, 'previewImageUrl'),
      }, sender);
    } catch (error) {
      throw new MessageBuildError('image', error);
    }
  }

  if (messageType === 'flex') {
    try {
      const parsed = JSON.parse(messageContent) as unknown;
      const { contents, altText: unwrappedAltText } = unwrapFlexMessageObject(parsed);
      transformFlexContents?.(contents);
      requireFlexContainer(contents);
      const resolvedAltText = altText || unwrappedAltText || extractFlexAltText(contents);
      return attachSender({
        type: 'flex',
        altText: resolvedAltText,
        contents,
      }, sender);
    } catch (error) {
      if (error instanceof MessageBuildError) throw error;
      throw new MessageBuildError('flex', error);
    }
  }

  if (messageType === 'video') {
    try {
      const parsed = JSON.parse(messageContent) as Record<string, unknown>;
      return attachSender({
        type: 'video',
        originalContentUrl: requireHttpsUrl(parsed.originalContentUrl, 'originalContentUrl'),
        previewImageUrl: requireHttpsUrl(parsed.previewImageUrl, 'previewImageUrl'),
      }, sender);
    } catch (error) {
      throw new MessageBuildError('video', error);
    }
  }

  if (messageType === 'audio') {
    try {
      const parsed = JSON.parse(messageContent) as Record<string, unknown>;
      const originalContentUrl = requireHttpsUrl(parsed.originalContentUrl, 'originalContentUrl');
      if (typeof parsed.duration !== 'number' || !(parsed.duration > 0)) {
        throw new Error('duration は正の数が必要');
      }
      return attachSender({ type: 'audio', originalContentUrl, duration: parsed.duration }, sender);
    } catch (error) {
      throw new MessageBuildError('audio', error);
    }
  }

  if (messageType === 'sticker') {
    try {
      const parsed = JSON.parse(messageContent) as Record<string, unknown>;
      return attachSender({
        type: 'sticker',
        packageId: requireNumericId(parsed.packageId, 'packageId'),
        stickerId: requireNumericId(parsed.stickerId, 'stickerId'),
      }, sender);
    } catch (error) {
      throw new MessageBuildError('sticker', error);
    }
  }

  if (messageType === 'imagemap' || messageType === 'richvideo') {
    try {
      const content = parseImagemapContent(messageContent);
      if (messageType === 'imagemap' && content.actions.length === 0) {
        throw new Error('imagemap は action が1件以上必要');
      }
      if (content.video !== undefined) {
        content.video = requireImagemapVideo(content.video, content.baseSize);
      } else if (messageType === 'richvideo') {
        throw new Error('richvideo は video オブジェクトが必要');
      }
      const resolvedAltText = altText || content.altText || (messageType === 'richvideo' ? '動画メッセージ' : 'メッセージ');
      requireString(resolvedAltText, 'altText', 1500);
      return attachSender({
        type: 'imagemap',
        baseUrl: content.baseUrl,
        altText: resolvedAltText,
        baseSize: content.baseSize,
        actions: content.actions,
        ...(content.video ? { video: content.video } : {}),
      }, sender);
    } catch (error) {
      throw new MessageBuildError(messageType, error);
    }
  }

  throw new MessageBuildError(messageType || 'unknown');
}
