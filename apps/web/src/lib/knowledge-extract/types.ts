/**
 * Phase B B-4 (T-D1) — 取込ファイル抽出の共通型 + 拒否理由 (日本語メッセージ)。
 * owner (非エンジニア) に理由が伝わる日本語エラーで [制約] (スキャン PDF/パスワード付き/.doc/未対応) を拒否する。
 */

export type FileFormat = 'pdf' | 'docx' | 'doc' | 'unknown';

export type ExtractErrorReason =
  | 'unsupported_doc' // .doc 旧 OLE 形式 (範囲外)
  | 'unsupported_format' // 未対応の形式
  | 'password_protected' // パスワード付き PDF (範囲外)
  | 'scanned_no_text' // テキスト層なし PDF (スキャン画像・OCR は範囲外)
  | 'empty' // 抽出結果が空
  | 'extract_failed'; // 破損等でパーサが失敗

/** owner 向け日本語エラー文言 (理由が伝わるように具体的に)。 */
export const EXTRACT_ERROR_MESSAGES: Record<ExtractErrorReason, string> = {
  unsupported_doc: '古い Word 形式 (.doc) には対応していません。.docx で保存し直してから取り込んでください。',
  unsupported_format: 'この形式のファイルには対応していません。PDF または Word (.docx) を取り込んでください。',
  password_protected: 'パスワード付きの PDF は取り込めません。パスワードを外してから取り込んでください。',
  scanned_no_text:
    'この PDF には文字データが見つかりませんでした (スキャン画像の可能性があります)。文字を含む PDF を取り込んでください。',
  empty: 'ファイルから取り込める文章が見つかりませんでした。',
  extract_failed: 'ファイルの読み取りに失敗しました。ファイルが壊れていないか確認してください。',
};

/** 抽出の [制約] 拒否。reason で分岐でき、message は owner 向け日本語。 */
export class KnowledgeExtractError extends Error {
  constructor(
    public readonly reason: ExtractErrorReason,
    message: string = EXTRACT_ERROR_MESSAGES[reason],
  ) {
    super(message);
    this.name = 'KnowledgeExtractError';
  }
}
