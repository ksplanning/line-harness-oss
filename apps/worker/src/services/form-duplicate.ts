import {
  logicFingerprint,
  type HarnessField,
  type HarnessLogicRule,
} from '@line-crm/shared';

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

function choiceTitles(config: JsonObject): Map<string, string> {
  const titles = new Map<string, string>();
  if (!Array.isArray(config.choiceItems)) return titles;
  for (const item of config.choiceItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const choice = item as JsonObject;
    if (typeof choice.slug === 'string' && typeof choice.title === 'string') {
      titles.set(choice.slug, choice.title);
    }
  }
  return titles;
}

function sanitizeMatrixIdentity(config: JsonObject): void {
  if (Array.isArray(config.matrixChoiceGroups)) {
    config.matrixChoiceGroups = config.matrixChoiceGroups.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const title = (value as JsonObject).title;
      return typeof title === 'string' ? { title } : {};
    });
  }
  const items = config.matrixChoiceItems;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return;
  const sanitized: JsonObject = {};
  let index = 0;
  for (const value of Object.values(items as JsonObject)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const title = (value as JsonObject).title;
    sanitized[`column_${++index}`] = typeof title === 'string' ? { title } : {};
  }
  config.matrixChoiceItems = sanitized;
}

interface RawTemplateResult {
  value: unknown;
  mappedCount: number;
}

/**
 * Provider raw logic is richer than the builder projection. Convert provider
 * identities to copied-form internal IDs, then resolve those IDs on first push.
 */
function buildRawLogicTemplate(
  value: unknown,
  referenceIds: ReadonlyMap<string, string>,
  choiceTitlesByFieldRef: ReadonlyMap<string, ReadonlyMap<string, string>>,
): RawTemplateResult {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => buildRawLogicTemplate(item, referenceIds, choiceTitlesByFieldRef));
    return {
      value: mapped.map((item) => item.value),
      mappedCount: mapped.reduce((total, item) => total + item.mappedCount, 0),
    };
  }
  if (!value || typeof value !== 'object') return { value, mappedCount: 0 };

  const source = value as JsonObject;
  const result: JsonObject = {};
  let mappedCount = 0;

  let choiceFieldRef: string | null = null;
  if (Array.isArray(source.args)) {
    for (const arg of source.args) {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
      const operand = arg as JsonObject;
      if (operand.type === 'field' && typeof operand.value === 'string') {
        choiceFieldRef = operand.value;
        break;
      }
    }
  }

  for (const [key, child] of Object.entries(source)) {
    if (key === 'identifier' && typeof child === 'string' && referenceIds.has(child)) {
      result[key] = referenceIds.get(child);
      mappedCount++;
      continue;
    }
    if (
      key === 'value'
      && source.type === 'field'
      && typeof child === 'string'
      && referenceIds.has(child)
    ) {
      result[key] = referenceIds.get(child);
      mappedCount++;
      continue;
    }
    if (key === 'args' && Array.isArray(child) && choiceFieldRef) {
      const titles = choiceTitlesByFieldRef.get(choiceFieldRef);
      const targetFieldId = referenceIds.get(choiceFieldRef);
      const mappedArgs = child.map((arg) => {
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          const operand = arg as JsonObject;
          if (
            operand.type === 'choice'
            && typeof operand.value === 'string'
            && titles?.has(operand.value)
            && targetFieldId
          ) {
            mappedCount++;
            return {
              ...operand,
              value: titles.get(operand.value),
              __harnessChoiceFieldId: targetFieldId,
            };
          }
        }
        const mapped = buildRawLogicTemplate(arg, referenceIds, choiceTitlesByFieldRef);
        mappedCount += mapped.mappedCount;
        return mapped.value;
      });
      result[key] = mappedArgs;
      continue;
    }
    const mapped = buildRawLogicTemplate(child, referenceIds, choiceTitlesByFieldRef);
    result[key] = mapped.value;
    mappedCount += mapped.mappedCount;
  }

  return { value: result, mappedCount };
}

/**
 * Copy the user-owned form definition while replacing every internal identity.
 * Provider identities and external choice URLs are intentionally removed.
 */
export function duplicateFormDefinition(
  definitionJson: string,
  sourceFieldSlugsById: ReadonlyMap<string, string> = new Map(),
): DuplicatedFormDefinition {
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

  const sourceChoiceTitlesById = new Map<string, Map<string, string>>();
  for (const sourceField of sourceFields) {
    if (typeof sourceField.id !== 'string') continue;
    const config = sourceField.config && typeof sourceField.config === 'object' && !Array.isArray(sourceField.config)
      ? sourceField.config as JsonObject
      : {};
    sourceChoiceTitlesById.set(sourceField.id, choiceTitles(config));
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
    sanitizeMatrixIdentity(config);

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
    const sourceFieldId = typeof sourceRule.sourceFieldId === 'string' ? sourceRule.sourceFieldId : '';
    if (typeof rule.value === 'string') {
      rule.value = sourceChoiceTitlesById.get(sourceFieldId)?.get(rule.value) ?? rule.value;
    }
    rule.sourceFieldId = remapReference(rule.sourceFieldId, ids);
    rule.targetFieldId = remapReference(rule.targetFieldId, ids);
    if (Array.isArray(rule.conditions)) {
      rule.conditions = rule.conditions.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const condition = { ...(value as JsonObject) };
        const conditionSourceId = typeof condition.sourceFieldId === 'string' ? condition.sourceFieldId : '';
        if (typeof condition.value === 'string') {
          condition.value = sourceChoiceTitlesById.get(conditionSourceId)?.get(condition.value) ?? condition.value;
        }
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
  // Provider raw logic can be retained only as an internal-ID template. It is
  // rehydrated with the copied form's new field/choice slugs on first push.
  const referenceIds = new Map<string, string>();
  const choiceTitlesByFieldRef = new Map<string, ReadonlyMap<string, string>>();
  for (const [sourceId, targetId] of ids) {
    referenceIds.set(sourceId, targetId);
    const remoteSlug = sourceFieldSlugsById.get(sourceId);
    if (remoteSlug) referenceIds.set(remoteSlug, targetId);
    const titles = sourceChoiceTitlesById.get(sourceId);
    if (titles) {
      choiceTitlesByFieldRef.set(sourceId, titles);
      if (remoteSlug) choiceTitlesByFieldRef.set(remoteSlug, titles);
    }
  }
  for (const sourcePage of sourcePages) {
    if (
      typeof sourcePage.slug === 'string'
      && typeof sourcePage.id === 'string'
      && ids.has(sourcePage.id)
    ) {
      referenceIds.set(sourcePage.slug, ids.get(sourcePage.id)!);
    }
  }
  const rawTemplate = buildRawLogicTemplate(source.rawLogic, referenceIds, choiceTitlesByFieldRef);

  // These values bind the cache to the source provider form.
  delete definition.formalooAddress;
  delete definition.rawLogic;
  delete definition.logicFingerprint;
  delete definition.rawLogicTemplate;
  if (Array.isArray(rawTemplate.value) && rawTemplate.mappedCount > 0) {
    definition.rawLogicTemplate = rawTemplate.value;
    definition.logicFingerprint = logicFingerprint(logic);
  }

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
