import { expectTypeOf } from 'vitest'
import type {
  RowDetail,
  RowEditResult,
  SubmissionRow,
} from './formaloo-advanced-api'

type ExternalEditSource = 'edit_link' | 'sheet' | null | undefined
type ExternalEditTimestamp = string | null | undefined

expectTypeOf<SubmissionRow['externalEditSource']>().toEqualTypeOf<ExternalEditSource>()
expectTypeOf<SubmissionRow['externalEditedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<SubmissionRow['externalEditApprovedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowDetail['externalEditSource']>().toEqualTypeOf<ExternalEditSource>()
expectTypeOf<RowDetail['externalEditedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowDetail['externalEditApprovedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowEditResult['externalEditSource']>().toEqualTypeOf<ExternalEditSource>()
expectTypeOf<RowEditResult['externalEditedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
expectTypeOf<RowEditResult['externalEditApprovedAt']>().toEqualTypeOf<ExternalEditTimestamp>()
