import {
  beginFormResultsRowShift,
  cancelFormResultsRowShift,
  claimNextSheetsWebhookEvent,
  claimSheetsSyncLock,
  clearSheetsSyncLedgerRowNumbers,
  completeFormResultsRowShift,
  commitSheetsSyncRow,
  deleteSoftDeletedInternalFormSubmissionLedgerEntries,
  deferSheetsWebhookEvent,
  failSheetsWebhookEvent,
  finishSheetsWebhookEvent,
  getFormalooForm,
  getFormResultsRowShiftFence,
  getInternalFormSubmission,
  hasSheetsSyncAuditForWebhookEvent,
  appendSheetsSyncAudit,
  listFriendFieldDefinitions,
  listSheetsSyncLedger,
  listSoftDeletedInternalFormSubmissionIdsForSheets,
  listVerifiedInternalFormSubmissionsForSheets,
  recordSheetsFormResultsHeaders,
  releaseSheetsSyncLock,
  reserveSheetsSyncSequence,
  toJstString,
  updateInternalFormSubmissionAnswersForSheetsBySubmissionId,
  updateSheetsSyncStatus,
  type InternalFormSubmission,
  type SheetsCanonicalCellValue,
  type SheetsConnection,
  type SheetsFormAnswerHeader,
  type SheetsSyncAuditDetailInput,
  type SheetsSyncAuditSource,
  type SheetsSyncLedgerEntry,
  type SheetsSyncLeaseGuard,
} from '@line-crm/db';
import {
  answerDetail,
  appendedStartRow,
  canonicalValue,
  cellRange,
  cleanActor,
  columnLabel,
  detail,
  fingerprint,
  formAnswerFields,
  horizontalRange,
  listFriends,
  makeClient,
  parseFriendLedgerTimestamp,
  parseFriendLedgerWebhookEventPayload,
  parseInternalAnswers,
  quoteSheetName,
  saveImportedMetadata,
  warningText,
  type FriendLedgerEditRange,
  type FriendLedgerSheetsClient,
  type FriendLedgerWebhookSnapshot,
  type FriendState,
  type InternalAnswerState,
} from './friend-ledger-sync.js';
import {
  buildFormAnswerColumns,
  normalizeSheetCell,
  parseFormAnswerSheetValue,
  projectFormAnswerRow,
  resolveFriendLedgerHeaders,
  type FormAnswerField,
  type FriendLedgerColumn,
} from './friend-ledger-columns.js';
import { parseInternalFormDefinition } from './internal-form-runtime.js';
import type { GoogleSheetsClient, SheetCellValue, SheetsDataUpdate } from './google-sheets.js';

const LOCK_DURATION_MS = 2 * 60_000;
const MAX_SYNC_WARNINGS = 20;
const WEBHOOK_EVENT_CLAIM_MS = 2 * 60_000;
const WEBHOOK_EVENT_RETENTION_MS = 24 * 60 * 60_000;
const WEBHOOK_EVENT_RETRY_MS = 30_000;
const MAX_WEBHOOK_EVENT_ATTEMPTS = 5;
const MAX_WEBHOOK_EVENTS_PER_DRAIN = 20;

export const FORM_RESULTS_RECORD_KEY_PREFIX = 'sub:';

export function formResultsRecordKey(submissionId: string): string {
  return `${FORM_RESULTS_RECORD_KEY_PREFIX}${submissionId}`;
}

export function isFormResultsRecordKey(recordKey: string): boolean {
  return recordKey.startsWith(FORM_RESULTS_RECORD_KEY_PREFIX);
}

export interface FormResultsChunkCursor {
  submittedAt: string;
  submissionId: string;
}

export interface FormResultsChunkMetadata {
  processed: number;
  hasMore: boolean;
  cursor: FormResultsChunkCursor | null;
}

export interface SyncFormResultsOptions {
  db: D1Database;
  connection: SheetsConnection;
  client?: FormResultsSheetsClient;
  credentialsJson?: string;
  adminOrigin?: string | null;
  source: SheetsSyncAuditSource;
  actor: string;
  now?: () => Date;
  range?: FriendLedgerEditRange;
  snapshot?: FriendLedgerWebhookSnapshot;
  webhookEventId?: string;
  webhookOccurredAt?: string;
  webhookTargetError?: 'stale_webhook_generation';
  initialWarnings?: string[];
  chunk?: {
    limit: number;
    after: FormResultsChunkCursor | null;
    through?: FormResultsChunkCursor | null;
  };
}

type FormResultsSheetsClient = FriendLedgerSheetsClient & Partial<Pick<
  GoogleSheetsClient,
  'deleteRows' | 'resolveSheetId'
>>;

export interface FormResultsSyncResult {
  status: 'success' | 'warning' | 'running';
  busy: boolean;
  warning: string | null;
  warnings: string[];
  appendedRows: number;
  updatedRows: number;
  importedFields: number;
  ignoredIdentityEdits: number;
  chunk?: FormResultsChunkMetadata;
}

interface SubmissionRowState {
  submission: InternalFormSubmission;
  friend: FriendState | undefined;
  answers: InternalAnswerState;
}

interface ResultsRowPlan {
  row: SubmissionRowState;
  rowNumber: number;
  ledger: SheetsSyncLedgerEntry | null;
  canonical: Record<string, SheetsCanonicalCellValue>;
  details: SheetsSyncAuditDetailInput[];
  imports: Record<string, string>;
  customCells: Record<string, { columnKey: string; columnIndex: number; observed: string }>;
  answerCells: Record<string, {
    columnKey: string;
    columnIndex: number;
    observed: string;
    field: FormAnswerField;
  }>;
  answerImports: Record<string, unknown>;
  sheetUpdates: SheetsDataUpdate[];
  direction: 'to_sheets' | 'from_sheets';
  conflictResolution: 'harness_wins' | 'sheet_wins' | null;
  isAppend: boolean;
  webhookEventId?: string | null;
  auditOutcome?: 'applied' | 'skipped' | 'failed';
  auditErrorCode?: string | null;
}

function compareSubmissionCursor(
  submission: InternalFormSubmission,
  cursor: FormResultsChunkCursor,
): number {
  const submittedAt = submission.submitted_at < cursor.submittedAt
    ? -1
    : submission.submitted_at > cursor.submittedAt ? 1 : 0;
  if (submittedAt !== 0) return submittedAt;
  return submission.id < cursor.submissionId ? -1 : submission.id > cursor.submissionId ? 1 : 0;
}

/** Personal block on the left, then submission stamps, then answers. */
function buildFormResultsColumns(
  connection: SheetsConnection,
  answerFields: FormAnswerField[],
): FriendLedgerColumn[] {
  return [
    { key: 'identity:displayName', header: '表示名', kind: 'identity', readOnly: true },
    { key: 'identity:lineUserId', header: 'userId', kind: 'identity', readOnly: true },
    ...connection.friendFieldMappings.map((mapping) => ({
      key: `field:${mapping.fieldId}`,
      header: mapping.header,
      kind: 'custom' as const,
      readOnly: false,
    })),
    { key: 'identity:submittedAt', header: '送信日時', kind: 'identity', readOnly: true },
    { key: 'identity:submissionId', header: '送信ID', kind: 'identity', readOnly: true },
    ...buildFormAnswerColumns(connection.formId, answerFields),
  ];
}

