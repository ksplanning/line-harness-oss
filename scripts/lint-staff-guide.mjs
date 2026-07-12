#!/usr/bin/env node
/**
 * line-staff-docs-chat T-C1 — スタッフ資料の「非エンジニア語」lint。
 *
 * docs/staff-guide/*.md に、素人スタッフに通じない生の技術用語 (禁止語) が混ざっていないか検査する。
 * 禁止語が 1 つでもあれば exit 1 (どのファイルの何行かを出す)。README.md は取込対象外だが同基準で検査する。
 *
 * カタカナ補足つきの平易語 (例: 「配信セット (テンプレパック)」) は OK。生の英字用語や内部語だけを弾く。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve('docs/staff-guide');

// 禁止語 (生の技術用語・内部語)。大文字小文字を無視して単語境界で照合する。
const FORBIDDEN = [
  'API', 'endpoint', 'エンドポイント', 'webhook', 'ウェブフック',
  'RAG', 'embedding', 'embed', 'vectorize', 'cosine',
  'JSON', 'HTTP', 'HTTPS', 'cron', 'クーロン', 'sentinel',
  'corpus', 'migration', 'マイグレーション', 'SQL', 'D1',
  'localhost', 'null', 'undefined', 'commit', 'deploy', 'デプロイ',
];

function scan() {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.md'));
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(join(DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // コード塊 (``` 内) と取込コマンド例の行は除外 (管理者向け・スタッフ chat には効くが lint 対象外)。
      for (const term of FORBIDDEN) {
        const re = new RegExp(`(^|[^A-Za-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i');
        if (re.test(line)) hits.push({ file: f, line: i + 1, term, text: line.trim().slice(0, 80) });
      }
    });
  }
  return hits;
}

// 取込コマンド例 (```...```) の行は管理者向けゆえ許容する: ``` ブロック内を除外して再検査。
function scanExcludingCodeBlocks() {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.md'));
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(join(DIR, f), 'utf8').split('\n');
    let inCode = false;
    lines.forEach((line, i) => {
      if (line.trim().startsWith('```')) { inCode = !inCode; return; }
      if (inCode) return;
      for (const term of FORBIDDEN) {
        const re = new RegExp(`(^|[^A-Za-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i');
        if (re.test(line)) hits.push({ file: f, line: i + 1, term, text: line.trim().slice(0, 80) });
      }
    });
  }
  return hits;
}

const hits = scanExcludingCodeBlocks();
if (hits.length > 0) {
  console.error(`[staff-guide-lint] 禁止語 ${hits.length} 件:`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  「${h.term}」  ${h.text}`);
  process.exit(1);
}
console.log(`[staff-guide-lint] OK — 禁止語 0 件 (${readdirSync(DIR).filter((f) => f.endsWith('.md')).length} files)`);
void scan;
