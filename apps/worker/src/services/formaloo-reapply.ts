import {
  DEFAULT_RATING_STAR_COLOR,
  DEFAULT_VIDEO_HEIGHT,
  JP_CUSTOMIZED_TEXTS,
  JP_LOCALIZED_CONTENT,
  MANAGED_CUSTOMIZED_TEXT_KEYS,
  MANAGED_LOCALIZATION_KEYS,
  buildCustomizedTextsMerge,
  buildLocalizedContentMerge,
  isValidHexColor,
  mergeManagedCss,
  ratingStarCss,
  type FormCopy,
  type FormDesign,
  type HarnessField,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';
import { designColorFields } from './formaloo-design.js';
import { formCopyFields } from './formaloo-copy.js';
import { extractFieldsList } from './formaloo-pull.js';

// =============================================================================
// formaloo-reapply — 保存済み harness 定義の hosted 描画設定だけを再送する。
// -----------------------------------------------------------------------------
// field/logic 全置換の pushDefinitionToFormaloo は使わない。form meta は管理 top-level key だけを 1 PATCH、
// video は form detail の remote fields_list を GET し foreign config を merge した `{url, config}` だけを PATCH する。
// 各 part は独立に続行・確認し、部分失敗を route が out_of_sync として正直に surface できる形で返す。
// =============================================================================

export interface ReapplyHostedDefinition {
  readonly fields: readonly HarnessField[];
  /** 再反映の比較対象外。service が定義全置換しないことを型でも明示する。 */
  readonly logic?: unknown;
  readonly design?: FormDesign;
  readonly formCopy?: FormCopy;
  /** undefined=未管理、true=管理 key を日本語化、false=管理 key だけを解除。 */
  readonly localizationJa?: boolean;
}

export interface ReapplyPartResult {
  ok: boolean;
  skipped: boolean;
  error?: string;
  failedFieldIds?: string[];
}

export interface ReapplyHostedResult {
  ok: boolean;
  parts: {
    color: ReapplyPartResult;
    star: ReapplyPartResult;
    copy: ReapplyPartResult;
    localization: ReapplyPartResult;
    videoHeight: ReapplyPartResult;
  };
}

export interface ReapplyOptions {
  /** false は localization part だけを完全短絡する独立 kill-switch。 */
  localizationEnabled?: boolean;
  /** GET-after-PATCH の追加試行回数。 */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type MetaPart = 'color' | 'star' | 'copy' | 'localization';

const skipped = (): ReapplyPartResult => ({ ok: true, skipped: true });
const active = (): ReapplyPartResult => ({ ok: true, skipped: false });

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractForm(data: unknown): Record<string, unknown> {
  const root = record(data);
  const dataValue = record(root.data);
  const nestedForm = dataValue.form;
  return nestedForm != null && typeof nestedForm === 'object' && !Array.isArray(nestedForm)
    ? record(nestedForm)
    : Object.keys(dataValue).length
      ? dataValue
      : record(root.form);
}

function copyComparable(value: string): string {
  return value.normalize('NFKC').replace(/[\r\t]/g, ' ').replace(/ +/g, ' ');
}

/** hosted が解釈できる色は JSON-string RGBA のみ。plain hex の round-trip を成功扱いしない。 */
function hostedColorMatches(remote: unknown, expectedJson: string): boolean {
  return typeof remote === 'string' && remote === expectedJson;
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValueEqual(leftRecord[key], rightRecord[key]));
}

function designMatches(form: Record<string, unknown>, fields: Record<string, string>): boolean {
  for (const [key, expected] of Object.entries(fields)) {
    if (key === 'theme_name') {
      if (form[key] !== expected) return false;
      continue;
    }
    if (!hostedColorMatches(form[key], expected)) return false;
  }
  return true;
}

function copyMatches(form: Record<string, unknown>, fields: Record<string, string>): boolean {
  return Object.entries(fields).every(([key, expected]) => {
    const got = form[key];
    return typeof got === 'string' && copyComparable(got) === copyComparable(expected);
  });
}

function localizationMatches(form: Record<string, unknown>, enabled: boolean): boolean {
  const current = record(form.localized_content);
  const customized = record(form.customized_texts);
  const localizedMatches = MANAGED_LOCALIZATION_KEYS.every((key) => enabled
    ? current[key] === JP_LOCALIZED_CONTENT[key]
    : !Object.prototype.hasOwnProperty.call(current, key));
  const customizedMatches = MANAGED_CUSTOMIZED_TEXT_KEYS.every((key) => enabled
    ? customized[key] === JP_CUSTOMIZED_TEXTS[key]
    : !Object.prototype.hasOwnProperty.call(customized, key));
  return localizedMatches && customizedMatches;
}

function partError(part: MetaPart, detail: string): string {
  const labels: Record<MetaPart, string> = {
    color: '配色',
    star: '星色',
    copy: '公開ページ文言',
    localization: '日本語 UI',
  };
  return `${labels[part]}の再反映に失敗しました（${detail}）`;
}

/**
 * 保存済み定義の見た目設定を、foreign state を壊さない部分 PATCH だけで hosted へ再反映する。
 * 呼び出し側は result.ok=false を out_of_sync にし、parts をレスポンスへそのまま surface する。
 */
export async function reapplyHostedAppearance(
  client: FormalooClient,
  formalooSlug: string,
  definition: ReapplyHostedDefinition,
  fieldSlugs: Readonly<Record<string, string>>,
  opts: ReapplyOptions = {},
): Promise<ReapplyHostedResult> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const designFields = designColorFields(definition.design);
  const copyFieldValues = formCopyFields(definition.formCopy);
  const wantsStar = definition.fields.some((field) => field.type === 'rating')
    && definition.design?.ratingStarColor !== null;
  const wantsLocalization = opts.localizationEnabled !== false
    && typeof definition.localizationJa === 'boolean';
  const videos = definition.fields.filter((field) => field.type === 'video');

  const parts: ReapplyHostedResult['parts'] = {
    color: Object.keys(designFields).length ? active() : skipped(),
    star: wantsStar ? active() : skipped(),
    copy: Object.keys(copyFieldValues).length ? active() : skipped(),
    localization: wantsLocalization ? active() : skipped(),
    videoHeight: videos.length ? active() : skipped(),
  };

  const metaBody: Record<string, unknown> = { ...designFields, ...copyFieldValues };
  const includedMetaParts: MetaPart[] = [];
  if (!parts.color.skipped) includedMetaParts.push('color');
  if (!parts.copy.skipped) includedMetaParts.push('copy');

  let wantedStarCss: string | undefined;
  let localizationEnabled: boolean | undefined;
  let remoteFields: unknown[] | null = videos.length ? null : [];
  const failedVideoIds: string[] = [];
  if (wantsStar || wantsLocalization || videos.length > 0) {
    // star/localization/video は foreign state を保持するため、実測済み form detail GET を 1 回だけ merge 元にする。
    // video の read-shape は単体 field GET に依存せず、form `fields_list` を extractFieldsList で許容抽出する。
    const current = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (!current.ok) {
      if (wantsStar) parts.star = { ok: false, skipped: false, error: partError('star', `GET HTTP ${current.status}`) };
      if (wantsLocalization) parts.localization = { ok: false, skipped: false, error: partError('localization', `GET HTTP ${current.status}`) };
      failedVideoIds.push(...videos.map((field) => field.id));
    } else {
      const form = extractForm(current.data);
      remoteFields = extractFieldsList(current.data);
      if (videos.length > 0 && remoteFields === null) failedVideoIds.push(...videos.map((field) => field.id));
      if (wantsStar) {
        const rawColor = definition.design?.ratingStarColor;
        const color = isValidHexColor(rawColor) ? rawColor : DEFAULT_RATING_STAR_COLOR;
        wantedStarCss = mergeManagedCss(
          typeof form.custom_css === 'string' ? form.custom_css : '',
          ratingStarCss(color),
        );
        metaBody.custom_css = wantedStarCss;
        includedMetaParts.push('star');
      }
      if (wantsLocalization) {
        localizationEnabled = definition.localizationJa as boolean;
        const currentLocalized = record(form.localized_content);
        const wantedLocalized = buildLocalizedContentMerge(currentLocalized, localizationEnabled);
        const currentCustomized = record(form.customized_texts);
        const wantedCustomized = buildCustomizedTextsMerge(currentCustomized, localizationEnabled);
        const localizedChanged = wantedLocalized !== currentLocalized;
        const customizedChanged = wantedCustomized !== currentCustomized;
        // ON は従来の reapply 契約どおり管理 container を再送する。OFF は削除対象が無ければ
        // container 自体を載せず、foreign-only state の byte 同等と不要な {} PATCH を守る。
        if (localizationEnabled || localizedChanged) metaBody.localized_content = wantedLocalized;
        if (localizationEnabled || customizedChanged) metaBody.customized_texts = wantedCustomized;
        if (localizationEnabled || localizedChanged || customizedChanged) {
          includedMetaParts.push('localization');
        }
      }
    }
  }

  if (Object.keys(metaBody).length > 0) {
    const patched = await client.request('PATCH', `/v3.0/forms/${formalooSlug}/`, metaBody);
    if (!patched.ok) {
      for (const part of includedMetaParts) {
        parts[part] = { ok: false, skipped: false, error: partError(part, `PATCH HTTP ${patched.status}`) };
      }
    } else {
      // form meta は 1 snapshot で各 part を独立判定する。全 part が揃うまでだけ bounded retry。
      let reflected: Record<string, unknown> | null = null;
      let allMatched = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const got = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
        if (got.ok) {
          reflected = extractForm(got.data);
          allMatched = includedMetaParts.every((part) => {
            if (part === 'color') return designMatches(reflected!, designFields);
            if (part === 'copy') return copyMatches(reflected!, copyFieldValues);
            if (part === 'star') return reflected!.custom_css === wantedStarCss;
            return localizationMatches(reflected!, localizationEnabled as boolean);
          });
          if (allMatched) break;
        }
        if (attempt < retries) await sleep(200 * (attempt + 1));
      }
      if (!allMatched) {
        for (const part of includedMetaParts) {
          const matched = reflected != null && (
            part === 'color' ? designMatches(reflected, designFields)
              : part === 'copy' ? copyMatches(reflected, copyFieldValues)
                : part === 'star' ? reflected.custom_css === wantedStarCss
                  : localizationMatches(reflected, localizationEnabled as boolean)
          );
          if (!matched) parts[part] = { ok: false, skipped: false, error: partError(part, 'GET-after-PATCH 不一致') };
        }
      }
    }
  }

  for (const field of videos) {
    if (failedVideoIds.includes(field.id)) continue;
    const remoteSlug = fieldSlugs[field.id];
    if (!remoteSlug) {
      failedVideoIds.push(field.id);
      continue;
    }
    const remote = (remoteFields ?? [])
      .map((candidate) => record(candidate))
      .find((candidate) => candidate.slug === remoteSlug);
    if (!remote) {
      failedVideoIds.push(field.id);
      continue;
    }
    // config 単独 PATCH は Formaloo が 500 にするため url 同送が必要。ただし owner 要求の唯一の更新は height。
    // 定義側 URL へ巻き戻さず、GET した remote の現行 URL を逐語で再送する。
    const desiredUrl = typeof remote.url === 'string' && remote.url ? remote.url : null;
    if (!desiredUrl) {
      failedVideoIds.push(field.id);
      continue;
    }
    const desiredHeight = field.config.videoHeight ?? DEFAULT_VIDEO_HEIGHT;
    const patchBody = {
      url: desiredUrl,
      config: { ...record(remote.config), height: desiredHeight },
    };
    const patched = await client.request('PATCH', `/v3.0/fields/${remoteSlug}/`, patchBody);
    if (!patched.ok) {
      failedVideoIds.push(field.id);
      continue;
    }

    let reflected = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const got = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
      if (got.ok) {
        const remoteAfter = (extractFieldsList(got.data) ?? [])
          .map((candidate) => record(candidate))
          .find((candidate) => candidate.slug === remoteSlug);
        reflected = remoteAfter?.url === desiredUrl
          && jsonValueEqual(record(remoteAfter?.config), patchBody.config);
        if (reflected) break;
      }
      if (attempt < retries) await sleep(200 * (attempt + 1));
    }
    if (!reflected) failedVideoIds.push(field.id);
  }
  if (failedVideoIds.length > 0) {
    parts.videoHeight = {
      ok: false,
      skipped: false,
      error: `動画サイズの再反映に失敗しました（${failedVideoIds.join(', ')}）`,
      failedFieldIds: failedVideoIds,
    };
  }

  return {
    ok: Object.values(parts).every((part) => part.ok),
    parts,
  };
}