async function persistResultsPlan(
  db: D1Database,
  connection: SheetsConnection,
  plan: ResultsRowPlan,
  now: string,
  renewLease: () => Promise<SheetsSyncLeaseGuard>,
): Promise<void> {
  const nextFingerprint = await fingerprint(plan.canonical);
  const changed = plan.isAppend
    || plan.details.length > 0
    || plan.ledger?.rowFingerprint !== nextFingerprint
    || plan.ledger?.sheetRowNumber !== plan.rowNumber;
  const needsBaseline = !plan.ledger;
  if (!changed && !needsBaseline) return;
  const lease = await renewLease();
  const sequence = await reserveSheetsSyncSequence(
    db,
    connection.lineAccountId,
    connection.id,
    connection.configVersion,
    lease,
  );
  if (sequence === null) throw new Error('stale_sheets_connection_generation');
  const committed = await commitSheetsSyncRow(db, connection.lineAccountId, {
    audit: {
      id: `gsa_${crypto.randomUUID()}`,
      connectionId: connection.id,
      connectionVersion: connection.configVersion,
      applySequence: sequence,
      recordKey: formResultsRecordKey(plan.row.submission.id),
      sheetRowNumber: plan.rowNumber,
      direction: plan.direction,
      action: plan.isAppend ? 'append' : plan.conflictResolution ? 'conflict' : changed ? 'update' : 'read',
      outcome: plan.auditOutcome ?? (changed || plan.isAppend ? 'applied' : 'skipped'),
      conflictResolution: plan.conflictResolution,
      harnessUpdatedAt: plan.row.submission.submitted_at,
      sheetObservedAt: now,
      beforeFingerprint: plan.ledger?.rowFingerprint ?? null,
      afterFingerprint: nextFingerprint,
      errorCode: plan.auditErrorCode ?? (plan.details.some((entry) => entry.changeKind === 'identity_ignored')
        ? 'identity_read_only'
        : null),
      webhookEventId: plan.webhookEventId ?? null,
      details: plan.details,
    },
    ledger: {
      connectionId: connection.id,
      connectionVersion: connection.configVersion,
      recordKey: formResultsRecordKey(plan.row.submission.id),
      sheetRowNumber: plan.rowNumber,
      rowFingerprint: nextFingerprint,
      canonicalSnapshot: plan.canonical,
      harnessUpdatedAt: plan.row.submission.submitted_at,
      sheetObservedAt: now,
      lastSyncedAt: now,
      lastSyncDirection: plan.direction,
      lastAppliedSequence: sequence,
    },
  }, lease);
  if (!committed) throw new Error('stale_sheets_row_commit_generation');
}

