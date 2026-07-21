/**
 * LINE Messaging API media ceilings, verified against the official reference on 2026-07-21.
 * https://developers.line.biz/en/reference/messaging-api/#message-objects
 *
 * `directUploadBytes` is deliberately lower than LINE's 200 MB video/audio ceiling:
 * Cloudflare Free/Pro ingress accepts at most 100 MB, so the admin upload path must not
 * advertise a size that the minimum supported deployment plan cannot receive.
 * https://developers.cloudflare.com/workers/platform/limits/#request-limits
 */
export const LINE_MEDIA_LIMITS = {
  messageImageBytes: 10 * 1024 * 1024,
  previewImageBytes: 1 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  audioBytes: 200 * 1024 * 1024,
  // Cloudflare distinguishes MB from MiB in its limits documentation. Free/Pro
  // ingress is 100 MB, so use the decimal byte boundary and never over-advertise.
  directUploadBytes: 100_000_000,
  imagemapImageBytes: 10 * 1024 * 1024,
  imagemapWidths: [240, 300, 460, 700, 1040],
  richMenuImageBytes: 1 * 1024 * 1024,
  flexImageBytes: 10 * 1024 * 1024,
  flexAnimatedImageBytes: 300 * 1024,
  flexIconBytes: 1 * 1024 * 1024,
} as const;

export type ImagemapWidth = (typeof LINE_MEDIA_LIMITS.imagemapWidths)[number];
