import { describe, expect, test } from 'vitest';
import {
  getInternalSubmissionNotificationAnswerFields,
  previewInternalSubmissionNotification,
  renderInternalSubmissionNotification,
  validateInternalSubmissionNotificationTemplate,
  type InternalSubmissionNotificationField,
} from './internal-submission-notification';

function field(
  id: string,
  label: string,
  type: InternalSubmissionNotificationField['type'] = 'text',
  config: InternalSubmissionNotificationField['config'] = {},
): InternalSubmissionNotificationField {
  return { id, label, type, config };
}

describe('internal submission notification custom template', () => {
  const fields = [
    field('name', 'お名前'),
    field('interests', '興味', 'multiple_select', { choices: ['新商品', 'セール'] }),
  ];

  test('renders the three supported tokens and leaves unknown tokens literal', () => {
    expect(renderInternalSubmissionNotification({
      template: 'こんにちは {{display_name}}さん\n名前={{回答:お名前}}\n興味={{回答:興味}}\n{{編集リンク}}\n{{unknown}}',
      formTitle: '申込フォーム',
      fields,
      answers: { name: '佐藤', interests: ['新商品', 'セール'] },
      displayName: '佐藤さん',
      editUrl: 'https://example.test/edit/one',
    })).toEqual({
      ok: true,
      text: 'こんにちは 佐藤さんさん\n名前=佐藤\n興味=新商品、セール\nhttps://example.test/edit/one\n{{unknown}}',
    });
  });

  test('does not recursively expand tokens supplied by recipient-controlled values', () => {
    expect(renderInternalSubmissionNotification({
      template: '{{display_name}} / {{回答:お名前}} / {{編集リンク}}',
      formTitle: '申込フォーム',
      fields,
      answers: { name: '{{編集リンク}}' },
      displayName: '{{回答:お名前}}',
      editUrl: 'https://example.test/{{display_name}}',
    })).toEqual({
      ok: true,
      text: '{{回答:お名前}} / {{編集リンク}} / https://example.test/{{display_name}}',
    });
  });

  test('reports an unknown answer label instead of silently binding it to another field', () => {
    expect(validateInternalSubmissionNotificationTemplate('{{回答:存在しない項目}}', fields)).toEqual({
      ok: false,
      error: '回答項目「存在しない項目」が見つかりません',
      issues: [{
        code: 'unknown_answer_label',
        label: '存在しない項目',
        message: '回答項目「存在しない項目」が見つかりません',
      }],
    });
  });

  test('duplicate labels make a referenced answer token invalid and render fails honestly', () => {
    const duplicateFields = [field('first_name', '氏名'), field('legal_name', '氏名')];
    const validation = validateInternalSubmissionNotificationTemplate('氏名={{回答:氏名}}', duplicateFields);

    expect(validation).toEqual({
      ok: false,
      error: '回答項目「氏名」が2件あるため特定できません',
      issues: [{
        code: 'duplicate_answer_label',
        label: '氏名',
        message: '回答項目「氏名」が2件あるため特定できません',
      }],
    });
    expect(renderInternalSubmissionNotification({
      template: '氏名={{回答:氏名}}',
      formTitle: '申込フォーム',
      fields: duplicateFields,
      answers: { first_name: '佐藤', legal_name: '佐藤花子' },
      displayName: null,
      editUrl: 'https://example.test/edit/two',
    })).toEqual({ ok: false, validation });
  });
});

