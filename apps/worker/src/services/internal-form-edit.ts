import { editTokenExp, signEditToken } from './formaloo-edit-token.js';

export const INTERNAL_FORM_ADMIN_EDIT_TTL_SECONDS = 15 * 60;

const ADMIN_ORIGIN_ROW_REF_PREFIX = 'admin-origin:';

export type InternalFormEditTokenBinding = {
  origin: 'respondent' | 'admin-origin';
  submissionId: string;
};

export interface CreateInternalFormEditUrlInput {
  publicBaseUrl: string;
  formId: string;
  submissionId: string;
  editLinkEpoch: number;
  secret: string | undefined | null;
  nowSec?: number;
  origin?: 'admin-origin';
}

/**
 * The origin marker lives inside the signed rowRef namespace, so the existing
 * public token payload stays byte-compatible while admin provenance cannot be
 * changed without invalidating the HMAC.
 */
export function parseInternalFormEditTokenBinding(
  rowRef: string,
): InternalFormEditTokenBinding | null {
  if (rowRef.startsWith(ADMIN_ORIGIN_ROW_REF_PREFIX)) {
    const submissionId = rowRef.slice(ADMIN_ORIGIN_ROW_REF_PREFIX.length);
    return submissionId ? { origin: 'admin-origin', submissionId } : null;
  }
  return rowRef ? { origin: 'respondent', submissionId: rowRef } : null;
}

/** Internal 回答 1 件に束縛した、既存 HMAC レール準拠の公開編集 URL を発行する。 */
export async function createInternalFormEditUrl(
  input: CreateInternalFormEditUrlInput,
): Promise<string | null> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.publicBaseUrl);
  } catch {
    return null;
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') return null;

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const adminOrigin = input.origin === 'admin-origin';
  const token = await signEditToken({
    formId: input.formId,
    rowRef: adminOrigin
      ? `${ADMIN_ORIGIN_ROW_REF_PREFIX}${input.submissionId}`
      : input.submissionId,
    epoch: input.editLinkEpoch,
    exp: adminOrigin
      ? nowSec + INTERNAL_FORM_ADMIN_EDIT_TTL_SECONDS
      : editTokenExp(nowSec),
  }, input.secret);
  if (!token) return null;

  return new URL(`/ife/${encodeURIComponent(token)}`, baseUrl).toString();
}
