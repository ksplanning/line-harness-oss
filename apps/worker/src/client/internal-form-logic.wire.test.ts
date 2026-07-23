// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initInternalFormAttachments } from './internal-form-attachment.js';

const clientRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(clientRoot, '../../../..');
const publicClientSource = readFileSync(resolve(clientRoot, 'internal-form-logic.ts'), 'utf8');
const previewSource = readFileSync(
  resolve(repoRoot, 'apps/web/src/components/forms-advanced/form-preview.tsx'),
  'utf8',
);
const publicRouteSource = readFileSync(
  resolve(repoRoot, 'apps/worker/src/routes/internal-forms-public.ts'),
  'utf8',
);

function importSourceFor(source: string, symbol: string): string | null {
  const imports = source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g);
  for (const match of imports) {
    const names = match[1].split(',').map((name) => name.trim().replace(/^type\s+/, ''));
    if (names.includes(symbol)) return match[2];
  }
  return null;
}

describe('internal form logic import wire', () => {
  test.each(['evaluateInternalFormLogic', 'nextInternalFormFieldId', 'normalizePostalLookupCode'])(
    'published client and preview import %s from the exact shared engine module',
    (symbol) => {
      expect(importSourceFor(publicClientSource, symbol)).toBe('@line-crm/shared/internal-form-logic');
      expect(importSourceFor(previewSource, symbol)).toBe('@line-crm/shared/internal-form-logic');
    },
  );

  test('public route never serializes shared logic functions into HTML', () => {
    expect(publicRouteSource).not.toContain('evaluateInternalFormLogic.toString()');
    expect(publicRouteSource).not.toContain('nextInternalFormFieldId.toString()');
    expect(publicRouteSource).not.toContain('normalizePostalLookupCode.toString()');
  });

  test('published client imports the attachment enhancement', () => {
    expect(importSourceFor(publicClientSource, 'initInternalFormAttachments'))
      .toBe('./internal-form-attachment.js');
  });
});

class FakeDataTransfer {
  private readonly selected: File[] = [];

  readonly items = {
    add: (file: File) => {
      this.selected.push(file);
      return {} as DataTransferItem;
    },
  };

  get files(): FileList {
    return [...this.selected] as unknown as FileList;
  }
}

function mutableFileInput(input: HTMLInputElement): {
  choose: (...files: File[]) => void;
  files: () => File[];
} {
  let selected: File[] = [];
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => selected as unknown as FileList,
    set: (files: FileList | null) => { selected = Array.from(files ?? []); },
  });
  return {
    choose: (...files) => {
      selected = files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    files: () => [...selected],
  };
}

function mountAttachment(options: {
  maxFiles?: number;
  maxSizeKb?: number;
  accept?: string;
} = {}) {
  const maxFiles = options.maxFiles ?? 10;
  const maxSizeKb = options.maxSizeKb ?? 256;
  const accept = options.accept ?? '.png,.pdf';
  document.body.innerHTML = `<form>
    <div data-file-attachment>
      <input type="file" name="a_0" required multiple accept="${accept}"
        data-file-input data-max-files="${maxFiles}" data-max-size-kb="${maxSizeKb}">
      <p data-file-status aria-live="polite" hidden></p>
      <ul data-file-list aria-live="polite"></ul>
    </div>
  </form>`;
  const wrapper = document.querySelector<HTMLElement>('[data-file-attachment]')!;
  const input = wrapper.querySelector<HTMLInputElement>('[data-file-input]')!;
  const selected = mutableFileInput(input);
  initInternalFormAttachments(document);
  return {
    input,
    list: wrapper.querySelector<HTMLElement>('[data-file-list]')!,
    selected,
    status: wrapper.querySelector<HTMLElement>('[data-file-status]')!,
    wrapper,
  };
}