describe('internal submission notification default template', () => {
  test('blank templates list every answer field in definition order and omit decorations', () => {
    const fields = [
      field('second', '2番目'),
      field('section', '見出し', 'section', { text: '説明' }),
      field('first', '1番目'),
      field('page', '改ページ', 'page_break'),
      field('video', '動画', 'video', { videoUrl: 'https://example.test/video' }),
      field('image', '画像', 'image', { imageUrl: 'https://example.test/image.png' }),
    ];

    expect(renderInternalSubmissionNotification({
      template: '  \n ',
      formTitle: 'イベント申込',
      fields,
      answers: { first: '先', second: '後' },
      displayName: '田中',
      editUrl: 'https://example.test/edit/default',
    })).toEqual({
      ok: true,
      text: [
        '田中さん、「イベント申込」へのご回答ありがとうございます。',
        '',
        '回答内容',
        '2番目: 後',
        '1番目: 先',
        '',
        '編集リンク',
        'https://example.test/edit/default',
      ].join('\n'),
    });
  });

  test.each([null, undefined])('uses the default template for %s', (template) => {
    const result = renderInternalSubmissionNotification({
      template,
      formTitle: '申込フォーム',
      fields: [field('name', '氏名')],
      answers: {},
      displayName: null,
      editUrl: 'https://example.test/edit/default',
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.text).toContain('氏名: （未回答）');
  });
});

describe('internal submission answer formatting', () => {
  test('formats scalar, matrix, repeating rows, file metadata and signature readably', () => {
    const fields = [
      field('attending', '参加', 'yes_no'),
      field('matrix', '評価表', 'matrix', {
        matrixChoiceItems: { good: { title: '良い' }, bad: { title: '悪い' } },
        matrixChoiceGroups: [{ title: '接客' }, { title: '価格' }],
      }),
      field('people', '参加者', 'repeating_section', {
        repeatingColumns: [
          { columnField: 'person_name', title: '氏名' },
          { columnField: 'age', title: '年齢' },
        ],
      }),
      field('attachment', '添付', 'file'),
      field('signature', '署名', 'signature'),
    ];
    const template = fields.map((item) => `${item.label}: {{回答:${item.label}}}`).join('\n');

    expect(renderInternalSubmissionNotification({
      template,
      formTitle: '申込フォーム',
      fields,
      answers: {
        attending: true,
        matrix: { 接客: '良い', 価格: '悪い' },
        people: [
          { person_name: '佐藤', age: 20 },
          { person_name: '鈴木', age: 30 },
        ],
        attachment: [
          { key: 'private/key', name: '申込書.pdf', size: 1536, type: 'application/pdf' },
          { key: 'private/key-2', name: '写真.png', size: 2048, type: 'image/png' },
        ],
        signature: 'data:image/png;base64,c2lnbmF0dXJl',
      },
      displayName: null,
      editUrl: 'https://example.test/edit/format',
    })).toEqual({
      ok: true,
      text: [
        '参加: はい',
        '評価表: 接客: 良い\n価格: 悪い',
        '参加者: 1. 氏名: 佐藤 / 年齢: 20\n2. 氏名: 鈴木 / 年齢: 30',
        '添付: 申込書.pdf (1.5 KB, application/pdf)\n写真.png (2 KB, image/png)',
        '署名: 署名済み',
      ].join('\n'),
    });
  });
});

describe('repeating-section column scope', () => {
  test('exports the canonical top-level answer-field boundary', () => {
    const fields = [
      field('row_email', '行内メール', 'email'),
      field('heading', '見出し', 'section'),
      field('contact_email', '本人メール', 'email'),
      field('participants', '参加者', 'repeating_section', {
        repeatingColumns: [{ columnField: 'row_email', title: 'メール' }],
      }),
    ];

    expect(getInternalSubmissionNotificationAnswerFields(fields).map(({ id }) => id)).toEqual([
      'contact_email',
      'participants',
    ]);
  });

  test('keeps referenced column fields out of top-level variables, defaults and samples', () => {
    let sampleChoiceReads = 0;
    const repeatingChoiceConfig = {
      get choices() {
        sampleChoiceReads += 1;
        return ['参加する', '参加しない'];
      },
    } as InternalSubmissionNotificationField['config'];
    const fields = [
      field('participant_choice', '行内の参加希望', 'choice', repeatingChoiceConfig),
      field('note', '備考'),
      field('participants', '参加者', 'repeating_section', {
        repeatingColumns: [{ columnField: 'participant_choice', title: '参加希望' }],
      }),
    ];

    expect(validateInternalSubmissionNotificationTemplate(
      '{{回答:行内の参加希望}}',
      fields,
    )).toEqual({
      ok: false,
      error: '回答項目「行内の参加希望」が見つかりません',
      issues: [{
        code: 'unknown_answer_label',
        label: '行内の参加希望',
        message: '回答項目「行内の参加希望」が見つかりません',
      }],
    });

    expect(renderInternalSubmissionNotification({
      template: '',
      formTitle: '参加登録',
      fields,
      answers: {
        participant_choice: 'トップレベルには出さない値',
        note: '連絡事項なし',
        participants: [{ participant_choice: '参加する' }],
      },
      displayName: null,
      editUrl: 'https://example.test/edit/repeating',
    })).toEqual({
      ok: true,
      text: [
        '「参加登録」へのご回答ありがとうございます。',
        '',
        '回答内容',
        '備考: 連絡事項なし',
        '参加者: 1. 参加希望: 参加する',
        '',
        '編集リンク',
        'https://example.test/edit/repeating',
      ].join('\n'),
    });

    expect(previewInternalSubmissionNotification({
      template: null,
      formTitle: '参加登録',
      fields,
      displayName: null,
    })).toEqual({
      ok: true,
      text: [
        '「参加登録」へのご回答ありがとうございます。',
        '',
        '回答内容',
        '備考: サンプル回答',
        '参加者: 1. 参加希望: 参加する',
        '',
        '編集リンク',
        'https://example.test/edit/sample',
      ].join('\n'),
    });
    expect(sampleChoiceReads).toBe(1);
  });
});

describe('previewInternalSubmissionNotification', () => {
  test('generates representative sample answers when answers are omitted', () => {
    const result = previewInternalSubmissionNotification({
      template: '{{回答:メール}} / {{回答:選択}} / {{回答:行列}} / {{回答:繰り返し}} / {{回答:署名}}',
      formTitle: '申込フォーム',
      fields: [
        field('email', 'メール', 'email'),
        field('choice', '選択', 'multiple_select', { choices: ['A', 'B', 'C'] }),
        field('matrix', '行列', 'matrix', {
          matrixChoiceItems: { good: { title: '良い' } },
          matrixChoiceGroups: [{ title: '接客' }],
        }),
        field('repeat_name', '氏名'),
        field('repeat', '繰り返し', 'repeating_section', {
          repeatingColumns: [{ columnField: 'repeat_name', title: '氏名' }],
        }),
        field('signature', '署名', 'signature'),
      ],
    });

    expect(result).toEqual({
      ok: true,
      text: 'sample@example.com / A、B / 接客: 良い / 1. 氏名: サンプル回答 / 署名済み',
    });
  });
});
