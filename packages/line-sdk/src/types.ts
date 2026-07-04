// ─── Source types ────────────────────────────────────────────────────────────

export interface UserSource {
  type: 'user';
  userId: string;
}

export interface GroupSource {
  type: 'group';
  groupId: string;
  userId?: string;
}

export interface RoomSource {
  type: 'room';
  roomId: string;
  userId?: string;
}

export type Source = UserSource | GroupSource | RoomSource;

// ─── Message subtypes ────────────────────────────────────────────────────────

export interface TextEventMessage {
  type: 'text';
  id: string;
  text: string;
}

export interface ImageEventMessage {
  type: 'image';
  id: string;
  contentProvider: {
    type: 'line' | 'external';
    originalContentUrl?: string;
    previewImageUrl?: string;
  };
}

export interface VideoEventMessage {
  type: 'video';
  id: string;
  duration: number;
  contentProvider: {
    type: 'line' | 'external';
    originalContentUrl?: string;
    previewImageUrl?: string;
  };
}

export interface AudioEventMessage {
  type: 'audio';
  id: string;
  duration: number;
  contentProvider: {
    type: 'line' | 'external';
    originalContentUrl?: string;
  };
}

export interface FileEventMessage {
  type: 'file';
  id: string;
  fileName: string;
  fileSize: number;
}

export interface LocationEventMessage {
  type: 'location';
  id: string;
  title?: string;
  address?: string;
  latitude: number;
  longitude: number;
}

export interface StickerEventMessage {
  type: 'sticker';
  id: string;
  packageId: string;
  stickerId: string;
  stickerResourceType: string;
}

export type EventMessage =
  | TextEventMessage
  | ImageEventMessage
  | VideoEventMessage
  | AudioEventMessage
  | FileEventMessage
  | LocationEventMessage
  | StickerEventMessage;

// ─── Webhook events ───────────────────────────────────────────────────────────

interface BaseEvent {
  timestamp: number;
  source: Source;
  webhookEventId: string;
  deliveryContext: {
    isRedelivery: boolean;
  };
  mode: 'active' | 'standby' | 'channel';
}

export interface MessageEvent extends BaseEvent {
  type: 'message';
  replyToken: string;
  message: EventMessage;
}

export interface FollowEvent extends BaseEvent {
  type: 'follow';
  replyToken: string;
  source: UserSource | GroupSource | RoomSource;
}

export interface UnfollowEvent extends BaseEvent {
  type: 'unfollow';
  source: UserSource | GroupSource | RoomSource;
}

export interface PostbackEvent extends BaseEvent {
  type: 'postback';
  replyToken: string;
  postback: {
    data: string;
    params?: Record<string, string>;
  };
}

export type WebhookEvent =
  | MessageEvent
  | FollowEvent
  | UnfollowEvent
  | PostbackEvent;

export interface WebhookRequestBody {
  destination: string;
  events: WebhookEvent[];
}

// ─── User profile ─────────────────────────────────────────────────────────────

export interface UserProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

// ─── Send message types ───────────────────────────────────────────────────────

export type FlexContainer = object;

/**
 * Per-message sender override (LINE `sender`). Each outbound message object may
 * carry its own display name / icon (e.g. campaign persona). Resolved server-side
 * from an account-scoped preset — clients never inject raw name/iconUrl (G25).
 */
export interface MessageSender {
  name: string;
  iconUrl?: string;
}

export interface TextMessage {
  type: 'text';
  text: string;
  sender?: MessageSender;
}

export interface ImageMessage {
  type: 'image';
  originalContentUrl: string;
  previewImageUrl: string;
  sender?: MessageSender;
}

export interface FlexMessage {
  type: 'flex';
  altText: string;
  contents: FlexContainer;
  sender?: MessageSender;
}

export interface VideoMessage {
  type: 'video';
  originalContentUrl: string;
  previewImageUrl: string;
  sender?: MessageSender;
}

export interface AudioMessage {
  type: 'audio';
  originalContentUrl: string;
  duration: number;
  sender?: MessageSender;
}

export interface TemplateMessage {
  type: 'template';
  altText: string;
  template: Record<string, unknown>;
  sender?: MessageSender;
}

/** Optional video block for a rich-video imagemap (G14): plays inside the imagemap area. */
export interface ImageMapVideo {
  originalContentUrl: string;
  previewImageUrl: string;
  area: { x: number; y: number; width: number; height: number };
  externalLink?: { linkUri: string; label: string };
}

export interface ImageMapMessageType {
  type: 'imagemap';
  baseUrl: string;
  altText: string;
  baseSize: { width: number; height: number };
  actions: Record<string, unknown>[];
  video?: ImageMapVideo;
  sender?: MessageSender;
}

export type Message =
  | TextMessage
  | ImageMessage
  | FlexMessage
  | VideoMessage
  | AudioMessage
  | TemplateMessage
  | ImageMapMessageType;

// ─── Rich Menu types ──────────────────────────────────────────────────────────

export interface RichMenuSize {
  width: number;
  height: number;
}

export interface RichMenuBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RichMenuActionPostback {
  type: 'postback';
  data: string;
  displayText?: string;
  label?: string;
}

export interface RichMenuActionMessage {
  type: 'message';
  text: string;
  label?: string;
}

export interface RichMenuActionUri {
  type: 'uri';
  uri: string;
  label?: string;
}

export interface RichMenuActionDatetimePicker {
  type: 'datetimepicker';
  data: string;
  mode: 'date' | 'time' | 'datetime';
  label?: string;
}

export interface RichMenuActionRichMenuSwitch {
  type: 'richmenuswitch';
  richMenuAliasId: string;
  data: string;
  label?: string;
}

export type RichMenuAction =
  | RichMenuActionPostback
  | RichMenuActionMessage
  | RichMenuActionUri
  | RichMenuActionDatetimePicker
  | RichMenuActionRichMenuSwitch;

export interface RichMenuArea {
  bounds: RichMenuBounds;
  action: RichMenuAction;
}

export interface RichMenuObject {
  richMenuId?: string;
  size: RichMenuSize;
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
}

// ─── Request types ────────────────────────────────────────────────────────────

export interface PushMessageRequest {
  to: string;
  messages: Message[];
}

export interface MulticastRequest {
  to: string[];
  messages: Message[];
}

export interface BroadcastRequest {
  messages: Message[];
}

export interface ReplyMessageRequest {
  replyToken: string;
  messages: Message[];
}
