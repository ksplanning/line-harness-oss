import {
  evaluateInternalFormLogic,
  nextInternalFormFieldId,
  normalizePostalLookupCode,
  normalizeSingleLineAddress,
  type InternalFormChannel,
} from '@line-crm/shared/internal-form-logic';
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared';

type LogicField = Pick<HarnessField, 'id' | 'position' | 'type'>;
type AnswerControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface InternalFormLogicConfig {
  fields: LogicField[];
  logic: HarnessLogicRule[];
}

const POSTAL_LOOKUP_MESSAGES: Record<number, string> = {
  400: '郵便番号は半角数字7桁で入力してください',
  404: '住所が見つかりませんでした',
  409: '住所候補が複数あります。住所を直接入力してください',
  429: '検索が混み合っています。少し待ってからお試しください',
  503: '住所検索を一時的に利用できません。住所を直接入力してください',
};

function initSingleLineAddresses(root: ParentNode): void {
  root.querySelectorAll<HTMLTextAreaElement>('textarea[data-single-line-address]').forEach((control) => {
    if (control.dataset.singleLineAddressReady === 'true') return;
    control.dataset.singleLineAddressReady = 'true';
    control.value = normalizeSingleLineAddress(control.value);
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    control.addEventListener('input', () => {
      control.value = normalizeSingleLineAddress(control.value);
    });
    control.addEventListener('paste', (event) => {
      const pasted = event.clipboardData?.getData('text');
      if (pasted === undefined || pasted === normalizeSingleLineAddress(pasted)) return;
      event.preventDefault();
      control.setRangeText(
        normalizeSingleLineAddress(pasted),
        control.selectionStart,
        control.selectionEnd,
        'end',
      );
      control.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

function initInternalFormPostalLookup(root: ParentNode): void {
  const field = (id: string | undefined): AnswerControl | undefined => Array.from(
    root.querySelectorAll<AnswerControl>('[data-answer-field]'),
  ).find((element) => element.dataset.answerField === id);

  root.querySelectorAll<HTMLButtonElement>('.postal-lookup').forEach((button) => {
    const status = button.parentElement?.querySelector<HTMLElement>('.postal-status');
    if (!status) return;
    let controller: AbortController | null = null;
    let generation = 0;
    const zipInput = field(button.dataset.zipField);
    const normalizedZip = (): string => normalizePostalLookupCode(zipInput?.value);
    const initialZip = normalizedZip();
    const autofilledValues = new Map<string, string>();
    const restoredValues = new Map<string, string>();
    const manuallyEdited = new Set<string>();
    for (const targetId of [button.dataset.prefField, button.dataset.cityField, button.dataset.townField]) {
      if (!targetId) continue;
      const target = field(targetId);
      if (target?.value) restoredValues.set(targetId, target.value);
      target?.addEventListener('input', () => {
        autofilledValues.delete(targetId);
        manuallyEdited.add(targetId);
      });
    }
    let requestedZip: string | null = null;
    let completedZip: string | null = initialZip || null;
    zipInput?.addEventListener('input', () => {
      const currentZip = normalizedZip();
      if (completedZip !== null && currentZip !== completedZip) {
        status.textContent = '郵便番号が変更されました。もう一度検索してください';
      }
      if (!controller || currentZip === requestedZip) return;
      generation += 1;
      controller.abort();
      controller = null;
      requestedZip = null;
      button.disabled = false;
      status.textContent = '郵便番号が変更されました。もう一度検索してください';
    });
    button.addEventListener('click', async () => {
      const zip = normalizedZip();
      if (!/^\d{7}$/.test(zip)) {
        status.textContent = POSTAL_LOOKUP_MESSAGES[400];
        zipInput?.focus();
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const current = ++generation;
      requestedZip = zip;
      const isCurrent = (): boolean => current === generation && normalizedZip() === zip;
      button.disabled = true;
      status.textContent = '住所を検索しています';
      try {
        const response = await fetch(`/api/postal-lookup?zip=${encodeURIComponent(zip)}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!isCurrent()) return;
        if (!response.ok) throw Object.assign(new Error('postal lookup failed'), { status: response.status });
        const address = await response.json() as Record<string, unknown>;
        if (!isCurrent()) return;
        const values: Array<[string | undefined, unknown]> = [
          [button.dataset.prefField, address.pref],
          [button.dataset.cityField, address.city],
          [button.dataset.townField, address.town],
        ];
        for (const [targetId, value] of values) {
          if (!targetId) continue;
          const target = field(targetId);
          if (!target || typeof value !== 'string' || manuallyEdited.has(targetId)) continue;
          const previous = autofilledValues.get(targetId);
          const restored = restoredValues.get(targetId);
          const correctedRestoredValue = Boolean(initialZip && zip !== initialZip)
            && restored !== undefined && target.value === restored;
          if (!target.value || (previous !== undefined && target.value === previous) || correctedRestoredValue) {
            target.value = value;
            autofilledValues.set(targetId, value);
          } else if (previous !== undefined) {
            autofilledValues.delete(targetId);
          }
        }
        completedZip = zip;
        status.textContent = '住所を入力しました';
        root.querySelector('[data-internal-form]')?.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (error) {
        const detail = error as { name?: string; status?: number };
        if (detail.name === 'AbortError' || !isCurrent()) return;
        status.textContent = POSTAL_LOOKUP_MESSAGES[detail.status ?? 0]
          ?? '住所検索に失敗しました。住所を直接入力してください';
      } finally {
        if (current === generation) {
          controller = null;
          requestedZip = null;
          button.disabled = false;
        }
      }
    });
  });
}

function readConfig(root: ParentNode): InternalFormLogicConfig | null {
  const element = root.querySelector<HTMLScriptElement>('[data-internal-form-logic-config]');
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as InternalFormLogicConfig;
  } catch {
    return null;
  }
}

export function initInternalFormLogic(root: ParentNode = document): void {
  initSingleLineAddresses(root);
  initInternalFormPostalLookup(root);
  const config = readConfig(root);
  const form = root.querySelector<HTMLElement>('[data-internal-form]');
  if (!config || !form) return;

  const { fields, logic } = config;
  const channel: InternalFormChannel = form.dataset.channel === 'line' ? 'line' : 'web';
  const formType = form.dataset.formType === 'multi_step' ? 'multi_step' : 'simple';
  const submitButton = form.querySelector<HTMLButtonElement>('[data-submit]');
  if (!submitButton) return;
  const submitLabel = submitButton.textContent ?? '';
  const wrappers = Array.from(form.querySelectorAll<HTMLElement>('[data-field-id]'));
  const wrapperById = (id: string | null) => wrappers.find((wrapper) => wrapper.dataset.fieldId === id);
  const fieldType = (id: string) => fields.find((field) => field.id === id)?.type;
  const isQuestion = (id: string) => Boolean(wrapperById(id))
    && !['section', 'page_break', 'video', 'image'].includes(fieldType(id) ?? '');
  let currentFieldId: string | null = null;

  const answers = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const wrapper of wrappers) {
      const id = wrapper.dataset.fieldId;
      if (!id) continue;
      const controls = Array.from(wrapper.querySelectorAll<AnswerControl>('input, textarea, select'));
      const checks = controls.filter((control): control is HTMLInputElement => (
        control instanceof HTMLInputElement && control.type === 'checkbox'
      ));
      const radios = controls.filter((control): control is HTMLInputElement => (
        control instanceof HTMLInputElement && control.type === 'radio'
      ));
      if (checks.length) result[id] = checks.filter((control) => control.checked).map((control) => control.value);
      else if (radios.length) result[id] = radios.find((control) => control.checked)?.value ?? '';
      else if (controls[0]) result[id] = controls[0].value;
    }
    return result;
  };

  const nextQuestion = (state: ReturnType<typeof evaluateInternalFormLogic>, from: string): string | null => {
    let next = nextInternalFormFieldId(fields, state, from);
    while (next && !isQuestion(next)) {
      next = nextInternalFormFieldId(fields, state, next);
    }
    return next;
  };

  const apply = (): void => {
    const state = evaluateInternalFormLogic(fields, logic, answers(), channel);
    const logicVisible = new Set(state.visibleFieldIds);
    const questions = state.visibleFieldIds.filter(isQuestion);
    if (!currentFieldId || !logicVisible.has(currentFieldId)) currentFieldId = questions[0] ?? null;
    for (const wrapper of wrappers) {
      const id = wrapper.dataset.fieldId ?? '';
      const visible = logicVisible.has(id);
      const displayed = formType === 'simple' ? visible : visible && id === currentFieldId;
      wrapper.hidden = !displayed;
      for (const control of wrapper.querySelectorAll<AnswerControl>('input, textarea, select')) {
        control.disabled = !visible;
        if (control.dataset.required === 'true') control.required = visible;
      }
      if (wrapper.dataset.requiredGroup === 'true') {
        const first = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]');
        const checked = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]:checked');
        first?.setCustomValidity(visible && !checked ? '1つ以上選択してください' : '');
      }
    }
    if (formType === 'multi_step') {
      const next = currentFieldId ? nextQuestion(state, currentFieldId) : null;
      submitButton.type = next ? 'button' : 'submit';
      submitButton.textContent = next ? '次へ' : submitLabel;
      submitButton.dataset.nextFieldId = next ?? '';
    }
  };

  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  submitButton.addEventListener('click', (event) => {
    if (formType !== 'multi_step' || submitButton.type !== 'button') return;
    event.preventDefault();
    const current = wrapperById(currentFieldId);
    const invalid = current && Array.from(current.querySelectorAll<AnswerControl>('input, textarea, select'))
      .find((control) => !control.reportValidity());
    if (invalid) return;
    currentFieldId = submitButton.dataset.nextFieldId || null;
    apply();
    wrapperById(currentFieldId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  apply();
}

initInternalFormLogic();
