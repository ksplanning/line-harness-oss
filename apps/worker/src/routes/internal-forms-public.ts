import { Hono } from 'hono';
import {
  addTagToFriend,
  createInternalFormSubmission,
  enrollFriendInScenario,
  getFormalooForm,
  getFriendById,
  type FormalooForm,
} from '@line-crm/db';
import { verifyFriendToken } from '../services/formaloo-friend-token.js';
import {
  JAPAN_PREFECTURES,
  parseInternalFormDefinition,
  validateInternalFormAnswers,
  type InternalAnswerInput,
  type InternalFormDefinition,
  type InternalFormField,
} from '../services/internal-form-runtime.js';
import type { Env } from '../index.js';

export const internalFormsPublic = new Hono<Env>();

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, content: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f4f6f8; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: max(20px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom)); }
    main { width: min(100%, 640px); margin: 0 auto; background: #fff; border-radius: 16px; padding: 24px 18px; box-shadow: 0 8px 28px rgba(18, 38, 63, .08); }
    h1 { margin: 0 0 8px; font-size: clamp(1.45rem, 5vw, 2rem); line-height: 1.3; }
    .description { margin: 0 0 24px; color: #52606d; white-space: pre-wrap; }
    .field { margin: 0 0 22px; padding: 0; border: 0; }
    .label, legend { display: block; width: 100%; margin: 0 0 8px; font-weight: 700; }
    .required { color: #b42318; font-size: .8rem; margin-left: 6px; }
    .help { margin: -2px 0 8px; color: #667085; font-size: .9rem; white-space: pre-wrap; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .placeholder-hint { margin: -2px 0 8px; color: #667085; font-size: .85rem; font-style: italic; }
    .counter { margin: 6px 0 0; color: #667085; font-size: .85rem; text-align: right; }
    input, textarea, select, button { width: 100%; font: inherit; }
    input, textarea, select { min-height: 48px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 11px 12px; background: #fff; color: inherit; }
    textarea { min-height: 120px; resize: vertical; }
    .option { display: flex; align-items: flex-start; gap: 10px; margin: 10px 0; font-weight: 400; }
    .option input { width: 22px; min-height: 22px; margin: 0; flex: 0 0 22px; }
    .rating-options { display: flex; flex-wrap: wrap; gap: 8px; }
    .rating-options .option { align-items: center; margin: 0; padding: 8px 10px; border: 1px solid #d8dee8; border-radius: 10px; }
    .signature-wrap { border: 1px solid #cbd5e1; border-radius: 10px; overflow: hidden; background: #fff; }
    .signature-wrap canvas { display: block; width: 100%; height: 180px; touch-action: none; }
    .secondary { min-height: 42px; margin-top: 8px; background: #eef2f6; color: #344054; }
    .matrix { width: 100%; border-collapse: collapse; overflow-x: auto; }
    .matrix th, .matrix td { padding: 9px 7px; border-bottom: 1px solid #e4e7ec; text-align: center; }
    .matrix th:first-child { text-align: left; }
    .matrix input { width: 22px; min-height: 22px; }
    .repeat-row { margin: 10px 0; padding: 12px; border: 1px solid #e4e7ec; border-radius: 10px; }
    .repeat-cell { display: block; margin-bottom: 10px; font-size: .9rem; font-weight: 700; }
    .repeat-cell input, .repeat-cell textarea, .repeat-cell select { margin-top: 5px; font-weight: 400; }
    .formula { display: block; min-height: 48px; padding: 11px 12px; border-radius: 10px; background: #f2f4f7; font-variant-numeric: tabular-nums; }
    .section-decoration { margin: 28px 0 18px; padding-top: 8px; border-top: 1px solid #e4e7ec; }
    .section-decoration h2 { margin: 0 0 6px; font-size: 1.2rem; }
    .video-decoration { position: relative; margin: 18px 0 24px; }
    .video-decoration iframe { display: block; width: 100%; border: 0; border-radius: 10px; }
    .image-decoration { margin: 18px 0 24px; text-align: center; }
    .image-decoration img { display: block; height: auto; margin: 0 auto; border-radius: 10px; }
    [data-page-step][hidden] { display: none; }
    .page-actions { display: flex; gap: 10px; margin-top: 22px; }
    .page-actions .secondary { margin: 0; }
    button { min-height: 52px; border: 0; border-radius: 12px; background: #06c755; color: #fff; font-weight: 800; cursor: pointer; }
    .errors { margin: 0 0 20px; padding: 12px 14px; border-radius: 10px; background: #fef3f2; color: #b42318; }
    .complete { text-align: center; padding-block: 42px; }
    @media (min-width: 600px) { main { padding: 36px; } }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function requiredMark(field: InternalFormField): string {
  return field.required ? '<span class="required">必須</span>' : '';
}

function helpText(field: InternalFormField): string {
  return field.config.description
    ? `<p class="help">${escapeHtml(field.config.description)}</p>`
    : '';
}

function placeholderAttribute(field: InternalFormField): string {
  return field.config.placeholder ? ` placeholder="${escapeHtml(field.config.placeholder)}"` : '';
}

function placeholderHint(field: InternalFormField): string {
  return field.config.placeholder
    ? `<p class="placeholder-hint">${escapeHtml(field.config.placeholder)}</p>`
    : '';
}

function textLengthAttributes(field: InternalFormField): string {
  const minimum = field.config.minLength !== undefined
    ? ` data-min-length="${field.config.minLength}"`
    : '';
  const maximum = field.config.maxLength !== undefined
    ? ` data-max-length="${field.config.maxLength}"`
    : '';
  return `${minimum}${maximum}`;
}

function renderCounter(field: InternalFormField, id: string): string {
  if (field.config.minLength === undefined && field.config.maxLength === undefined) return '';
  const initial = field.config.maxLength === undefined
    ? '0文字'
    : `残り${field.config.maxLength}文字`;
  return `<p class="counter" id="${id}-counter" data-character-counter aria-live="polite">${initial}</p>`;
}

function checked(selected: boolean): string {
  return selected ? ' checked' : '';
}

function selected(isSelected: boolean): string {
  return isSelected ? ' selected' : '';
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function matrixColumns(field: InternalFormField): { value: string; title: string }[] {
  return Object.entries(field.config.matrixChoiceItems ?? {}).flatMap(([value, item]) => {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.title === 'string') {
      return [{ value, title: item.title }];
    }
    return [];
  });
}

function renderRepeatingInput(
  referenced: InternalFormField | undefined,
  name: string,
  id: string,
): string {
  const placeholder = referenced ? placeholderAttribute(referenced) : '';
  const required = referenced?.required ? ' required' : '';
  const hint = referenced ? placeholderHint(referenced) : '';
  if (referenced?.type === 'textarea') return `${hint}<textarea id="${id}" name="${name}"${placeholder}${required}></textarea>`;
  if (referenced?.type === 'choice' || referenced?.type === 'dropdown' || referenced?.type === 'multiple_select') {
    const options = (referenced.config.choices ?? []).map((choice) => (
      `<option value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`
    )).join('');
    const multiple = referenced.type === 'multiple_select' ? ' multiple' : '';
    return `${hint}<select id="${id}" name="${name}"${multiple}${required}><option value="">${escapeHtml(referenced.config.placeholder ?? '選択してください')}</option>${options}</select>`;
  }
  if (referenced?.type === 'yes_no') {
    return `${hint}<select id="${id}" name="${name}"${required}><option value="">選択してください</option><option value="yes">はい</option><option value="no">いいえ</option></select>`;
  }
  const inputType = referenced?.type === 'number'
    ? 'number'
    : referenced?.type === 'email'
      ? 'email'
      : referenced?.type === 'phone'
        ? 'tel'
        : referenced?.type === 'date'
          ? 'date'
          : referenced?.type === 'time'
            ? 'time'
            : referenced?.type === 'datetime'
              ? 'datetime-local'
              : referenced?.type === 'website'
                ? 'url'
                : 'text';
  return `${hint}<input type="${inputType}" id="${id}" name="${name}"${placeholder}${required}>`;
}

function renderRepeatingRow(field: InternalFormField, fieldIndex: number, rowIndex: number, fields: InternalFormField[]): string {
  const columns = field.config.repeatingColumns ?? [];
  const cells = columns.map((column, columnIndex) => {
    const referenced = fields.find((candidate) => candidate.id === column.columnField);
    const name = `a_${fieldIndex}_r_${rowIndex}_${columnIndex}`;
    const id = `field-${fieldIndex}-row-${rowIndex}-column-${columnIndex}`;
    return `<label class="repeat-cell" for="${id}">${escapeHtml(column.title)}${renderRepeatingInput(referenced, name, id)}</label>`;
  }).join('');
  return `<div class="repeat-row" data-repeat-row data-row-index="${rowIndex}">${cells}<button type="button" class="secondary" data-repeat-remove>この行を削除</button></div>`;
}

function renderField(field: InternalFormField, index: number, fields: InternalFormField[]): string {
  const name = `a_${index}`;
  const id = `field-${index}`;
  const required = field.required ? ' required' : '';

  if (field.type === 'textarea') {
    return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<textarea id="${id}" name="${name}"${required}${placeholderAttribute(field)}${textLengthAttributes(field)} data-answer-field="${escapeHtml(field.id)}" aria-describedby="${id}-counter"></textarea>${renderCounter(field, id)}</div>`;
  }
  if (field.type === 'choice' || field.type === 'multiple_select') {
    const inputType = field.type === 'choice' ? 'radio' : 'checkbox';
    // `required` on every checkbox means every option is mandatory. The server validates
    // multiple_select as one group, while radio can safely use the native group constraint.
    const optionRequired = field.type === 'choice' ? required : '';
    const defaults = field.type === 'choice'
      ? [field.config.defaultValue]
      : field.config.defaultValues ?? [];
    const options = (field.config.choices ?? []).map((choice) =>
      `<label class="option"><input type="${inputType}" name="${name}" value="${escapeHtml(choice)}"${optionRequired}${checked(defaults.includes(choice))} data-answer-field="${escapeHtml(field.id)}"><span>${escapeHtml(choice)}</span></label>`,
    ).join('');
    return `<fieldset class="field"><legend>${escapeHtml(field.label)}${requiredMark(field)}</legend>${helpText(field)}${placeholderHint(field)}${options}</fieldset>`;
  }
  if (field.type === 'dropdown') {
    const options = (field.config.choices ?? []).map((choice) =>
      `<option value="${escapeHtml(choice)}"${selected(field.config.defaultValue === choice)}>${escapeHtml(choice)}</option>`,
    ).join('');
    return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<select id="${id}" name="${name}"${required} data-answer-field="${escapeHtml(field.id)}"><option value="">${escapeHtml(field.config.placeholder ?? '選択してください')}</option>${options}</select></div>`;
  }

  if (field.type === 'rating') {
    const ratingType = field.config.ratingSubType ?? 'star';
    if (ratingType === 'score') {
      return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<input type="number" id="${id}" name="${name}" step="any"${required}${placeholderAttribute(field)} inputmode="decimal" data-answer-field="${escapeHtml(field.id)}"></div>`;
    }
    const options = ratingType === 'like_dislike'
      ? [['like', '良い'], ['dislike', '良くない']]
      : Array.from({ length: ratingType === 'nps' ? 11 : 5 }, (_, optionIndex) => {
        const score = ratingType === 'nps' ? optionIndex : optionIndex + 1;
        return [String(score), ratingType === 'nps' ? String(score) : `${score}つ星`];
      });
    return `<fieldset class="field"><legend>${escapeHtml(field.label)}${requiredMark(field)}</legend>${helpText(field)}${placeholderHint(field)}<div class="rating-options">${options.map(([value, label]) => `<label class="option"><input type="radio" name="${name}" value="${value}"${required} data-answer-field="${escapeHtml(field.id)}"><span>${escapeHtml(label)}</span></label>`).join('')}</div></fieldset>`;
  }

  if (field.type === 'yes_no') {
    return `<fieldset class="field"><legend>${escapeHtml(field.label)}${requiredMark(field)}</legend>${helpText(field)}${placeholderHint(field)}<label class="option"><input type="radio" name="${name}" value="yes"${required} data-answer-field="${escapeHtml(field.id)}"><span>はい</span></label><label class="option"><input type="radio" name="${name}" value="no"${required} data-answer-field="${escapeHtml(field.id)}"><span>いいえ</span></label></fieldset>`;
  }

  if (field.type === 'signature') {
    return `<div class="field" data-signature><span class="label">${escapeHtml(field.label)}${requiredMark(field)}</span>${helpText(field)}${placeholderHint(field)}<div class="signature-wrap"><canvas data-signature-canvas role="img" aria-label="${escapeHtml(field.label)}の署名欄"></canvas></div><input type="hidden" id="${id}" name="${name}"${required}><button type="button" class="secondary" data-signature-clear>署名を消す</button></div>`;
  }

  if (field.type === 'file') {
    const extensions = (field.config.allowedExtensions ?? [])
      .map((extension) => extension.replace(/^\./, '').toLowerCase())
      .filter((extension) => /^[a-z0-9]+$/.test(extension));
    const accept = extensions.length ? ` accept="${extensions.map((extension) => `.${extension}`).join(',')}"` : '';
    const multiple = field.config.allowMultipleFiles ? ' multiple' : '';
    return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}${placeholderHint(field)}<input type="file" id="${id}" name="${name}"${accept}${multiple}${required}></div>`;
  }

  if (field.type === 'matrix') {
    const columns = matrixColumns(field);
    const rows = field.config.matrixChoiceGroups ?? [];
    const heading = columns.map((column) => `<th scope="col">${escapeHtml(column.title)}</th>`).join('');
    const body = rows.map((row, rowIndex) => `<tr><th scope="row">${escapeHtml(row.title)}</th>${columns.map((column) => `<td><label><span class="sr-only">${escapeHtml(row.title)}: ${escapeHtml(column.title)}</span><input type="radio" name="${name}_m_${rowIndex}" value="${escapeHtml(column.value)}"${required}></label></td>`).join('')}</tr>`).join('');
    return `<fieldset class="field"><legend>${escapeHtml(field.label)}${requiredMark(field)}</legend>${helpText(field)}${placeholderHint(field)}<div style="overflow-x:auto"><table class="matrix"><thead><tr><th></th>${heading}</tr></thead><tbody>${body}</tbody></table></div></fieldset>`;
  }

  if (field.type === 'repeating_section') {
    const minimum = field.required ? Math.max(1, field.config.minRows ?? 0) : field.config.minRows ?? 0;
    const maximum = field.config.maxRows ?? 32767;
    const initialRows = Array.from({ length: minimum }, (_, rowIndex) => renderRepeatingRow(field, index, rowIndex, fields)).join('');
    return `<fieldset class="field" data-repeating data-field-index="${index}" data-min-rows="${minimum}" data-max-rows="${maximum}"><legend>${escapeHtml(field.label)}${requiredMark(field)}</legend>${helpText(field)}${placeholderHint(field)}<input type="hidden" name="${name}_count" value="${minimum}" data-repeat-count><div data-repeat-rows>${initialRows}</div><template data-repeat-template>${renderRepeatingRow(field, index, 999999, fields)}</template><button type="button" class="secondary" data-repeat-add>行を追加</button></fieldset>`;
  }

  if (field.type === 'variable') {
    return `<div class="field"><span class="label">${escapeHtml(field.label)}</span>${helpText(field)}<output class="formula" data-formula data-expression="${escapeHtml(field.config.formula ?? '')}">—</output></div>`;
  }

  if (field.type === 'section') {
    return `<section class="section-decoration"><h2>${escapeHtml(field.label)}</h2>${field.config.text ? `<p class="description">${escapeHtml(field.config.text)}</p>` : ''}</section>`;
  }

  if (field.type === 'video') {
    const url = safeHttpUrl(field.config.videoUrl);
    if (!url) return '';
    const height = /^\d{2,4}(?:px|vw)$/.test(field.config.videoHeight ?? '') ? field.config.videoHeight : '350px';
    return `<section class="video-decoration"><h2>${escapeHtml(field.label)}</h2><iframe src="${escapeHtml(url)}" title="${escapeHtml(field.label)}" height="${height}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" allowfullscreen></iframe></section>`;
  }

  if (field.type === 'image') {
    const url = safeHttpUrl(field.config.imageUrl);
    if (!url) return '';
    const widths = { small: '40%', medium: '70%', full: '100%' } as const;
    const width = widths[field.config.imageWidth ?? 'full'];
    return `<figure class="image-decoration"><img src="${escapeHtml(url)}" alt="${escapeHtml(field.config.imageAlt ?? field.label)}" style="max-width:${width}" loading="lazy"></figure>`;
  }

  if (field.type === 'page_break') return '';

  const inputType = field.type === 'phone'
    ? 'tel'
    : field.type === 'website'
      ? 'url'
      : field.type === 'datetime'
        ? 'datetime-local'
        : field.type === 'country' || field.type === 'postal_code' || field.type === 'prefecture'
          || field.type === 'address_city' || field.type === 'address_street' || field.type === 'address_building'
          || field.type === 'city'
          ? 'text'
          : field.type;
  const inputMode = field.type === 'number' ? ' inputmode="decimal"' : field.type === 'phone' ? ' inputmode="tel"' : '';
  if (field.type === 'prefecture') {
    const options = JAPAN_PREFECTURES.map((prefecture) => `<option value="${escapeHtml(prefecture)}">${escapeHtml(prefecture)}</option>`).join('');
    return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<select id="${id}" name="${name}"${required} data-answer-field="${escapeHtml(field.id)}"><option value="">${escapeHtml(field.config.placeholder ?? '都道府県を選択')}</option>${options}</select></div>`;
  }
  const length = field.type === 'text' ? textLengthAttributes(field) : '';
  const counter = field.type === 'text' ? renderCounter(field, id) : '';
  const visiblePlaceholder = field.type === 'date' || field.type === 'time' || field.type === 'datetime'
    ? placeholderHint(field)
    : '';
  return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}${visiblePlaceholder}<input type="${inputType}" id="${id}" name="${name}"${required}${placeholderAttribute(field)}${length}${inputMode} data-answer-field="${escapeHtml(field.id)}"${counter ? ` aria-describedby="${id}-counter"` : ''}>${counter}</div>`;
}

function renderRuntimeFields(definition: InternalFormDefinition): { html: string; hasPages: boolean } {
  const repeatingTemplates = new Set(
    definition.fields
      .filter((field) => field.type === 'repeating_section')
      .flatMap((field) => (field.config.repeatingColumns ?? []).map((column) => column.columnField)),
  );
  const hasPages = definition.fields.some((field) => field.type === 'page_break');
  if (!hasPages) {
    return {
      html: `${definition.fields.map((field, index) => (
        repeatingTemplates.has(field.id) ? '' : renderField(field, index, definition.fields)
      )).join('')}<button type="submit">${escapeHtml(definition.buttonText ?? '送信する')}</button>`,
      hasPages: false,
    };
  }

  const pages: string[][] = [[]];
  for (let index = 0; index < definition.fields.length; index++) {
    const field = definition.fields[index];
    if (repeatingTemplates.has(field.id)) continue;
    if (field.type === 'page_break') {
      pages.push([`<section class="section-decoration"><h2>${escapeHtml(field.label)}</h2></section>`]);
      continue;
    }
    pages[pages.length - 1].push(renderField(field, index, definition.fields));
  }

  return {
    hasPages: true,
    html: pages.map((page, pageIndex) => {
      const previous = pageIndex > 0
        ? '<button type="button" class="secondary" data-page-back>戻る</button>'
        : '';
      const forward = pageIndex < pages.length - 1
        ? '<button type="button" data-page-next>次へ</button>'
        : `<button type="submit">${escapeHtml(definition.buttonText ?? '送信する')}</button>`;
      return `<section data-page-step="${pageIndex}"${pageIndex === 0 ? '' : ' hidden'}>${page.join('')}<div class="page-actions">${previous}${forward}</div></section>`;
    }).join(''),
  };
}

function runtimeScript(): string {
  return String.raw`<script>
  (() => {
    const form = document.querySelector('form');
    if (!form) return;

    const characterCount = (value) => Array.from(value).length;
    const updateCounter = (control) => {
      const counter = document.getElementById(control.id + '-counter');
      if (!counter) return;
      const count = characterCount(control.value);
      const maximum = Number(control.dataset.maxLength || '');
      const minimum = Number(control.dataset.minLength || '');
      counter.textContent = Number.isFinite(maximum) && maximum > 0
        ? '残り' + (maximum - count) + '文字'
        : count + '文字';
      if (control.value && Number.isFinite(minimum) && minimum > 0 && count < minimum) {
        control.setCustomValidity(minimum + '文字以上で入力してください');
      } else if (Number.isFinite(maximum) && maximum > 0 && count > maximum) {
        control.setCustomValidity(maximum + '文字以内で入力してください');
      } else {
        control.setCustomValidity('');
      }
    };
    form.querySelectorAll('[data-min-length], [data-max-length]').forEach((control) => {
      updateCounter(control);
      control.addEventListener('input', () => updateCounter(control));
    });

    const pages = Array.from(form.querySelectorAll('[data-page-step]'));
    let currentPage = 0;
    const showPage = (index) => {
      currentPage = Math.max(0, Math.min(index, pages.length - 1));
      pages.forEach((page, pageIndex) => { page.hidden = pageIndex !== currentPage; });
      pages[currentPage]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    form.querySelectorAll('[data-page-next]').forEach((button) => button.addEventListener('click', () => {
      const current = pages[currentPage];
      const invalid = current && Array.from(current.querySelectorAll('input, textarea, select')).find((control) => !control.checkValidity());
      if (invalid) { invalid.reportValidity(); return; }
      showPage(currentPage + 1);
    }));
    form.querySelectorAll('[data-page-back]').forEach((button) => button.addEventListener('click', () => showPage(currentPage - 1)));

    form.querySelectorAll('[data-signature]').forEach((wrapper) => {
      const canvas = wrapper.querySelector('[data-signature-canvas]');
      const value = wrapper.querySelector('input[type="hidden"]');
      const clear = wrapper.querySelector('[data-signature-clear]');
      if (!canvas || !value) return;
      const context = canvas.getContext('2d');
      let drawing = false;
      const resize = () => {
        const ratio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.lineWidth = 2;
        context.lineCap = 'round';
        context.strokeStyle = '#17202a';
      };
      resize();
      const point = (event) => {
        const bounds = canvas.getBoundingClientRect();
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      };
      canvas.addEventListener('pointerdown', (event) => {
        if (canvas.width <= 1 && canvas.clientWidth > 1) resize();
        drawing = true;
        canvas.setPointerCapture(event.pointerId);
        const p = point(event);
        context.beginPath();
        context.moveTo(p.x, p.y);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!drawing) return;
        const p = point(event);
        context.lineTo(p.x, p.y);
        context.stroke();
      });
      const finish = () => {
        if (!drawing) return;
        drawing = false;
        value.value = canvas.toDataURL('image/png');
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
      clear?.addEventListener('click', () => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        value.value = '';
      });
    });

    form.querySelectorAll('[data-repeating]').forEach((wrapper) => {
      const rows = wrapper.querySelector('[data-repeat-rows]');
      const template = wrapper.querySelector('[data-repeat-template]');
      const count = wrapper.querySelector('[data-repeat-count]');
      const minimum = Number(wrapper.dataset.minRows || '0');
      const maximum = Number(wrapper.dataset.maxRows || '32767');
      if (!rows || !template || !count) return;
      const syncRows = () => {
        const active = Array.from(rows.querySelectorAll('[data-repeat-row]'));
        active.forEach((row, rowIndex) => {
          row.dataset.rowIndex = String(rowIndex);
          row.querySelectorAll('[name]').forEach((control) => {
            control.name = control.name.replace(/_r_\d+_/, '_r_' + rowIndex + '_');
          });
          row.querySelectorAll('[id]').forEach((control) => {
            const prior = control.id;
            control.id = prior.replace(/-row-\d+-/, '-row-' + rowIndex + '-');
            row.querySelectorAll('label[for="' + CSS.escape(prior) + '"]').forEach((label) => { label.htmlFor = control.id; });
          });
        });
        count.value = String(active.length);
        wrapper.querySelector('[data-repeat-add]').disabled = active.length >= maximum;
        active.forEach((row) => {
          row.querySelector('[data-repeat-remove]').disabled = active.length <= minimum;
        });
      };
      const bindRemove = (row) => row.querySelector('[data-repeat-remove]')?.addEventListener('click', () => {
        if (rows.querySelectorAll('[data-repeat-row]').length <= minimum) return;
        row.remove();
        syncRows();
      });
      rows.querySelectorAll('[data-repeat-row]').forEach(bindRemove);
      wrapper.querySelector('[data-repeat-add]')?.addEventListener('click', () => {
        const next = rows.querySelectorAll('[data-repeat-row]').length;
        if (next >= maximum) return;
        const holder = document.createElement('div');
        holder.innerHTML = template.innerHTML.replaceAll('999999', String(next));
        const row = holder.firstElementChild;
        if (!row) return;
        rows.append(row);
        bindRemove(row);
        syncRows();
      });
      syncRows();
    });

    const numericFieldValue = (fieldId) => {
      const controls = Array.from(form.querySelectorAll('[data-answer-field]'))
        .filter((control) => control.dataset.answerField === fieldId);
      if (controls.length === 0) throw new Error('計算元が見つかりません');
      const selected = controls.find((control) => !('checked' in control) || control.checked);
      if (!selected || !selected.value.trim()) throw new Error('計算元が未入力です');
      const normalized = selected.value === 'yes' ? '1' : selected.value === 'no' ? '0' : selected.value;
      const value = Number(normalized);
      if (!Number.isFinite(value)) throw new Error('計算元が数値ではありません');
      return value;
    };
    const calculate = (expression) => {
      const replaced = expression.replace(/\{([^{}]+)\}/g, (_match, fieldId) => String(numericFieldValue(fieldId)));
      const compact = replaced.replace(/\s+/g, '');
      const tokens = compact.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?|[()+\-*/]/g) || [];
      if (tokens.join('') !== compact) throw new Error('未対応の計算式です');
      let cursor = 0;
      const factor = () => {
        const token = tokens[cursor++];
        if (token === '+') return factor();
        if (token === '-') return -factor();
        if (token === '(') {
          const value = expressionValue();
          if (tokens[cursor++] !== ')') throw new Error('括弧が不正です');
          return value;
        }
        const value = Number(token);
        if (!Number.isFinite(value)) throw new Error('数値が不正です');
        return value;
      };
      const term = () => {
        let value = factor();
        while (tokens[cursor] === '*' || tokens[cursor] === '/') {
          const operator = tokens[cursor++];
          const right = factor();
          value = operator === '*' ? value * right : value / right;
        }
        return value;
      };
      const expressionValue = () => {
        let value = term();
        while (tokens[cursor] === '+' || tokens[cursor] === '-') {
          const operator = tokens[cursor++];
          const right = term();
          value = operator === '+' ? value + right : value - right;
        }
        return value;
      };
      const value = expressionValue();
      if (cursor !== tokens.length || !Number.isFinite(value)) throw new Error('計算できません');
      return value;
    };
    const updateFormulas = () => form.querySelectorAll('[data-formula]').forEach((output) => {
      try { output.value = String(calculate(output.dataset.expression || '')); }
      catch { output.value = '—'; }
    });
    form.addEventListener('input', updateFormulas);
    updateFormulas();
  })();
  </script>`;
}

function renderFormPage(
  form: FormalooForm,
  definition: InternalFormDefinition,
  friendToken: string | null,
  error?: string,
): string {
  const hidden = friendToken
    ? `<input type="hidden" name="fr_id" value="${escapeHtml(friendToken)}">`
    : '';
  const rendered = renderRuntimeFields(definition);
  const errorHtml = error ? `<div class="errors" role="alert">${escapeHtml(error)}</div>` : '';
  const enctype = definition.fields.some((field) => field.type === 'file')
    ? ' enctype="multipart/form-data"'
    : '';
  return shell(form.title, `
    <h1>${escapeHtml(form.title)}</h1>
    ${form.description ? `<p class="description">${escapeHtml(form.description)}</p>` : ''}
    ${errorHtml}
    <form method="post" action="/f/${encodeURIComponent(form.id)}"${enctype}>
      ${hidden}${rendered.html}
    </form>
    ${runtimeScript()}`);
}

function renderCompletion(form: FormalooForm, definition: InternalFormDefinition): string {
  const message = definition.successMessage ?? form.submit_message ?? '送信ありがとうございました';
  return shell(form.title, `<section class="complete"><h1>${escapeHtml(message)}</h1></section>`);
}

function renderUnavailable(status: 404 | 422 | 500, message: string): Response {
  return new Response(shell('フォーム', `<section class="complete"><h1>${escapeHtml(message)}</h1></section>`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

async function loadRuntimeForm(db: D1Database, formId: string): Promise<
  | { ok: true; form: FormalooForm; definition: InternalFormDefinition }
  | { ok: false; status: 404 | 422; message: string }
> {
  const form = await getFormalooForm(db, formId);
  if (!form || form.deleted || form.render_backend !== 'internal' || form.builder_status !== 'published') {
    return { ok: false, status: 404, message: 'このフォームは現在ご利用いただけません' };
  }
  const parsed = parseInternalFormDefinition(form.definition_json);
  if (!parsed.ok) return { ok: false, status: 422, message: parsed.error };
  return { ok: true, form, definition: parsed.definition };
}

function answerInputs(body: Record<string, string | File | (string | File)[]>): InternalAnswerInput {
  const result: InternalAnswerInput = Object.create(null) as InternalAnswerInput;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' || value instanceof File) result[key] = value;
    else if (Array.isArray(value)) {
      result[key] = value.filter((item): item is string | File => typeof item === 'string' || item instanceof File);
    }
  }
  return result;
}

function uploadExtension(filename: string): string {
  const match = /\.([a-z0-9]{1,20})$/i.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : '';
}

async function rollbackUploads(bucket: R2Bucket, keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => bucket.delete(key)));
}

internalFormsPublic.get('/f/:formId', async (c) => {
  try {
    const runtime = await loadRuntimeForm(c.env.DB, c.req.param('formId'));
    if (!runtime.ok) return renderUnavailable(runtime.status, runtime.message);
    const rawToken = c.req.query('fr_id') ?? null;
    const verified = await verifyFriendToken(rawToken, c.env.FORMALOO_FRIEND_TOKEN_SECRET);
    return c.html(renderFormPage(runtime.form, runtime.definition, verified ? rawToken : null));
  } catch (error) {
    console.error('GET /f/:formId error:', error);
    return renderUnavailable(500, 'フォームの読み込みに失敗しました');
  }
});

internalFormsPublic.post('/f/:formId', async (c) => {
  try {
    const runtime = await loadRuntimeForm(c.env.DB, c.req.param('formId'));
    if (!runtime.ok) return renderUnavailable(runtime.status, runtime.message);
    const parsedBody = await c.req.parseBody({ all: true }).catch(() => ({}));
    const body = answerInputs(parsedBody);
    const validation = validateInternalFormAnswers(runtime.definition.fields, body);
    const rawToken = typeof body.fr_id === 'string' ? body.fr_id : null;
    const verifiedFriendId = await verifyFriendToken(rawToken, c.env.FORMALOO_FRIEND_TOKEN_SECRET);

    if (!validation.ok) {
      return c.html(
        renderFormPage(runtime.form, runtime.definition, verifiedFriendId ? rawToken : null, validation.error),
        400,
      );
    }

    const uploadedKeys: string[] = [];
    let friendId: string | null = null;
    try {
      const answers = validation.answers;
      for (const upload of validation.pendingUploads) {
        const metadata: { key: string; name: string; size: number; type: string }[] = [];
        for (const file of upload.files) {
          const key = `internal-form-submissions/${encodeURIComponent(runtime.form.id)}/${encodeURIComponent(upload.fieldId)}/${crypto.randomUUID()}${uploadExtension(file.name)}`;
          // Record the intended key before put so a partial R2 failure is also cleaned up.
          uploadedKeys.push(key);
          await c.env.IMAGES.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || 'application/octet-stream' },
          });
          metadata.push({
            key,
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
          });
        }
        answers[upload.fieldId] = metadata;
      }

      const friend = verifiedFriendId ? await getFriendById(c.env.DB, verifiedFriendId) : null;
      friendId = friend?.id ?? null;
      await createInternalFormSubmission(c.env.DB, {
        formId: runtime.form.id,
        friendId,
        answers,
      });
    } catch (error) {
      await rollbackUploads(c.env.IMAGES, uploadedKeys);
      throw error;
    }

    if (friendId) {
      const effects: Promise<unknown>[] = [];
      if (runtime.form.on_submit_tag_id) {
        effects.push(addTagToFriend(c.env.DB, friendId, runtime.form.on_submit_tag_id));
      }
      if (runtime.form.on_submit_scenario_id) {
        effects.push(enrollFriendInScenario(c.env.DB, friendId, runtime.form.on_submit_scenario_id));
      }
      const settled = await Promise.allSettled(effects);
      for (const result of settled) {
        if (result.status === 'rejected') console.error('internal form post-processing failed:', result.reason);
      }
    }

    return c.html(renderCompletion(runtime.form, runtime.definition));
  } catch (error) {
    console.error('POST /f/:formId error:', error);
    return renderUnavailable(500, '送信に失敗しました');
  }
});