describe('internal form attachment wire', () => {
  const createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  const revokeObjectURL = vi.fn();
  let createObjectUrlDescriptor: PropertyDescriptor | undefined;
  let revokeObjectUrlDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
    else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
    else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  test('accumulates selections, renders previews, removes one file, and keeps later additions', () => {
    const { input, list, selected, wrapper } = mountAttachment();
    const photo = new File([new Uint8Array(1536)], 'photo.png', { type: 'image/png' });
    const documentFile = new File(['document'], 'guide.pdf', { type: 'application/pdf' });
    const added = new File(['next'], 'added.png', { type: 'image/png' });

    selected.choose(photo, documentFile);

    expect(wrapper.dataset.fileAttachmentReady).toBe('true');
    expect(selected.files().map((file) => file.name)).toEqual(['photo.png', 'guide.pdf']);
    expect(list.querySelectorAll('[data-file-item]')).toHaveLength(2);
    expect(list.querySelector<HTMLImageElement>('img')?.src).toBe('blob:photo.png');
    expect(list.querySelector<HTMLImageElement>('img')?.alt).toBe('photo.png のプレビュー');
    expect(list.querySelector('[data-file-icon]')?.textContent).toBe('PDF');
    expect(list.textContent).toContain('photo.png');
    expect(list.textContent).toContain('1.5 KB');
    expect(list.textContent).toContain('guide.pdf');

    list.querySelector<HTMLButtonElement>('[data-file-remove="0"]')!.click();

    expect(selected.files().map((file) => file.name)).toEqual(['guide.pdf']);
    expect(list.textContent).not.toContain('photo.png');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo.png');
    expect(document.activeElement).toBe(list.querySelector('[data-file-remove="0"]'));

    selected.choose(added);

    expect(selected.files().map((file) => file.name)).toEqual(['guide.pdf', 'added.png']);
    expect(Array.from(list.querySelectorAll('[data-file-name]')).map((node) => node.textContent))
      .toEqual(['guide.pdf', 'added.png']);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    const multipart = new FormData();
    for (const file of Array.from(input.files ?? [])) multipart.append(input.name, file);
    expect(multipart.getAll('a_0').map((entry) => (entry as File).name))
      .toEqual(['guide.pdf', 'added.png']);
  });

  test('rejects count, size, and accept violations with clear Japanese feedback', () => {
    const { selected, status } = mountAttachment({ maxFiles: 2, maxSizeKb: 1, accept: '.pdf' });
    const first = new File(['first'], 'first.pdf', { type: 'application/pdf' });
    selected.choose(first);

    selected.choose(
      new File([new Uint8Array(1025)], 'large.pdf', { type: 'application/pdf' }),
      new File(['bad'], 'blocked.exe', { type: 'application/octet-stream' }),
      new File(['second'], 'second.pdf', { type: 'application/pdf' }),
      new File(['third'], 'third.pdf', { type: 'application/pdf' }),
    );

    expect(selected.files().map((file) => file.name)).toEqual(['first.pdf', 'second.pdf']);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('large.pdf：ファイルサイズは1KB以下にしてください');
    expect(status.textContent).toContain('blocked.exe：追加できる形式は .pdf です');
    expect(status.textContent).toContain('third.pdf：添付できるファイルは最大2件です');
  });

  test('leaves the native file input untouched when DataTransfer is unavailable', () => {
    vi.stubGlobal('DataTransfer', undefined);
    const { input, list, selected, wrapper } = mountAttachment({ maxFiles: 1, accept: '.pdf' });
    const nativeFile = new File(['native'], 'native.pdf', { type: 'application/pdf' });

    selected.choose(nativeFile);

    expect(wrapper.dataset.fileAttachmentReady).toBeUndefined();
    expect(selected.files()).toEqual([nativeFile]);
    expect(input.name).toBe('a_0');
    expect(input.required).toBe(true);
    expect(input.accept).toBe('.pdf');
    expect(list.children).toHaveLength(0);
  });

  test('falls back completely when a non-empty DataTransfer cannot be assigned', () => {
    class FailingDataTransfer {
      readonly items = { add: () => { throw new Error('unsupported file assignment'); } };
      get files(): FileList { return [] as unknown as FileList; }
    }
    vi.stubGlobal('DataTransfer', FailingDataTransfer);
    const { list, selected, status, wrapper } = mountAttachment({ accept: '.pdf' });
    const first = new File(['first'], 'first.pdf', { type: 'application/pdf' });
    const replacement = new File(['replacement'], 'replacement.pdf', { type: 'application/pdf' });

    selected.choose(first);

    expect(wrapper.dataset.fileAttachmentReady).toBeUndefined();
    expect(selected.files()).toEqual([first]);
    expect(list.children).toHaveLength(0);
    expect(status.hidden).toBe(true);

    selected.choose(replacement);
    expect(selected.files()).toEqual([replacement]);
    expect(list.children).toHaveLength(0);
  });
});
