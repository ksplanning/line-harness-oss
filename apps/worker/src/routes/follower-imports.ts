import { Hono } from 'hono';
import { getLineAccountById } from '@line-crm/db';
import type { Env } from '../index.js';
import {
  ACCOUNT_NOT_VERIFIED_MESSAGE,
  FollowerImportAccountNotVerifiedError,
  FollowerImportConflictError,
  FollowerImportLineApiError,
  advanceFollowerImport,
  getLatestFollowerImportJob,
  startFollowerImport,
} from '../services/follower-import.js';

const followerImports = new Hono<Env>();

function accountIdFromQuery(c: { req: { query(name: string): string | undefined } }): string | null {
  const accountId = c.req.query('accountId');
  return accountId && accountId.length > 0 ? accountId : null;
}

followerImports.get('/api/friends/follower-imports/latest', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  if (!await getLineAccountById(c.env.DB, accountId)) {
    return c.json({ success: false, error: 'account not found' }, 404);
  }
  const job = await getLatestFollowerImportJob(c.env.DB, accountId);
  return c.json({ success: true, data: job });
});

followerImports.post('/api/friends/follower-imports', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  if (account.is_active !== 1) return c.json({ success: false, error: 'account is inactive' }, 409);
  const staff = c.get('staff') ?? { id: 'unknown', name: 'Unknown' };
  try {
    const job = await startFollowerImport(c.env.DB, {
      id: account.id,
      channelAccessToken: account.channel_access_token,
      isActive: true,
    }, { id: staff.id, name: staff.name });
    return c.json({ success: true, data: job }, 202);
  } catch (error) {
    if (error instanceof FollowerImportConflictError) {
      return c.json({
        success: false,
        error: '既存友だちの取り込みはすでに進行中です。',
        data: error.job,
      }, 409);
    }
    if (error instanceof FollowerImportAccountNotVerifiedError) {
      return c.json({
        success: false,
        error: ACCOUNT_NOT_VERIFIED_MESSAGE,
        errorCode: 'account_not_verified',
        data: error.job,
      }, error.status);
    }
    if (error instanceof FollowerImportLineApiError) {
      return c.json({
        success: false,
        error: error.message,
        errorCode: 'line_api_error',
        data: error.job,
      }, 502);
    }
    throw error;
  }
});

followerImports.post('/api/friends/follower-imports/:id/advance', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  try {
    const job = await advanceFollowerImport(c.env.DB, c.req.param('id'), accountId);
    return c.json({ success: true, data: job });
  } catch (error) {
    if (error instanceof FollowerImportAccountNotVerifiedError) {
      return c.json({
        success: false,
        error: ACCOUNT_NOT_VERIFIED_MESSAGE,
        errorCode: 'account_not_verified',
        data: error.job,
      }, error.status);
    }
    if (error instanceof FollowerImportLineApiError) {
      return c.json({
        success: false,
        error: error.message,
        errorCode: 'line_api_error',
        data: error.job,
      }, 502);
    }
    if (error instanceof Error && error.message === 'follower import job not found') {
      return c.json({ success: false, error: 'import job not found' }, 404);
    }
    throw error;
  }
});

export { followerImports };
