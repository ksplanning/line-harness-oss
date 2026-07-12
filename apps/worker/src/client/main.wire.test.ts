import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// =============================================================================
// CX-1 wire 回帰ガード — client/main.ts が復路 lu 付与を「configured WORKER origin」に
//   アンカーして呼ぶことを固定する。main.ts は top-level で liff.init() 等の副作用を持つ
//   スクリプトゆえ import 実行できない → ソースを text として読み、wire の存在を静的に検証する
//   (faq-ai-invariants.test.ts と同源の invariant テスト idiom)。
//
// なぜ WORKER origin か: /fo/:id 追跡経路は常に WORKER origin (${WORKER_URL}/fo/:id) に在る。
//   client は cross-origin (…-liff.pages.dev) で配信され得るため、selfOrigin に
//   window.location.origin(=pages.dev) を渡すと legit な worker URL を弾いて F-1 復路ループを
//   再発させる。逆に WORKER canonical origin をアンカーにすれば legit 復路は通し、攻撃者の
//   ?redirect=https://evil.com/fo/x は origin 不一致で lu を付けない(= LINE userId 非漏出)。
// =============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(__dirname, 'main.ts'), 'utf8');

describe('client/main.ts — CX-1 worker-origin wire (regression guard)', () => {
  test('WORKER_ORIGIN を VITE_WORKER_ORIGIN build env から解決する', () => {
    // build-time inject: window.location.origin ではなく configured worker origin をアンカーにする。
    expect(mainSrc).toMatch(/const\s+WORKER_ORIGIN\s*=\s*import\.meta\.env\??\.VITE_WORKER_ORIGIN/);
  });

  test('appendLineUserToReturnUrl を WORKER_ORIGIN を same-origin アンカーとして呼ぶ (cross-origin lu-leak を close)', () => {
    expect(mainSrc).toMatch(
      /appendLineUserToReturnUrl\(\s*redirectUrl\s*,\s*profile\.userId\s*,\s*WORKER_ORIGIN\s*\)/,
    );
  });

  test('復路 lu 付与を素の 2 引数呼び出し (selfOrigin 無し) で行わない', () => {
    // `appendLineUserToReturnUrl(redirectUrl, profile.userId)` (2 引数終端) は cross-origin 漏出が
    // 開いたままになる旧形。3 引数呼び出しに固定して回帰を防ぐ。
    expect(mainSrc).not.toMatch(/appendLineUserToReturnUrl\(\s*redirectUrl\s*,\s*profile\.userId\s*\)/);
  });
});
