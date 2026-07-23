import { expectTypeOf } from 'vitest'
import type {
  ExternalEditChange,
  RowDetail,
  RowEditResult,
  SubmissionRow,
} from './formaloo-advanced-api'

type ExternalEditSource = 'edit_link' | 'sheet' | null | undefined
type ExternalEditTimestamp = string | null | undefined
type ExternalEditChanges = ExternalEditChange[] | undefined

expectTypeOf<SubmissionRow['externalEditSource']>().toEqualTypeOf<ExternalEditSource>()
expectTypeOf<SubmissionRow['externalEditedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<SubmissionRow['externalEditApprovedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<SubmissionRow['externalEditChanges']>().toEqualTypeOf<ExternalEditChanges>()
expectTypeOf<RowDetail['externalEditSource']>().toEqualTypeOf<ExternalEditSource>()
expectTypeOf<RowDetail['externalEditedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowDetail['externalEditApprovedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowDetail['externalEditChanges']>().toEqualTypeOf<ExternalEditChanges>()
expectTypeOf<RowEditResult['externalEditSource']>().toEqualTypeOf<ExternalEditSource>()
expectTypeOf<RowEditResult['externalEditedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowEditResult['externalEditApprovedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowEditResult['externalEditChanges']>().toEqualTypeOf<ExternalEditChanges>()
