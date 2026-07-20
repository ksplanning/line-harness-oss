import { editTokenExp, signEditToken } from './formaloo-edit-token.js';

export interface CreateInternalFormEditUrlInput {
  publicBaseUrl: string;
  formId: string;
  submissionId: string;
  editLinkEpoch: number;
  secret: string | undefined | null;
  nowSec?: number;
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
  const token = await signEditToken({
    formId: input.formId,
    rowRef: input.submissionId,
    epoch: input.editLinkEpoch,
    exp: editTokenExp(nowSec),
  }, input.secret);
  if (!token) return null;

  return new URL(`/ife/${encodeURIComponent(token)}`, baseUrl).toString();
}
