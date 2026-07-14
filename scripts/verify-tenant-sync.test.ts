/**
 * P1-3 — verify-tenant-sync.sh の機械検証。
 *   dual-remote (origin=ksplanning / mirror=sukedachi) の同一 branch HEAD SHA 一致検知。
 *   実 git fixture (2 bare repo + working repo) を組み、`git ls-remote` を実際に叩いて:
 *     ① 両 remote 同一 SHA        → exit 0
 *     ② 片側だけ push (drift)     → exit ≠ 0 (片側 push 漏れ検知)
 *     ③ mirror remote 未登録      → drift とは別の非ゼロ exit (P1-2 未配線を honest に区別)
 *   を確認する。§10 H-5 (dual-push 非原子性) の同期チェックの土台。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'verify-tenant-sync.sh');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** スクリプトを REPO_DIR=work で実行し {code, out} を返す (非ゼロ exit を throw させない)。 */
function runSync(work: string, env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, REPO_DIR: work, ORIGIN_REMOTE: 'origin', MIRROR_REMOTE: 'sukedachi', BRANCH: 'main', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.toString();
    return { code: err.status ?? -1, out };
  }
}

describe('verify-tenant-sync.sh (P1-3)', () => {
  let root: string;
  let origin: string;
  let mirror: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tenant-sync-'));
    origin = join(root, 'origin.git');
    mirror = join(root, 'mirror.git');
    work = join(root, 'work');
    // 2 本の bare remote
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '--bare', '-b', 'main', mirror]);
    // working repo + 2 remote 登録
    execFileSync('git', ['init', '-b', 'main', work]);
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'test');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'remote', 'add', 'sukedachi', mirror);
    execFileSync('git', ['-C', work, 'commit', '--allow-empty', '-m', 'c1']);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('① 両 remote 同一 SHA → exit 0', () => {
    git(work, 'push', 'origin', 'main');
    git(work, 'push', 'sukedachi', 'main');
    const r = runSync(work);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK|sync/i);
  });

  it('② 片側 (origin) だけ push で drift → exit ≠ 0', () => {
    execFileSync('git', ['-C', work, 'commit', '--allow-empty', '-m', 'c2']);
    git(work, 'push', 'origin', 'main'); // sukedachi へは push しない (片側 push 漏れ)
    const r = runSync(work);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/DRIFT|drift|漏れ/i);
  });

  it('②b 追随 push で再び一致 → exit 0', () => {
    git(work, 'push', 'sukedachi', 'main');
    const r = runSync(work);
    expect(r.code).toBe(0);
  });

  it('③ mirror remote 未登録は drift とは別の非ゼロ exit (P1-2 未配線を区別)', () => {
    const r = runSync(work, { MIRROR_REMOTE: 'not-configured-remote' });
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(1); // drift(1) とは別コード
    expect(r.out).toMatch(/未登録|not.*registered|remote/i);
  });
});