export async function syncFormResults(
  options: SyncFormResultsOptions,
): Promise<FormResultsSyncResult> {
  if (!options.connection.formResultsEnabled || !options.connection.formResultsSheetName) {
    const warnings = ['フォーム回答の同期設定が有効ではありません'];
    return {
      status: 'warning', busy: false, warning: warnings[0], warnings,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
    };
  }
  const resultsSheetName = options.connection.formResultsSheetName;
  const nowFactory = options.now ?? (() => new Date());
  const started = nowFactory();
  const startedAt = toJstString(started);
  const lockToken = `gsl_${crypto.randomUUID()}`;
  const lockExpiresAt = toJstString(new Date(started.getTime() + LOCK_DURATION_MS));
  const actor = cleanActor(options.actor, options.source);
  const acquired = await claimSheetsSyncLock(
    options.db,
    options.connection.lineAccountId,
    options.connection.id,
    lockToken,
    startedAt,
    lockExpiresAt,
    options.connection.configVersion,
  );
  if (!acquired) {
    const warnings = ['別の同期処理が実行中です'];
    return {
      status: 'warning', busy: true, warning: warnings[0], warnings,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
    };
  }

  const renewLease = async (): Promise<SheetsSyncLeaseGuard> => {
    const leaseTime = nowFactory();
    const leaseNow = toJstString(leaseTime);
    const renewed = await claimSheetsSyncLock(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      lockToken,
      leaseNow,
      toJstString(new Date(leaseTime.getTime() + LOCK_DURATION_MS)),
      options.connection.configVersion,
    );
    if (!renewed) throw new Error('form_results_sync_lock_lost');
    return { token: lockToken, now: leaseNow };
  };

  let failure: unknown;
  try {
    const runningStatus = await updateSheetsSyncStatus(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      {
        status: 'running',
        lastSyncAt: options.connection.lastSyncAt,
        warning: null,
        errorCode: null,
      },
      { token: lockToken, now: startedAt },
    );
    if (!runningStatus) throw new Error('form_results_sync_lock_lost');
    let effectiveWebhookTargetError = options.webhookTargetError;
    if (
      !effectiveWebhookTargetError
      && options.source === 'webhook'
      && options.webhookOccurredAt
    ) {
      // This read happens only after this worker owns the same sync lock used
      // by row deletion. A drain-level read could race with a polling delete
      // between checking the fence and acquiring the lock.
      const shiftFence = await getFormResultsRowShiftFence(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
      );
      const occurredTimestamp = parseFriendLedgerTimestamp(options.webhookOccurredAt);
      const shiftedTimestamp = Math.max(
        ...[shiftFence.shiftedAt, shiftFence.pendingUntil].flatMap((timestamp) => {
          if (!timestamp) return [];
          const parsed = parseFriendLedgerTimestamp(timestamp);
          return Number.isFinite(parsed) ? [parsed] : [];
        }),
        Number.NEGATIVE_INFINITY,
      );
      if (
        Number.isFinite(occurredTimestamp)
        && Number.isFinite(shiftedTimestamp)
        && occurredTimestamp <= shiftedTimestamp
      ) effectiveWebhookTargetError = 'stale_webhook_generation';
    }
    const client = makeClient(options) as FormResultsSheetsClient;
    const [
      submissions,
      allLedgerEntries,
      definitions,
      friends,
      response,
      form,
      softDeletedSubmissionIds,
    ] = await Promise.all([
      listVerifiedInternalFormSubmissionsForSheets(
        options.db,
        options.connection.lineAccountId,
        options.connection.formId,
      ),
      listSheetsSyncLedger(options.db, options.connection.lineAccountId, options.connection.id),
      listFriendFieldDefinitions(options.db),
      listFriends(options.db, options.connection.lineAccountId),
      client.readValues(
        options.connection.spreadsheetId,
        quoteSheetName(resultsSheetName),
      ),
      getFormalooForm(options.db, options.connection.formId),
      listSoftDeletedInternalFormSubmissionIdsForSheets(
        options.db,
        options.connection.lineAccountId,
        options.connection.formId,
      ),
    ]);
    await renewLease();
    const warnings: string[] = [];
    const warningSet = new Set<string>();
    const addWarning = (message: string): void => {
      if (warningSet.has(message)) return;
      warningSet.add(message);
      if (warnings.length < MAX_SYNC_WARNINGS) warnings.push(message);
    };
    for (const warning of options.initialWarnings ?? []) addWarning(warning);

    const defaults = new Map(definitions.map((definition) => [definition.id, definition.defaultValue]));
    const ledgerEntries = allLedgerEntries.filter((entry) => isFormResultsRecordKey(entry.recordKey));
    const ledgerBySubmission = new Map(ledgerEntries.map((entry) => [
      entry.recordKey.slice(FORM_RESULTS_RECORD_KEY_PREFIX.length),
      entry,
    ]));
    const friendById = new Map(friends.map((friend) => [friend.id, friend]));
    const values = (response.values ?? []).map((row) => [...row]);
    const deletedSubmissionIdSet = new Set(softDeletedSubmissionIds);
    const deletedLedgerSubmissionIds = ledgerEntries.flatMap((entry) => {
      const submissionId = entry.recordKey.slice(FORM_RESULTS_RECORD_KEY_PREFIX.length);
      return deletedSubmissionIdSet.has(submissionId) ? [submissionId] : [];
    });
    const preclearedRowKeys = new Set<string>();
    const removeDeletedLedgerEntries = async (submissionIds: string[]): Promise<void> => {
      if (submissionIds.length === 0) return;
      const lease = await renewLease();
      const removed = await deleteSoftDeletedInternalFormSubmissionLedgerEntries(options.db, {
        lineAccountId: options.connection.lineAccountId,
        connectionId: options.connection.id,
        connectionVersion: options.connection.configVersion,
        formId: options.connection.formId,
        submissionIds,
        lease,
      });
      if (!removed) throw new Error('form_results_deleted_ledger_cleanup_failed');
      for (const submissionId of submissionIds) ledgerBySubmission.delete(submissionId);
    };

    // Answer column ownership mirrors the ledger tab, recorded separately in
    // form_results_headers_json so the two tabs never fight over headings.
    // Recorded results headers mix answer entries (fieldId = form field id)
    // with personal-block entries (fieldId = column key). Keep them separate
    // so a personal heading is never mistaken for a removed answer field.
    const isPersonalHeaderEntry = (entry: SheetsFormAnswerHeader): boolean => (
      entry.fieldId.startsWith('identity:') || entry.fieldId.startsWith('field:')
    );
    const recordedPersonalHeaders = options.connection.formResultsHeaders.filter(isPersonalHeaderEntry);
    const recordedAnswerHeaders = options.connection.formResultsHeaders
      .filter((entry) => !isPersonalHeaderEntry(entry));
    let activeAnswerFields: FormAnswerField[] = [];
    let removedAnswerFields: FormAnswerField[] = [];
    let answerHeadersToRecord: SheetsFormAnswerHeader[] = recordedAnswerHeaders;
    const newAnswerColumnKeys = new Set<string>();
    let answerSyncEnabled = false;
    if (form?.render_backend !== 'internal') {
      addWarning('回答フォームが内製フォームではないため、回答列の同期をスキップしました');
    } else if (
      form.deleted !== 0
      || (form.line_account_id !== null && form.line_account_id !== options.connection.lineAccountId)
    ) {
      addWarning('回答フォームの所属を確認できないため、回答列の同期をスキップしました');
    } else {
      const parsed = parseInternalFormDefinition(form.definition_json);
      if (!parsed.ok) {
        addWarning(`回答フォーム定義を読み込めないため、回答列の同期をスキップしました: ${parsed.error}`);
      } else {
        answerSyncEnabled = true;
        const allDefinedFields = formAnswerFields(parsed.definition.fields);
        const selectedFieldIds = options.connection.selectedFormFieldIds == null
          ? null
          : new Set(options.connection.selectedFormFieldIds);
        const definedFields = selectedFieldIds === null
          ? allDefinedFields
          : allDefinedFields.filter((field) => selectedFieldIds.has(field.fieldId));
        const allDefinedById = new Map(allDefinedFields.map((field) => [field.fieldId, field]));
        const ownedById = new Map(
          recordedAnswerHeaders.map((header) => [header.fieldId, header]),
        );
        const definedHeaderCounts = new Map<string, number>();
        for (const field of definedFields) {
          definedHeaderCounts.set(field.header, (definedHeaderCounts.get(field.header) ?? 0) + 1);
        }
        const personalHeaders = buildFormResultsColumns(options.connection, [])
          .map((column) => column.header);
        const reservedHeaders = new Set([
          ...values[0]?.map(normalizeSheetCell).filter(Boolean) ?? [],
          ...personalHeaders,
          ...options.connection.formResultsHeaders.map((header) => header.header),
        ]);
        const newlyOwned: SheetsFormAnswerHeader[] = [];
        for (const field of definedFields) {
          const owned = ownedById.get(field.fieldId);
          if (owned) {
            activeAnswerFields.push({ ...field, header: owned.header });
            continue;
          }
          if ((definedHeaderCounts.get(field.header) ?? 0) > 1 || reservedHeaders.has(field.header)) {
            addWarning(`回答見出し「${field.header.slice(0, 200)}」は既存の列と重複するため追加しませんでした`);
            continue;
          }
          activeAnswerFields.push(field);
          newlyOwned.push({ fieldId: field.fieldId, header: field.header });
          newAnswerColumnKeys.add(`answer:${options.connection.formId}:${field.fieldId}`);
          reservedHeaders.add(field.header);
        }
        removedAnswerFields = recordedAnswerHeaders.flatMap((owned) => (
          allDefinedById.has(owned.fieldId)
            ? []
            : [{ fieldId: owned.fieldId, header: owned.header, type: 'removed', readOnly: true }]
        ));
        answerHeadersToRecord = [
          ...recordedAnswerHeaders,
          ...newlyOwned,
        ];
      }
    }
    const answerFields = [...activeAnswerFields, ...removedAnswerFields];
    const answerFieldByKey = new Map(answerFields.map((field) => [
      `answer:${options.connection.formId}:${field.fieldId}`,
      field,
    ]));
    const columns = buildFormResultsColumns(options.connection, answerFields);
    // Personal-block headings are recorded under their column key so a later
    // owner rename is warned about instead of silently recreating the column
    // (same invariant as friend_ledger_headers_json on the ledger tab).
    const recordedPersonalByKey = new Map(
      recordedPersonalHeaders.map((header) => [header.fieldId, header]),
    );
    const newPersonalEntries = columns
      .filter((column) => column.kind !== 'answer' && !recordedPersonalByKey.has(column.key))
      .map((column) => ({ fieldId: column.key, header: column.header }));
    const newGeneratedColumnKeys = new Set([
      ...newPersonalEntries.map((entry) => entry.fieldId),
      ...newAnswerColumnKeys,
    ]);
    const headersToRecord = [...answerHeadersToRecord, ...recordedPersonalHeaders, ...newPersonalEntries];
    const headersChanged = JSON.stringify(headersToRecord)
      !== JSON.stringify(options.connection.formResultsHeaders);
    const recordResultsHeaders = async (): Promise<void> => {
      if (!headersChanged) return;
      const lease = await renewLease();
      const recorded = await recordSheetsFormResultsHeaders(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        headersToRecord,
        lease,
      );
      if (!recorded) throw new Error('form_results_sync_lock_lost');
    };

    // Chunk selection over the (submitted_at, id) cursor.
    const rowStates: SubmissionRowState[] = [];
    for (const submission of submissions) {
      // The active/deleted reads run concurrently. If an admin deletion lands
      // between them, the tombstone wins so this pass cannot re-append the row.
      if (deletedSubmissionIdSet.has(submission.id)) continue;
      const friend = submission.friend_id ? friendById.get(submission.friend_id) : undefined;
      if (submission.friend_id && !friend) continue;
      rowStates.push({ submission, friend, answers: parseInternalAnswers(submission) });
    }
    const chunkLimit = options.chunk
      ? Math.min(500, Math.max(1, Math.trunc(options.chunk.limit)))
      : rowStates.length;
    const chunkCandidatesWithLookahead = options.chunk
      ? rowStates.filter((state) => (
        (!options.chunk!.after || compareSubmissionCursor(state.submission, options.chunk!.after) > 0)
        && (
          options.chunk!.through === undefined
          || (
            options.chunk!.through !== null
            && compareSubmissionCursor(state.submission, options.chunk!.through) <= 0
          )
        )
      )).slice(0, chunkLimit + 1)
      : rowStates;
    const chunkRows = options.chunk
      ? chunkCandidatesWithLookahead.slice(0, chunkLimit)
      : chunkCandidatesWithLookahead;
    const lastChunkRow = chunkRows.at(-1);
    const chunkMetadata: FormResultsChunkMetadata | undefined = options.chunk
      ? {
        processed: chunkRows.length,
        hasMore: chunkCandidatesWithLookahead.length > chunkLimit,
        cursor: lastChunkRow
          ? { submittedAt: lastChunkRow.submission.submitted_at, submissionId: lastChunkRow.submission.id }
          : options.chunk.after,
      }
      : undefined;

    const projectionForRow = (state: SubmissionRowState): Record<string, string> => {
      const metadata = { ...(state.friend?.metadata ?? {}) };
      if (state.friend) {
        for (const mapping of options.connection.friendFieldMappings) {
          if (metadata[mapping.header] === undefined && defaults.has(mapping.fieldId)) {
            metadata[mapping.header] = defaults.get(mapping.fieldId);
          }
        }
      }
      return {
        'identity:displayName': state.friend?.displayName ?? '',
        'identity:lineUserId': state.friend?.lineUserId ?? '',
        'identity:submittedAt': state.submission.submitted_at,
        'identity:submissionId': state.submission.id,
        ...Object.fromEntries(options.connection.friendFieldMappings.map((mapping) => [
          `field:${mapping.fieldId}`,
          normalizeSheetCell(metadata[mapping.header]),
        ])),
        ...projectFormAnswerRow(
          options.connection.formId,
          activeAnswerFields,
          state.answers.valid ? state.answers.answers : {},
          { adminOrigin: options.adminOrigin, submissionId: state.submission.id },
        ),
        ...Object.fromEntries(removedAnswerFields.map((field) => [
          `answer:${options.connection.formId}:${field.fieldId}`,
          '',
        ])),
      };
    };

    // Webhook snapshot targeting: the results tab locates its row through the
    // 送信ID column instead of userId.
    let liveSnapshotValue: string | null = null;
    let snapshotRowState: SubmissionRowState | null = null;
    let snapshotTargetError:
      | 'stale_webhook_generation'
      | 'stale_webhook_target'
      | 'unsafe_webhook_identity'
      | 'unselected_webhook_column'
      | 'stale_webhook_event'
      | null
      = effectiveWebhookTargetError ?? null;
    if (options.source === 'webhook' && options.snapshot) {
      const rowIndex = options.snapshot.rowNumber - 1;
      const columnIndex = options.snapshot.columnNumber - 1;
      liveSnapshotValue = normalizeSheetCell(values[rowIndex]?.[columnIndex]);
      const rawHeaders = values[0] ?? [];
      const normalizedHeaders = rawHeaders.map(normalizeSheetCell);
      const headerIndexes = normalizedHeaders
        .map((header, index) => header === options.snapshot!.header ? index : -1)
        .filter((index) => index >= 0);
      const submissionIdIndexes = normalizedHeaders
        .map((header, index) => header === '送信ID' ? index : -1)
        .filter((index) => index >= 0);
      const rowSubmissionId = submissionIdIndexes.length === 1
        ? normalizeSheetCell(values[rowIndex]?.[submissionIdIndexes[0]])
        : '';
      snapshotRowState = rowSubmissionId
        ? chunkRows.find((state) => state.submission.id === rowSubmissionId) ?? null
        : null;
      if (!snapshotTargetError) {
        const configuredTargets = columns.filter((column) => column.header === options.snapshot!.header);
        const matchingRows = rowSubmissionId && submissionIdIndexes.length === 1
          ? values.flatMap((row, index) => (
            index > 0 && normalizeSheetCell(row[submissionIdIndexes[0]]) === rowSubmissionId
              ? [index + 1]
              : []
          ))
          : [];
        if (options.snapshot.rowNumber === 1) {
          snapshotTargetError = 'stale_webhook_target';
        } else if (configuredTargets.length === 0) {
          snapshotTargetError = 'unselected_webhook_column';
        } else if (configuredTargets.length !== 1) {
          snapshotTargetError = 'stale_webhook_target';
        } else if (headerIndexes.length !== 1 || headerIndexes[0] !== columnIndex) {
          snapshotTargetError = 'stale_webhook_target';
        } else if (
          submissionIdIndexes.length !== 1
          || !rowSubmissionId
          || !snapshotRowState
          || matchingRows.length !== 1
          || matchingRows[0] !== options.snapshot.rowNumber
        ) {
          snapshotTargetError = 'unsafe_webhook_identity';
        } else if (
          !options.snapshot.oldValueKnown
          && liveSnapshotValue !== normalizeSheetCell(options.snapshot.value)
        ) {
          snapshotTargetError = 'stale_webhook_event';
        }
      }
    }
    if (snapshotTargetError && options.snapshot) {
      const message = snapshotTargetError === 'unsafe_webhook_identity'
        ? '編集通知の送信IDから回答行を安全に特定できないため、取り込みませんでした'
        : snapshotTargetError === 'unselected_webhook_column'
          ? '同期対象に選ばれていない列の編集通知は取り込みませんでした'
          : snapshotTargetError === 'stale_webhook_event'
            ? '保護のため、古い編集通知を取り込みませんでした'
            : '編集後に行・列または同期設定が変わったため、古い編集通知を取り込みませんでした';
      addWarning(message);
      const completedAt = toJstString(nowFactory());
      const ledger = snapshotRowState
        ? ledgerBySubmission.get(snapshotRowState.submission.id) ?? null
        : null;
      const lease = await renewLease();
      const sequence = await reserveSheetsSyncSequence(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        lease,
      );
      if (sequence === null) throw new Error('stale_sheets_connection_generation');
      const identityEdit = ['表示名', 'userId', '送信日時', '送信ID'].includes(options.snapshot.header);
      const auditWritten = await appendSheetsSyncAudit(options.db, options.connection.lineAccountId, {
        id: `gsa_${crypto.randomUUID()}`,
        connectionId: options.connection.id,
        connectionVersion: options.connection.configVersion,
        applySequence: sequence,
        recordKey: snapshotRowState ? formResultsRecordKey(snapshotRowState.submission.id) : null,
        sheetRowNumber: options.snapshot.rowNumber,
        direction: 'from_sheets',
        action: 'conflict',
        outcome: 'skipped',
        conflictResolution: null,
        harnessUpdatedAt: snapshotRowState?.submission.submitted_at ?? null,
        sheetObservedAt: completedAt,
        beforeFingerprint: ledger?.rowFingerprint ?? null,
        afterFingerprint: ledger?.rowFingerprint ?? null,
        errorCode: snapshotTargetError,
        webhookEventId: options.webhookEventId ?? null,
        details: [answerDetail(
          actor,
          options.snapshot.header,
          options.source,
          identityEdit ? 'identity_ignored' : 'conflict',
        )],
      }, lease);
      if (!auditWritten) throw new Error('stale_sheets_audit_generation');
      const finalLease = await renewLease();
      const statusUpdated = await updateSheetsSyncStatus(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        {
          status: 'warning',
          lastSyncAt: completedAt,
          warning: warnings.join(' / '),
          errorCode: snapshotTargetError,
        },
        finalLease,
      );
      if (!statusUpdated) throw new Error('form_results_sync_lock_lost');
      return {
        status: 'warning',
        busy: false,
        warning: warnings.join(' / '),
        warnings,
        appendedRows: 0,
        updatedRows: 0,
        importedFields: 0,
        ignoredIdentityEdits: identityEdit ? 1 : 0,
      };
    }

    const effectiveRow = (rowNumber: number): SheetCellValue[] => {
      const row = [...(values[rowNumber - 1] ?? [])];
      if (options.source === 'webhook' && options.snapshot?.rowNumber === rowNumber) {
        row[options.snapshot.columnNumber - 1] = options.snapshot.value;
      }
      return row;
    };
    const isNotifiedCell = (rowNumber: number, columnIndex: number): boolean => {
      if (options.source !== 'webhook' || !options.range) return true;
      return rowNumber >= options.range.rowStart
        && rowNumber <= options.range.rowEnd
        && columnIndex + 1 >= options.range.columnStart
        && columnIndex + 1 <= options.range.columnEnd;
    };
    const snapshotForCell = (
      rowNumber: number,
      columnIndex: number,
    ): { value: string; oldValue: string; oldValueKnown: boolean; liveValue: string } | null => {
      if (
        options.source !== 'webhook'
        || !options.snapshot
        || options.snapshot.rowNumber !== rowNumber
        || options.snapshot.columnNumber !== columnIndex + 1
      ) return null;
      return {
        value: normalizeSheetCell(options.snapshot.value),
        oldValue: normalizeSheetCell(options.snapshot.oldValue),
        oldValueKnown: options.snapshot.oldValueKnown,
        liveValue: liveSnapshotValue ?? '',
      };
    };

    const plans: ResultsRowPlan[] = [];
    let appendedRows = 0;
    let deletedRows = 0;
    let importedFields = 0;
    let ignoredIdentityEdits = 0;
    const generatedHeaders = columns.map((column) => column.header);
    const headerIsEmpty = values.length === 0 || !effectiveRow(1).some((cell) => normalizeSheetCell(cell));
    const hasEstablishedDataRows = values.slice(1)
      .some((row) => row.some((cell) => normalizeSheetCell(cell)));

    if (headerIsEmpty) {
      await renewLease();
      await client.updateValues(
        options.connection.spreadsheetId,
        `${quoteSheetName(resultsSheetName)}!A1:${columnLabel(Math.max(0, generatedHeaders.length - 1))}1`,
        [generatedHeaders],
      );
      values[0] = [...generatedHeaders];
      await recordResultsHeaders();
    }
    if (
      options.source !== 'webhook'
      && headerIsEmpty
      && !hasEstablishedDataRows
      && deletedLedgerSubmissionIds.length > 0
    ) {
      await removeDeletedLedgerEntries(deletedLedgerSubmissionIds);
    }
    if (headerIsEmpty && !hasEstablishedDataRows) {
      if (chunkRows.length > 0) {
        const rows = chunkRows.map((state) => {
          const projection = projectionForRow(state);
          return columns.map((column) => projection[column.key] ?? '');
        });
        await renewLease();
        const appended = await client.appendValues(
          options.connection.spreadsheetId,
          `${quoteSheetName(resultsSheetName)}!A:${columnLabel(Math.max(0, generatedHeaders.length - 1))}`,
          rows,
        );
        appendedRows = chunkRows.length;
        const firstAppendedRow = appendedStartRow(appended, 2);
        chunkRows.forEach((state, index) => {
          const projection = projectionForRow(state);
          const canonical = Object.fromEntries(
            columns.map((column) => [column.key, canonicalValue(projection[column.key] ?? '')]),
          );
          plans.push({
            row: state,
            rowNumber: firstAppendedRow + index,
            ledger: null,
            canonical,
            imports: {},
            customCells: {},
            answerCells: {},
            answerImports: {},
            sheetUpdates: [],
            direction: 'to_sheets',
            conflictResolution: null,
            isAppend: true,
            details: columns
              .filter((column) => column.kind !== 'identity')
              .map((column) => (
                column.kind === 'answer'
                  ? answerDetail(actor, column.header, options.source, 'custom_field')
                  : detail(actor, column.header, null, projection[column.key] ?? '', options.source, 'custom_field')
              )),
          });
        });
      }
    } else {
      let headers = effectiveRow(1);
      let resolved = resolveFriendLedgerHeaders(headers, columns);
      if (newGeneratedColumnKeys.size > 0) {
        const configuredCounts = new Map<string, number>();
        for (const column of columns) {
          configuredCounts.set(column.header, (configuredCounts.get(column.header) ?? 0) + 1);
        }
        const present = new Set(headers.map(normalizeSheetCell));
        const additions = columns
          .filter((column) => (
            newGeneratedColumnKeys.has(column.key)
            && (configuredCounts.get(column.header) ?? 0) === 1
            && !present.has(column.header)
          ))
          .map((column) => column.header);
        if (additions.length > 0) {
          await renewLease();
          await client.updateValues(
            options.connection.spreadsheetId,
            horizontalRange(resultsSheetName, 1, headers.length, additions.length),
            [additions],
          );
          headers = [...headers, ...additions];
          values[0] = headers;
          resolved = resolveFriendLedgerHeaders(headers, columns);
        }
      }
      await recordResultsHeaders();
      for (const headerWarning of resolved.warnings) {
        addWarning(warningText(headerWarning.code, headerWarning.header));
      }
      let submissionIdIndex = resolved.indexByKey['identity:submissionId'];
      const positions = new Map<string, number[]>();
      const indexSubmissionRows = (): void => {
        positions.clear();
        if (submissionIdIndex === undefined) return;
        for (let index = 1; index < values.length; index += 1) {
          const submissionId = normalizeSheetCell(effectiveRow(index + 1)[submissionIdIndex]);
          if (!submissionId) continue;
          const rows = positions.get(submissionId) ?? [];
          rows.push(index + 1);
          positions.set(submissionId, rows);
        }
      };
      indexSubmissionRows();
      if (submissionIdIndex !== undefined) {
        for (const [, rows] of positions) {
          if (rows.length > 1) addWarning('送信IDが重複している行があります');
        }
      }
      const deletionSubmissionIds = new Set(deletedLedgerSubmissionIds);
      for (const submissionId of positions.keys()) {
        if (deletedSubmissionIdSet.has(submissionId)) deletionSubmissionIds.add(submissionId);
      }
      if (
        options.source !== 'webhook'
        && !chunkMetadata?.hasMore
        && deletionSubmissionIds.size > 0
      ) {
        const candidateRows = new Map<string, number>();
        if (submissionIdIndex === undefined) {
          addWarning('送信ID列が見つからないため、削除済み回答の行を除去できませんでした');
        } else {
          for (const submissionId of deletionSubmissionIds) {
            const matchingRows = positions.get(submissionId) ?? [];
            if (matchingRows.length === 0) {
              if (ledgerBySubmission.has(submissionId)) {
                addWarning('削除済み回答の送信IDが見つからないため、行を除去しませんでした');
              }
              continue;
            }
            if (matchingRows.length > 1) {
              addWarning('削除済み回答と同じ送信IDが複数あるため、行を除去できませんでした');
              continue;
            }
            candidateRows.set(submissionId, matchingRows[0]);
          }
        }
        if (candidateRows.size > 0) {
          // Resolve the stable tab id before the final cell preflight. The
          // production client caches it, so deleteRows can issue batchUpdate
          // immediately instead of widening the row-number race with another
          // metadata round trip.
          if (client.resolveSheetId) {
            await client.resolveSheetId(options.connection.spreadsheetId, resultsSheetName);
          }
          const shiftIntentLease = await renewLease();
          const shiftIntentStarted = await beginFormResultsRowShift(options.db, {
            lineAccountId: options.connection.lineAccountId,
            connectionId: options.connection.id,
            connectionVersion: options.connection.configVersion,
            formId: options.connection.formId,
            pendingUntil: toJstString(new Date(nowFactory().getTime() + LOCK_DURATION_MS)),
            lease: shiftIntentLease,
          });
          if (!shiftIntentStarted) throw new Error('form_results_row_shift_intent_failed');
          const cancelShiftIntent = async (): Promise<void> => {
            const cancelLease = await renewLease();
            const cancelled = await cancelFormResultsRowShift(options.db, {
              lineAccountId: options.connection.lineAccountId,
              connectionId: options.connection.id,
              connectionVersion: options.connection.configVersion,
              formId: options.connection.formId,
              lease: cancelLease,
            });
            if (!cancelled) throw new Error('form_results_row_shift_intent_cancel_failed');
          };
          // Recheck both systems immediately before the destructive call. The
          // Sheets lease only serializes Harness workers; it cannot prevent a
          // person from sorting or inserting a row in Google Sheets.
          await renewLease();
          let freshState;
          try {
            freshState = await Promise.all([
              listSoftDeletedInternalFormSubmissionIdsForSheets(
                options.db,
                options.connection.lineAccountId,
                options.connection.formId,
              ),
              client.readValues(
                options.connection.spreadsheetId,
                quoteSheetName(resultsSheetName),
              ),
            ]);
          } catch (error) {
            // The destructive request was never issued, so this intent cannot
            // represent an uncertain row shift and must not stale webhooks.
            await cancelShiftIntent();
            throw error;
          }
          const [freshDeletedSubmissionIds, freshResponse] = freshState;
          const freshDeletedSubmissionIdSet = new Set(freshDeletedSubmissionIds);
          for (const submissionId of freshDeletedSubmissionIdSet) {
            deletedSubmissionIdSet.add(submissionId);
          }
          values.splice(
            0,
            values.length,
            ...(freshResponse.values ?? []).map((row) => [...row]),
          );
          headers = effectiveRow(1);
          resolved = resolveFriendLedgerHeaders(headers, columns);
          submissionIdIndex = resolved.indexByKey['identity:submissionId'];
          for (const headerWarning of resolved.warnings) {
            addWarning(warningText(headerWarning.code, headerWarning.header));
          }
          indexSubmissionRows();
          const safeSubmissionIds: string[] = [];
          const rowsToDelete: number[] = [];
          if (submissionIdIndex === undefined) {
            addWarning('送信ID列が見つからないため、削除済み回答の行を除去できませんでした');
          } else {
            for (const [submissionId, originalRow] of candidateRows) {
              if (!freshDeletedSubmissionIdSet.has(submissionId)) {
                addWarning('回答の削除状態を再確認できないため、行を除去しませんでした');
                continue;
              }
              const freshRows = positions.get(submissionId) ?? [];
              if (freshRows.length === 0) {
                addWarning('削除済み回答の送信IDが見つからないため、行を除去しませんでした');
                continue;
              }
              if (freshRows.length > 1) {
                addWarning('削除済み回答と同じ送信IDが複数あるため、行を除去できませんでした');
                continue;
              }
              if (freshRows[0] !== originalRow) {
                addWarning('削除直前に回答行が移動したため、行を除去しませんでした');
                continue;
              }
              safeSubmissionIds.push(submissionId);
              rowsToDelete.push(originalRow);
            }
          }
          if (safeSubmissionIds.length > 0) {
            if (!client.deleteRows) {
              await cancelShiftIntent();
              throw new Error('form_results_row_delete_unsupported');
            }
            const deleted = await client.deleteRows(
              options.connection.spreadsheetId,
              resultsSheetName,
              rowsToDelete,
            );
            if (deleted.deletedRows !== rowsToDelete.length) {
              throw new Error('form_results_row_delete_incomplete');
            }
            const shiftLease = await renewLease();
            const shiftMarked = await completeFormResultsRowShift(options.db, {
              lineAccountId: options.connection.lineAccountId,
              connectionId: options.connection.id,
              connectionVersion: options.connection.configVersion,
              formId: options.connection.formId,
              shiftedAt: toJstString(nowFactory()),
              lease: shiftLease,
            });
            if (!shiftMarked) throw new Error('form_results_row_shift_fence_failed');
            deletedRows += deleted.deletedRows;
            for (const rowNumber of [...rowsToDelete].sort((left, right) => right - left)) {
              values.splice(rowNumber - 1, 1);
            }

            const activeLedgerKeys = ledgerEntries
              .filter((entry) => !deletedSubmissionIdSet.has(
                entry.recordKey.slice(FORM_RESULTS_RECORD_KEY_PREFIX.length),
              ))
              .map((entry) => entry.recordKey);
            if (activeLedgerKeys.length > 0) {
              const lease = await renewLease();
              const cleared = await clearSheetsSyncLedgerRowNumbers(
                options.db,
                options.connection.lineAccountId,
                options.connection.id,
                options.connection.configVersion,
                activeLedgerKeys,
                lease,
              );
              if (!cleared) throw new Error('form_results_sync_lock_lost');
              for (const [submissionId, ledger] of ledgerBySubmission) {
                if (deletedSubmissionIdSet.has(submissionId)) continue;
                ledgerBySubmission.set(submissionId, { ...ledger, sheetRowNumber: null });
                preclearedRowKeys.add(formResultsRecordKey(submissionId));
              }
            }
            await removeDeletedLedgerEntries(
              safeSubmissionIds.filter((submissionId) => ledgerBySubmission.has(submissionId)),
            );
            indexSubmissionRows();
          } else {
            await cancelShiftIntent();
          }
        }
      }
      const pendingChunkAppends: Array<{ plan: ResultsRowPlan; row: SheetCellValue[] }> = [];
      for (const state of chunkRows) {
        // A tombstone discovered by the destructive preflight wins over the
        // earlier active snapshot; never import or recommit that stale row.
        if (deletedSubmissionIdSet.has(state.submission.id)) continue;
        const ledger = ledgerBySubmission.get(state.submission.id) ?? null;
        const matchingRows = positions.get(state.submission.id) ?? [];
        if (matchingRows.length > 1) continue;
        const rowNumber = matchingRows.length === 1 ? matchingRows[0] : null;
        const projection = projectionForRow(state);
        if (!rowNumber) {
          if (submissionIdIndex === undefined) {
            addWarning('送信ID列が見つからないため、回答行を追記できませんでした');
            continue;
          }
          const nextRow: SheetCellValue[] = Array.from({ length: headers.length }, () => '');
          for (const column of columns) {
            const index = resolved.indexByKey[column.key];
            if (index !== undefined) nextRow[index] = projection[column.key] ?? '';
          }
          const canonical = Object.fromEntries(
            columns.map((column) => [column.key, canonicalValue(projection[column.key] ?? '')]),
          );
          const restoredDeletedRow = Boolean(ledger?.sheetRowNumber);
          if (restoredDeletedRow) {
            addWarning('回答行の削除を検知し、元に戻しました');
          }
          const appendPlan: ResultsRowPlan = {
            row: state, rowNumber: 0, ledger, canonical, imports: {}, customCells: {},
            answerCells: {}, answerImports: {}, sheetUpdates: [],
            direction: 'to_sheets',
            conflictResolution: restoredDeletedRow ? 'harness_wins' : null,
            isAppend: true,
            details: columns
              .filter((column) => restoredDeletedRow || column.kind !== 'identity')
              .map((column) => (
                column.kind === 'answer'
                  ? answerDetail(
                    actor,
                    column.header,
                    options.source,
                    restoredDeletedRow ? 'conflict' : 'custom_field',
                  )
                  : detail(
                    actor,
                    column.header,
                    restoredDeletedRow ? projection[column.key] ?? '' : null,
                    restoredDeletedRow ? '' : projection[column.key] ?? '',
                    options.source,
                    restoredDeletedRow
                      ? column.kind === 'identity' ? 'identity_ignored' : 'conflict'
                      : 'custom_field',
                  )
              )),
          };
          pendingChunkAppends.push({ plan: appendPlan, row: nextRow });
          plans.push(appendPlan);
          continue;
        }

        const sheetRow = effectiveRow(rowNumber);
        const details: SheetsSyncAuditDetailInput[] = [];
        const imports: Record<string, string> = {};
        const customCells: ResultsRowPlan['customCells'] = {};
        const answerCells: ResultsRowPlan['answerCells'] = {};
        const answerImports: Record<string, unknown> = {};
        const sheetUpdates: SheetsDataUpdate[] = [];
        const canonical: Record<string, SheetsCanonicalCellValue> = {};
        let direction: ResultsRowPlan['direction'] = 'to_sheets';
        let conflictResolution: ResultsRowPlan['conflictResolution'] = null;
        let webhookEventId: string | null = null;
        let auditOutcome: ResultsRowPlan['auditOutcome'];
        let auditErrorCode: string | null | undefined;

        for (const column of columns) {
          const expected = projection[column.key] ?? '';
          const columnIndex = resolved.indexByKey[column.key];
          if (columnIndex === undefined) {
            canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
            continue;
          }
          const observed = normalizeSheetCell(sheetRow[columnIndex]);
          const signedSnapshot = snapshotForCell(rowNumber, columnIndex);
          if (signedSnapshot && options.webhookEventId) webhookEventId = options.webhookEventId;

          if (column.kind === 'identity' || (!state.friend && column.kind !== 'answer')) {
            canonical[column.key] = canonicalValue(expected);
            if (observed !== expected) {
              if (!isNotifiedCell(rowNumber, columnIndex)) {
                canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
                continue;
              }
              const baseline = ledger
                ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
                : observed;
              const harnessChanged = expected !== baseline;
              const sheetChanged = ledger ? observed !== baseline : false;
              sheetUpdates.push({
                range: cellRange(resultsSheetName, rowNumber, columnIndex),
                values: [[expected]],
              });
              if (signedSnapshot && options.webhookEventId) {
                ignoredIdentityEdits += 1;
                addWarning(`保護列「${column.header}」の変更を取り込みませんでした`);
                direction = 'from_sheets';
                auditOutcome = 'skipped';
                auditErrorCode = 'identity_read_only';
                details.push(detail(
                  actor,
                  column.header,
                  signedSnapshot.oldValueKnown ? signedSnapshot.oldValue : expected,
                  observed,
                  options.source,
                  'identity_ignored',
                ));
              } else if (!ledger || (harnessChanged && !sheetChanged)) {
                details.push(detail(actor, column.header, observed, expected, options.source, 'identity_sync'));
              } else {
                ignoredIdentityEdits += 1;
                addWarning(`保護列「${column.header}」の変更を取り込みませんでした`);
                details.push(detail(
                  actor,
                  column.header,
                  signedSnapshot?.oldValueKnown ? signedSnapshot.oldValue : expected,
                  observed,
                  options.source,
                  'identity_ignored',
                ));
              }
            } else if (signedSnapshot && options.webhookEventId) {
              ignoredIdentityEdits += 1;
              addWarning(`保護列「${column.header}」の変更を取り込みませんでした`);
              direction = 'from_sheets';
              auditOutcome = 'skipped';
              auditErrorCode = 'identity_read_only';
              details.push(detail(
                actor,
                column.header,
                signedSnapshot.oldValueKnown ? signedSnapshot.oldValue : null,
                signedSnapshot.value,
                options.source,
                'identity_ignored',
              ));
            }
            continue;
          }

          if (column.kind === 'answer') {
            const field = answerFieldByKey.get(column.key);
            if (!field) {
              canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
              continue;
            }
            answerCells[field.fieldId] = { columnKey: column.key, columnIndex, observed, field };
            const baseline = ledger
              ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
              : expected;
            if (!isNotifiedCell(rowNumber, columnIndex)) {
              canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
              continue;
            }
            if (!state.answers.valid) {
              canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(observed);
              if (signedSnapshot && options.webhookEventId) {
                direction = 'from_sheets';
                auditOutcome = 'skipped';
                auditErrorCode = 'invalid_internal_answer_payload';
                details.push(answerDetail(actor, column.header, options.source, 'conflict'));
              }
              continue;
            }
            if (
              signedSnapshot?.oldValueKnown
              && ledger
              && signedSnapshot.oldValue !== baseline
              && signedSnapshot.liveValue !== signedSnapshot.value
            ) {
              canonical[column.key] = ledger.canonicalSnapshot[column.key] ?? canonicalValue(expected);
              direction = 'from_sheets';
              conflictResolution = 'sheet_wins';
              auditOutcome = 'skipped';
              auditErrorCode = 'stale_webhook_event';
              addWarning(`保護のため、古い編集通知（「${column.header}」）をスキップしました`);
              details.push(answerDetail(actor, column.header, options.source, 'conflict'));
              continue;
            }
            if (expected === observed) {
              canonical[column.key] = canonicalValue(expected);
              if (signedSnapshot?.oldValueKnown && signedSnapshot.oldValue !== observed) {
                direction = 'from_sheets';
                details.push(answerDetail(actor, column.header, options.source, 'custom_field'));
              }
              continue;
            }

            const harnessChanged = expected !== baseline;
            const sheetChanged = observed !== baseline;
            const bothChanged = harnessChanged && sheetChanged && expected !== observed;
            let importSheet = false;
            let pushHarness = false;
            if (!ledger) {
              importSheet = options.connection.syncDirection === 'from_sheets';
              pushHarness = options.connection.syncDirection !== 'from_sheets';
            } else if (bothChanged) {
              importSheet = options.connection.syncDirection !== 'to_sheets';
              pushHarness = !importSheet;
              conflictResolution = importSheet ? 'sheet_wins' : 'harness_wins';
            } else if (sheetChanged) {
              importSheet = options.connection.syncDirection !== 'to_sheets';
              pushHarness = !importSheet;
            } else if (harnessChanged) {
              pushHarness = options.connection.syncDirection !== 'from_sheets';
              importSheet = !pushHarness;
            }

            if (importSheet) {
              const parsed = parseFormAnswerSheetValue(
                field,
                observed,
                state.answers.answers[field.fieldId],
              );
              if (!parsed.ok) {
                const message = parsed.reason === 'read_only'
                  ? `回答列「${column.header}」はシートから変更できないため元に戻しました`
                  : `回答列「${column.header}」の入力形式が正しくないため元に戻しました`;
                addWarning(message);
                canonical[column.key] = canonicalValue(expected);
                sheetUpdates.push({
                  range: cellRange(resultsSheetName, rowNumber, columnIndex),
                  values: [[expected]],
                });
                details.push(answerDetail(actor, column.header, options.source, 'conflict'));
                direction = 'to_sheets';
                conflictResolution = 'harness_wins';
              } else {
                answerImports[field.fieldId] = parsed.value;
                importedFields += 1;
                direction = 'from_sheets';
                canonical[column.key] = canonicalValue(observed);
                details.push(answerDetail(
                  actor,
                  column.header,
                  options.source,
                  bothChanged ? 'conflict' : 'custom_field',
                ));
              }
            } else {
              canonical[column.key] = canonicalValue(expected);
              if (pushHarness) {
                sheetUpdates.push({
                  range: cellRange(resultsSheetName, rowNumber, columnIndex),
                  values: [[expected]],
                });
                details.push(answerDetail(
                  actor,
                  column.header,
                  options.source,
                  bothChanged ? 'conflict' : 'custom_field',
                ));
              }
            }
            continue;
          }

          // custom (friend field) column — imports flow into friends.metadata.
          customCells[column.header] = { columnKey: column.key, columnIndex, observed };
          const baseline = ledger
            ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
            : expected;
          if (!isNotifiedCell(rowNumber, columnIndex)) {
            canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
            continue;
          }
          if (
            signedSnapshot?.oldValueKnown
            && ledger
            && signedSnapshot.oldValue !== baseline
            && signedSnapshot.liveValue !== signedSnapshot.value
          ) {
            canonical[column.key] = ledger.canonicalSnapshot[column.key] ?? canonicalValue(expected);
            direction = 'from_sheets';
            conflictResolution = 'sheet_wins';
            auditOutcome = 'skipped';
            auditErrorCode = 'stale_webhook_event';
            addWarning(`保護のため、古い編集通知（「${column.header}」）をスキップしました`);
            details.push(detail(
              actor,
              column.header,
              signedSnapshot.oldValue,
              signedSnapshot.value,
              options.source,
              'conflict',
            ));
            continue;
          }
          if (expected === observed) {
            canonical[column.key] = canonicalValue(expected);
            if (signedSnapshot?.oldValueKnown && signedSnapshot.oldValue !== observed) {
              direction = 'from_sheets';
              details.push(detail(
                actor,
                column.header,
                signedSnapshot.oldValue,
                observed,
                options.source,
                'custom_field',
              ));
            }
            continue;
          }
          const harnessChanged = expected !== baseline;
          const sheetChanged = observed !== baseline;
          const bothChanged = harnessChanged && sheetChanged && expected !== observed;
          let importSheet = false;
          let pushHarness = false;
          if (!ledger) {
            importSheet = options.connection.syncDirection === 'from_sheets' && observed !== expected;
            pushHarness = options.connection.syncDirection !== 'from_sheets' && observed !== expected;
          } else if (bothChanged) {
            importSheet = options.connection.syncDirection !== 'to_sheets';
            pushHarness = !importSheet;
            conflictResolution = importSheet ? 'sheet_wins' : 'harness_wins';
          } else if (sheetChanged) {
            importSheet = options.connection.syncDirection !== 'to_sheets';
            pushHarness = !importSheet && observed !== expected;
          } else if (harnessChanged) {
            pushHarness = options.connection.syncDirection !== 'from_sheets';
            importSheet = !pushHarness && observed !== expected;
          }
          if (importSheet) {
            imports[column.header] = observed;
            importedFields += 1;
            direction = 'from_sheets';
            canonical[column.key] = canonicalValue(observed);
            details.push(detail(
              actor,
              column.header,
              signedSnapshot?.oldValueKnown ? signedSnapshot.oldValue : expected,
              observed,
              options.source,
              bothChanged ? 'conflict' : 'custom_field',
            ));
          } else {
            canonical[column.key] = canonicalValue(expected);
            if (pushHarness) {
              sheetUpdates.push({
                range: cellRange(resultsSheetName, rowNumber, columnIndex),
                values: [[expected]],
              });
              details.push(detail(
                actor, column.header, observed, expected, options.source,
                bothChanged ? 'conflict' : 'custom_field',
              ));
            }
          }
        }
        plans.push({
          row: state, rowNumber, ledger, canonical, details, imports, customCells,
          answerCells, answerImports, sheetUpdates,
          direction, conflictResolution, isAppend: false, webhookEventId, auditOutcome, auditErrorCode,
        });
      }
      if (pendingChunkAppends.length > 0) {
        await renewLease();
        const appended = await client.appendValues(
          options.connection.spreadsheetId,
          `${quoteSheetName(resultsSheetName)}!A:${columnLabel(Math.max(0, headers.length - 1))}`,
          pendingChunkAppends.map((entry) => entry.row),
        );
        const firstAppendedRow = appendedStartRow(appended, values.length + appendedRows + 1);
        pendingChunkAppends.forEach((entry, index) => {
          entry.plan.rowNumber = firstAppendedRow + index;
        });
        appendedRows += pendingChunkAppends.length;
      }
    }

    const allSheetUpdates = plans.flatMap((plan) => plan.sheetUpdates);
    if (allSheetUpdates.length > 0) {
      await renewLease();
      await client.batchUpdateValues(options.connection.spreadsheetId, allSheetUpdates);
    }
    const updatedRowNumbers = new Set(
      plans.filter((plan) => plan.sheetUpdates.length > 0).map((plan) => plan.rowNumber),
    );
    const completedAt = toJstString(nowFactory());
    const movedPlans = plans.filter(
      (plan) => plan.ledger
        && plan.ledger.sheetRowNumber !== plan.rowNumber
        && !preclearedRowKeys.has(formResultsRecordKey(plan.row.submission.id)),
    );
    if (movedPlans.length > 0) {
      const lease = await renewLease();
      const cleared = await clearSheetsSyncLedgerRowNumbers(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        movedPlans.map((plan) => formResultsRecordKey(plan.row.submission.id)),
        lease,
      );
      if (!cleared) throw new Error('form_results_sync_lock_lost');
      for (const plan of movedPlans) {
        if (plan.ledger) plan.ledger = { ...plan.ledger, sheetRowNumber: null };
      }
    }
    for (const plan of plans) {
      // Personal-block imports reuse the exact ledger metadata CAS.
      const rejectedUpdates: SheetsDataUpdate[] = [];
      if (plan.row.friend) {
        const imported = await saveImportedMetadata(
          options.db,
          options.connection,
          plan.row.friend,
          plan.imports,
          () => toJstString(nowFactory()),
          renewLease,
        );
        plan.row.friend = imported.friend;
        friendById.set(imported.friend.id, imported.friend);
        for (const [header, latestValue] of Object.entries(imported.rejected)) {
          const cell = plan.customCells[header];
          if (!cell) continue;
          importedFields -= 1;
          delete plan.imports[header];
          plan.canonical[cell.columnKey] = canonicalValue(latestValue);
          plan.details = plan.details.filter((entry) => entry.fieldName !== header);
          if (latestValue === cell.observed) continue;
          plan.details.push(detail(
            actor,
            header,
            cell.observed,
            latestValue,
            options.source,
            'conflict',
          ));
          rejectedUpdates.push({
            range: cellRange(resultsSheetName, plan.rowNumber, cell.columnIndex),
            values: [[latestValue]],
          });
          plan.direction = 'to_sheets';
          plan.conflictResolution = 'harness_wins';
        }
      }

      const answerImportIds = Object.keys(plan.answerImports);
      if (answerImportIds.length > 0) {
        let answerUpdated = false;
        if (plan.row.answers.valid) {
          const nextAnswers = { ...plan.row.answers.answers, ...plan.answerImports };
          const nextAnswersJson = JSON.stringify(nextAnswers);
          const lease = await renewLease();
          answerUpdated = await updateInternalFormSubmissionAnswersForSheetsBySubmissionId(options.db, {
            lineAccountId: options.connection.lineAccountId,
            connectionId: options.connection.id,
            connectionVersion: options.connection.configVersion,
            formId: options.connection.formId,
            submissionId: plan.row.submission.id,
            expectedAnswersJson: plan.row.submission.answers_json,
            answers: nextAnswers,
            lease,
          });
          if (answerUpdated) {
            plan.row.submission = { ...plan.row.submission, answers_json: nextAnswersJson };
            plan.row.answers = { ...plan.row.answers, answers: nextAnswers };
          }
        }
        if (!answerUpdated) {
          await renewLease();
          const latest = await getInternalFormSubmission(
            options.db,
            options.connection.formId,
            plan.row.submission.id,
          );
          await renewLease();
          importedFields -= answerImportIds.length;
          plan.answerImports = {};
          const rejectedHeaders = new Set(answerImportIds.flatMap((fieldId) => {
            const cell = plan.answerCells[fieldId];
            return cell ? [cell.field.header] : [];
          }));
          plan.details = plan.details.filter((entry) => !rejectedHeaders.has(entry.fieldName));
          if (latest) {
            plan.row.submission = latest;
            plan.row.answers = parseInternalAnswers(latest);
          }
          const authoritative = latest
            ? projectionForRow(plan.row)
            : Object.fromEntries(answerImportIds.flatMap((fieldId) => {
              const cell = plan.answerCells[fieldId];
              return cell ? [[cell.columnKey, '']] : [];
            }));
          for (const fieldId of answerImportIds) {
            const cell = plan.answerCells[fieldId];
            if (!cell) continue;
            const latestValue = authoritative[cell.columnKey] ?? '';
            plan.canonical[cell.columnKey] = canonicalValue(latestValue);
            if (latestValue !== cell.observed) {
              rejectedUpdates.push({
                range: cellRange(resultsSheetName, plan.rowNumber, cell.columnIndex),
                values: [[latestValue]],
              });
            }
          }
          for (const header of rejectedHeaders) {
            plan.details.push(answerDetail(actor, header, options.source, 'conflict'));
          }
          plan.direction = 'to_sheets';
          plan.conflictResolution = 'harness_wins';
          addWarning('回答の同時更新を検知したため、シートには最新回答を戻しました');
        }
      }
      if (rejectedUpdates.length > 0) {
        await renewLease();
        await client.batchUpdateValues(options.connection.spreadsheetId, rejectedUpdates);
        updatedRowNumbers.add(plan.rowNumber);
      }
      await persistResultsPlan(options.db, options.connection, plan, completedAt, renewLease);
    }

    const status = chunkMetadata?.hasMore
      ? 'running'
      : warnings.length > 0 ? 'warning' : 'success';
    const warning = warnings.length > 0 ? warnings.join(' / ') : null;
    const finalLease = await renewLease();
    const statusUpdated = await updateSheetsSyncStatus(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      {
        status,
        lastSyncAt: status === 'running' ? options.connection.lastSyncAt : completedAt,
        warning,
        errorCode: warnings.length > 0 ? 'form_results_warning' : null,
      },
      finalLease,
    );
    if (!statusUpdated) throw new Error('form_results_sync_lock_lost');
    return {
      status,
      busy: false,
      warning,
      warnings,
      appendedRows,
      updatedRows: updatedRowNumbers.size + deletedRows,
      importedFields,
      ignoredIdentityEdits,
      ...(chunkMetadata ? { chunk: chunkMetadata } : {}),
    };
  } catch (error) {
    failure = error;
    const failedAt = toJstString(nowFactory());
    await updateSheetsSyncStatus(options.db, options.connection.lineAccountId, options.connection.id, {
      status: 'error',
      lastSyncAt: failedAt,
      warning: null,
      errorCode: 'form_results_sync_failed',
    }, { token: lockToken, now: failedAt }).catch(() => null);
    throw error;
  } finally {
    const released = await releaseSheetsSyncLock(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      lockToken,
    ).catch(() => false);
    if (!released && !failure) throw new Error('form_results_lock_release_failed');
  }
}

