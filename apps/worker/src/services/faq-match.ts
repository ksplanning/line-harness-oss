import type { Faq } from '@line-crm/db';

export type MatchableFaq = Omit<Faq, 'variants'> & { variants: string[] | string };

export function normalize(text: string): string {
  const nkfc = text.normalize('NFKC');
  let hiragana = '';
  for (const char of nkfc) {
    const code = char.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) {
      hiragana += String.fromCharCode(code - 0x60);
    } else {
      hiragana += char;
    }
  }
  return hiragana
    .toLowerCase()
    .replace(/[\s！？!?、。,.　・「」（）()[\]{}【】『』"'`~〜:：;；/\\|]/g, '');
}

export function ngrams(s: string, n: number): Set<string> {
  if (!s) return new Set();
  if (s.length < n) return new Set([s]);
  const result = new Set<string>();
  for (let i = 0; i <= s.length - n; i += 1) {
    result.add(s.slice(i, i + n));
  }
  return result;
}

export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
}

function parseVariants(variants: string[] | string): string[] {
  if (Array.isArray(variants)) return variants;
  try {
    const parsed = JSON.parse(variants) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function scoreFaq(query: string, faq: { question: string; variants: string[] | string }): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const queryBi = ngrams(normalizedQuery, 2);
  const queryTri = ngrams(normalizedQuery, 3);
  const candidates = [faq.question, ...parseVariants(faq.variants)];
  let best = 0;

  for (const candidate of candidates) {
    const normalizedCandidate = normalize(candidate);
    if (!normalizedCandidate) continue;
    const bi = dice(queryBi, ngrams(normalizedCandidate, 2));
    const tri = dice(queryTri, ngrams(normalizedCandidate, 3));
    best = Math.max(best, (bi + tri) / 2);
  }

  return best;
}

export interface FaqMatch {
  faq: MatchableFaq;
  score: number;
}

export interface FaqMatchDetail {
  match: FaqMatch | null;
  best: FaqMatch | null;
  topScore: number | null;
}

export function matchFaqDetailed(query: string, faqs: MatchableFaq[], threshold: number): FaqMatchDetail {
  if (!normalize(query) || faqs.length === 0) {
    return { match: null, best: null, topScore: null };
  }

  let best: FaqMatch | null = null;
  for (const faq of faqs) {
    if (faq.is_active !== 1) continue;
    const score = scoreFaq(query, faq);
    if (!best || score > best.score) {
      best = { faq, score };
    }
  }

  if (!best) return { match: null, best: null, topScore: null };
  return {
    match: best.score >= threshold ? best : null,
    best,
    topScore: best.score,
  };
}

export function matchFaq(query: string, faqs: MatchableFaq[], threshold: number): FaqMatch | null {
  return matchFaqDetailed(query, faqs, threshold).match;
}
