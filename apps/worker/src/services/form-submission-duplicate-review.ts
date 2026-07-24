import { stableStringify } from '@line-crm/shared';

export interface DuplicateReviewField {
  answerKey: string;
  type: string;
  label: string;
}

export interface DuplicateReviewSubmission {
  id: string;
  formId: string;
  friendId: string | null;
  answersJson: string;
  submittedAt: string;
  reviewedAt: string | null;
}

export interface DuplicateReviewMetadata {
  groupId: string;
  groupSize: number;
  contentMatch: 'identical' | 'different';
  reviewedAt: string | null;
  revision: string;
}

export interface FormSubmissionDuplicateReview {
  byRowId: Map<string, DuplicateReviewMetadata>;
  pendingCount: number;
}

export function groupPendingDuplicateReviewRows<T>(
  rows: T[],
  review: FormSubmissionDuplicateReview,
  rowId: (row: T) => string,
): T[] {
  const byGroup = new Map<string, T[]>();
  for (const row of rows) {
    const metadata = review.byRowId.get(rowId(row));
    if (!metadata || metadata.reviewedAt !== null) continue;
    const group = byGroup.get(metadata.groupId) ?? [];
    group.push(row);
    byGroup.set(metadata.groupId, group);
  }
  return [...byGroup.values()].flat();
}

function parseAnswers(answersJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(answersJson) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s/gu, '');
  return normalized || null;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildFormSubmissionDuplicateReview(
  rows: DuplicateReviewSubmission[],
  fields: DuplicateReviewField[],
): Promise<FormSubmissionDuplicateReview> {
  const parent = rows.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const emailField = fields.find((field) => field.type === 'email');
  const nameField = fields.find((field) => (
    field.type === 'text' && /名前|氏名|申込者/u.test(field.label)
  ));
  const ownerByIdentity = new Map<string, number>();
  const canonicalAnswers = rows.map((candidate) => stableStringify(parseAnswers(candidate.answersJson)));

  rows.forEach((candidate, index) => {
    const answers = parseAnswers(candidate.answersJson);
    const identities = [
      candidate.friendId ? `friend:${candidate.friendId}` : null,
      emailField
        ? normalizedEmail(answers[emailField.answerKey])
        : null,
      nameField
        ? normalizedName(answers[nameField.answerKey])
        : null,
    ];
    if (identities[1]) identities[1] = `email:${identities[1]}`;
    if (identities[2]) identities[2] = `name:${identities[2]}`;

    for (const identity of identities) {
      if (!identity) continue;
      const scopedIdentity = `${candidate.formId}\u0000${identity}`;
      const owner = ownerByIdentity.get(scopedIdentity);
      if (owner === undefined) ownerByIdentity.set(scopedIdentity, index);
      else union(owner, index);
    }
  });

  const membersByRoot = new Map<number, number[]>();
  rows.forEach((_, index) => {
    const root = find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(index);
    membersByRoot.set(root, members);
  });

  const byRowId = new Map<string, DuplicateReviewMetadata>();
  let pendingCount = 0;
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((left, right) => (
      rows[left]!.id.localeCompare(rows[right]!.id)
    ));
    const formId = rows[sorted[0]!]!.formId;
    const groupId = `duplicate-${(await sha256(stableStringify([
      formId,
      sorted.map((index) => rows[index]!.id),
    ]))).slice(0, 20)}`;
    const revision = await sha256(stableStringify({
      formId,
      emailField: emailField?.answerKey ?? null,
      nameField: nameField?.answerKey ?? null,
      members: sorted.map((index) => [
        rows[index]!.id,
        rows[index]!.friendId,
        canonicalAnswers[index],
      ]),
    }));
    const contentMatch = new Set(sorted.map((index) => canonicalAnswers[index])).size === 1
      ? 'identical'
      : 'different';

    for (const index of members) {
      const candidate = rows[index]!;
      byRowId.set(candidate.id, {
        groupId,
        groupSize: members.length,
        contentMatch,
        reviewedAt: candidate.reviewedAt,
        revision,
      });
      if (candidate.reviewedAt === null) pendingCount += 1;
    }
  }
  return { byRowId, pendingCount };
}
