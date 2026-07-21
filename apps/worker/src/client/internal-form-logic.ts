import {
  evaluateInternalFormLogic,
  nextInternalFormFieldId,
  type InternalFormChannel,
} from '@line-crm/shared/internal-form-logic';
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared';

type LogicField = Pick<HarnessField, 'id' | 'position' | 'type'>;
type AnswerControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface InternalFormLogicConfig {
  fields: LogicField[];
  logic: HarnessLogicRule[];
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
