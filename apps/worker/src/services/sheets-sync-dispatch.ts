import { BUNDLE_VERSION } from '../_version.js';
import { dispatchInternalWork, verifyInternalWork } from './internal-work-dispatch.js';

export const SHEETS_SYNC_WORK_PATH = '/internal/sheets-sync-work';
const SHEETS_SYNC_SIGNATURE_PREFIX = 'line-harness:sheets-sync-work:v1';
const SHEETS_SYNC_HEADER_PREFIX = 'x-sheets-sync';

const protocol = {
  path: SHEETS_SYNC_WORK_PATH,
  signaturePrefix: SHEETS_SYNC_SIGNATURE_PREFIX,
  headerPrefix: SHEETS_SYNC_HEADER_PREFIX,
  label: 'sheets sync',
};

export async function dispatchSheetsSyncWork(env: {
  WORKER_PUBLIC_URL?: string;
  LINE_CHANNEL_SECRET: string;
  SELF?: Fetcher;
}): Promise<void> {
  return dispatchInternalWork({
    ...protocol,
    publicUrl: env.WORKER_PUBLIC_URL,
    secret: env.LINE_CHANNEL_SECRET,
    self: env.SELF,
    userAgent: `line-harness-worker/${BUNDLE_VERSION}`,
  });
}

export async function verifySheetsSyncWork(request: Request, secret: string): Promise<boolean> {
  return verifyInternalWork(request, secret, protocol);
}