export interface DrainFormResultsWebhookEventsOptions {
  db: D1Database;
  connection: SheetsConnection;
  client?: FormResultsSheetsClient;
  credentialsJson?: string;
  maxEvents: number;
  now?: () => Date;
}

export interface FormResultsWebhookDrainResult {
  attempted: number;
  applied: number;
  deferred: number;
  dead: number;
  exhausted: boolean;
  warnings: string[];
}

export async function drainFormResultsWebhookEvents(
  options: DrainFormResultsWebhookEventsOptions,
): Promise<FormResultsWebhookDrainResult> {
  const nowFactory = options.now ?? (() => new Date());
  const limit = Math.max(1, Math.min(MAX_WEBHOOK_EVENTS_PER_DRAIN, Math.trunc(options.maxEvents)));
  const result: FormResultsWebhookDrainResult = {
    attempted: 0,
    applied: 0,
    deferred: 0,
    dead: 0,
    exhausted: false,
    warnings: [],
  };
  for (let index = 0; index < limit; index += 1) {
    const claimTime = nowFactory();
    const claimToken = `gswe_${crypto.randomUUID()}`;
    const event = await claimNextSheetsWebhookEvent(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      options.connection.configVersion,
      {
        token: claimToken,
        now: toJstString(claimTime),
        expiresAt: toJstString(new Date(claimTime.getTime() + WEBHOOK_EVENT_CLAIM_MS)),
        discardBefore: toJstString(new Date(claimTime.getTime() - WEBHOOK_EVENT_RETENTION_MS)),
        maxAttempts: MAX_WEBHOOK_EVENT_ATTEMPTS,
        target: 'form_results',
      },
    );
    if (!event) break;
    result.attempted += 1;
    const alreadyApplied = await hasSheetsSyncAuditForWebhookEvent(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      options.connection.configVersion,
      event.eventId,
    );
    if (alreadyApplied) {
      const finished = await finishSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          status: 'applied',
          completedAt: toJstString(nowFactory()),
          errorCode: null,
        },
      );
      if (finished) result.applied += 1;
      continue;
    }
    const payload = parseFriendLedgerWebhookEventPayload(event.payload);
    if (!payload) {
      const finished = await finishSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          status: 'dead',
          completedAt: toJstString(nowFactory()),
          errorCode: 'invalid_webhook_event_payload',
        },
      );
      if (finished) result.dead += 1;
      continue;
    }
    try {
      const synced = await syncFormResults({
        db: options.db,
        connection: options.connection,
        client: options.client,
        credentialsJson: options.credentialsJson,
        source: 'webhook',
        actor: event.actorKind === 'google_email' ? event.actor : 'google_sheets_editor_unavailable',
        range: payload.range,
        snapshot: payload.snapshot,
        webhookEventId: event.eventId,
        webhookOccurredAt: event.occurredAt,
        webhookTargetError: (
          Number.isFinite(parseFriendLedgerTimestamp(event.occurredAt))
          && Number.isFinite(parseFriendLedgerTimestamp(options.connection.updatedAt))
          && parseFriendLedgerTimestamp(event.occurredAt)
            < parseFriendLedgerTimestamp(options.connection.updatedAt)
        ) ? 'stale_webhook_generation' : undefined,
        now: nowFactory,
      });
      for (const warning of synced.warnings) {
        if (!result.warnings.includes(warning)) result.warnings.push(warning);
      }
      if (synced.busy) {
        const retryAt = new Date(nowFactory().getTime() + WEBHOOK_EVENT_RETRY_MS);
        const deferred = await deferSheetsWebhookEvent(
          options.db,
          options.connection.lineAccountId,
          options.connection.id,
          options.connection.configVersion,
          event.eventId,
          {
            processingToken: claimToken,
            availableAt: toJstString(retryAt),
            errorCode: 'form_results_sync_busy',
          },
        );
        if (deferred) result.deferred += 1;
        break;
      }
      const finished = await finishSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          status: 'applied',
          completedAt: toJstString(nowFactory()),
          errorCode: null,
        },
      );
      if (!finished) throw new Error('webhook_event_claim_lost');
      result.applied += 1;
    } catch {
      const failureTime = nowFactory();
      const status = await failSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          availableAt: toJstString(new Date(failureTime.getTime() + WEBHOOK_EVENT_RETRY_MS)),
          completedAt: toJstString(failureTime),
          errorCode: 'form_results_webhook_sync_failed',
          maxAttempts: MAX_WEBHOOK_EVENT_ATTEMPTS,
        },
      );
      if (status === 'dead') result.dead += 1;
      else result.deferred += 1;
      break;
    }
  }
  result.exhausted = result.attempted >= limit;
  return result;
}
