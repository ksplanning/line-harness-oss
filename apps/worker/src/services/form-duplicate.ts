import type { HarnessField, HarnessLogicRule } from '@line-crm/shared';

type JsonObject = Record<string, unknown>;

export interface DuplicatedChoiceListTarget {
  id: string;
  sourceUrl: string;
}

export interface DuplicatedFormDefinition {
  definition: JsonObject;
  fields: HarnessField[];
  logic: HarnessLogicRule[];
  choiceListRefs: Array<{ fieldId: string; sourceListId: string }>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function newInternalId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function mapFormulaReferences(formula: string, ids: Map<string, string>): string {
  return formula.replace(/\{([^{}]+)\}/g, (whole, sourceId: string) => {
    const targetId = ids.get(sourceId);
    return targetId ? `{${targetId}}` : whole;
  });
}

function mapPostalReferences(config: JsonObject, ids: Map<string, string>): void {
  const value = config.postalAutofill;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const postal = value as JsonObject;
  for (const key of ['zipField', 'prefField', 'cityField', 'townField', 'addressField']) {
    const sourceId = postal[key];
    if (typeof sourceId === 'string' && ids.has(sourceId)) postal[key] = ids.get(sourceId);
  }
}

function mapRepeatingReferences(config: JsonObject, ids: Map<string, string>): void {
  if (!Array.isArray(config.repeatingColumns)) return;
  config.repeatingColumns = config.repeatingColumns.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const column = { ...(value as JsonObject) };
    if (typeof column.columnField === 'string' && ids.has(column.columnField)) {
      column.columnField = ids.get(column.columnField);
    }
    // Formaloo assigns this remote identity. A copied form must create its own.
    delete column.slug;
    return column;
  });
}

function remapReference(value: unknown, ids: Map<string, string>): unknown {
  return typeof value === 'string' ? (ids.get(value) ?? value) : value;
}

/**
 * Copy the user-owned form definition while replacing every internal identity.
 * Provider identities and external choice URLs are intentionally removed.
 */
export function duplicateFormDefinition(definitionJson: string): DuplicatedFormDefinition {
  let source: JsonObject;
  try {
    const parsed = JSON.parse(definitionJson) as unknown;
    source = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    source = {};
  }

  const definition = cloneJson(source);
  const sourceFields = Array.isArray(definition.fields)
    ? definition.fields.filter((field): field is JsonObject => (
        field != null && typeof field === 'object' && !Array.isArray(field)
      ))
    : [];
  const sourceLogic = Array.isArray(definition.logic)
    ? definition.logic.filter((rule): rule is JsonObject => (
        rule != null && typeof rule === 'object' && !Array.isArray(rule)
      ))
    : [];
  const sourcePages = Array.isArray(definition.successPages)
    ? definition.successPages.filter((page): page is JsonObject => (
        page != null && typeof page === 'object' && !Array.isArray(page)
      ))
    : [];

  const ids = new Map<string, string>();
  for (const field of sourceFields) {
    if (typeof field.id === 'string' && field.id) ids.set(field.id, newInternalId('field'));
  }
  for (const page of sourcePages) {
    if (typeof page.id === 'string' && page.id) ids.set(page.id, newInternalId('success'));
  }

  const choiceListRefs: DuplicatedFormDefinition['choiceListRefs'] = [];
  const fields = sourceFields.map((sourceField) => {
    const field = cloneJson(sourceField);
    const sourceId = typeof sourceField.id === 'string' ? sourceField.id : '';
    field.id = ids.get(sourceId) ?? newInternalId('field');
    const config = field.config && typeof field.config === 'object' && !Array.isArray(field.config)
      ? field.config as JsonObject
      : {};
    field.config = config;

    if (typeof config.formula === 'string') {
      config.formula = mapFormulaReferences(config.formula, ids);
    }
    mapPostalReferences(config, ids);
    mapRepeatingReferences(config, ids);

    // These slugs belong to the original provider resources.
    delete config.choiceItems;
    const sourceListId = typeof config.choiceListId === 'string' ? config.choiceListId : '';
    if (sourceListId) {
      choiceListRefs.push({ fieldId: String(field.id), sourceListId });
    }
    // Local managed lists are attached after their child rows have new IDs.
    // Arbitrary external choices_source URLs stay disconnected by design.
    delete config.choiceListId;
    delete config.choicesSource;
    return field as unknown as HarnessField;
  });

  const logic = sourceLogic.map((sourceRule) => {
    const rule = cloneJson(sourceRule);
    rule.id = newInternalId('logic');
    rule.sourceFieldId = remapReference(rule.sourceFieldId, ids);
    rule.targetFieldId = remapReference(rule.targetFieldId, ids);
    if (Array.isArray(rule.conditions)) {
      rule.conditions = rule.conditions.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const condition = { ...(value as JsonObject) };
        condition.sourceFieldId = remapReference(condition.sourceFieldId, ids);
        return condition;
      });
    }
    if (Array.isArray(rule.actions)) {
      rule.actions = rule.actions.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const action = { ...(value as JsonObject) };
        action.targetFieldId = remapReference(action.targetFieldId, ids);
        return action;
      });
    }
    // Pulled raw fragments can contain remote slugs from the source form.
    delete rule.raw;
    return rule as unknown as HarnessLogicRule;
  });

  const successPages = sourcePages.map((sourcePage) => {
    const page = cloneJson(sourcePage);
    page.id = remapReference(page.id, ids);
    delete page.slug;
    return page;
  });

  definition.fields = fields;
  definition.logic = logic;
  if (sourcePages.length > 0) definition.successPages = successPages;
  // All three values bind the cache to the source provider form.
  delete definition.formalooAddress;
  delete definition.rawLogic;
  delete definition.logicFingerprint;

  return { definition, fields, logic, choiceListRefs };
}

export function attachDuplicatedChoiceLists(
  duplicated: DuplicatedFormDefinition,
  targets: ReadonlyMap<string, DuplicatedChoiceListTarget>,
): void {
  const fieldsById = new Map(duplicated.fields.map((field) => [field.id, field]));
  for (const ref of duplicated.choiceListRefs) {
    const field = fieldsById.get(ref.fieldId);
    const target = targets.get(ref.sourceListId);
    if (!field || !target) continue;
    field.config.choiceListId = target.id;
    field.config.choicesSource = target.sourceUrl;
  }
  duplicated.definition.fields = duplicated.fields;
}

export function serializeDuplicatedDefinition(duplicated: DuplicatedFormDefinition): string {
  return JSON.stringify(duplicated.definition);
}
