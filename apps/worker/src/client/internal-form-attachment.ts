export interface InternalFormAttachmentLimits {
  accept: string;
  maxFiles: number;
  maxSizeKb?: number;
  existingFiles?: number;
}

export interface InternalFormAttachmentUpdate {
  files: File[];
  errors: string[];
}

function matchesAccept(file: File, accept: string): boolean {
  const rules = accept.split(',').map((rule) => rule.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

function acceptLabel(accept: string): string {
  return accept.split(',').map((rule) => rule.trim()).filter(Boolean).join('、');
}

export function addInternalFormAttachmentFiles(
  current: readonly File[],
  incoming: readonly File[],
  limits: InternalFormAttachmentLimits,
): InternalFormAttachmentUpdate {
  const files = [...current];
  const errors: string[] = [];
  const existingFiles = Number.isSafeInteger(limits.existingFiles) && (limits.existingFiles ?? 0) > 0
    ? limits.existingFiles ?? 0
    : 0;
  for (const file of incoming) {
    if (!matchesAccept(file, limits.accept)) {
      errors.push(`${file.name}：追加できる形式は ${acceptLabel(limits.accept)} です`);
      continue;
    }
    if (limits.maxSizeKb !== undefined && file.size > limits.maxSizeKb * 1024) {
      errors.push(`${file.name}：ファイルサイズは${limits.maxSizeKb}KB以下にしてください`);
      continue;
    }
    if (existingFiles + files.length >= limits.maxFiles) {
      errors.push(`${file.name}：添付できるファイルは最大${limits.maxFiles}件です`);
      continue;
    }
    files.push(file);
  }
  return { files, errors };
}

export function removeInternalFormAttachmentFile(files: readonly File[], index: number): File[] {
  return files.filter((_file, fileIndex) => fileIndex !== index);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  const rounded = value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${unit}`;
}

function fileIcon(file: File): string {
  const extension = file.name.match(/\.([^.]+)$/)?.[1];
  if (extension) return extension.toUpperCase().slice(0, 5);
  const subtype = file.type.split('/')[1];
  return subtype ? subtype.toUpperCase().slice(0, 5) : 'FILE';
}

function replaceInputFiles(input: HTMLInputElement, files: readonly File[]): boolean {
  try {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    const assigned = Array.from(input.files ?? []);
    return assigned.length === files.length && assigned.every((file, index) => {
      const expected = files[index];
      return expected !== undefined
        && file.name === expected.name
        && file.size === expected.size
        && file.type === expected.type
        && file.lastModified === expected.lastModified;
    });
  } catch {
    return false;
  }
}

export function initInternalFormAttachments(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-file-attachment]').forEach((wrapper) => {
    if (wrapper.dataset.fileAttachmentReady === 'true' || typeof DataTransfer !== 'function') return;
    const input = wrapper.querySelector<HTMLInputElement>('input[type="file"][data-file-input]');
    const list = wrapper.querySelector<HTMLElement>('[data-file-list]');
    const status = wrapper.querySelector<HTMLElement>('[data-file-status]');
    if (!input || !list || !status) return;

    let selectedFiles = Array.from(input.files ?? []);
    if (!replaceInputFiles(input, selectedFiles)) return;
    wrapper.dataset.fileAttachmentReady = 'true';

    const maxFiles = Math.max(1, Number(input.dataset.maxFiles) || 1);
    const parsedMaxSize = Number(input.dataset.maxSizeKb);
    const limits: InternalFormAttachmentLimits = {
      accept: input.accept,
      maxFiles,
      maxSizeKb: Number.isFinite(parsedMaxSize) && parsedMaxSize > 0 ? parsedMaxSize : undefined,
    };
    const retainedFileCount = (): number => Array.from(
      wrapper.querySelectorAll<HTMLInputElement>('[data-existing-file-remove]'),
    ).filter((control) => !control.checked).length;
    const existingRemovalControls = Array.from(
      wrapper.querySelectorAll<HTMLInputElement>('[data-existing-file-remove]'),
    );
    const objectUrls = new Map<File, string>();
    const view = input.ownerDocument.defaultView;
    let handleChange: () => void = () => undefined;
    let handleReset: () => void = () => undefined;
    let handlePageHide: (event: PageTransitionEvent) => void = () => undefined;
    let handleExistingRemovalChange: () => void = () => undefined;

    const releaseFileUrl = (file: File): void => {
      const url = objectUrls.get(file);
      if (!url) return;
      URL.revokeObjectURL(url);
      objectUrls.delete(file);
    };
    const releaseUnusedUrls = (): void => {
      for (const file of objectUrls.keys()) {
        if (!selectedFiles.includes(file)) releaseFileUrl(file);
      }
    };
    const releaseAllUrls = (): void => {
      for (const file of [...objectUrls.keys()]) releaseFileUrl(file);
    };
    const showErrors = (errors: readonly string[]): void => {
      status.textContent = errors.join(' ');
      status.hidden = errors.length === 0;
    };
    const fallbackToNative = (): void => {
      input.removeEventListener('change', handleChange);
      input.form?.removeEventListener('reset', handleReset);
      view?.removeEventListener('pagehide', handlePageHide);
      existingRemovalControls.forEach((control) => (
        control.removeEventListener('change', handleExistingRemovalChange)
      ));
      releaseAllUrls();
      list.replaceChildren();
      showErrors([]);
      wrapper.removeAttribute('data-file-attachment-ready');
    };
    const render = (): void => {
      releaseUnusedUrls();
      const fragment = input.ownerDocument.createDocumentFragment();
      selectedFiles.forEach((file, index) => {
        const item = input.ownerDocument.createElement('li');
        item.className = 'attachment-item';
        item.dataset.fileItem = '';

        if (file.type.toLowerCase().startsWith('image/')) {
          let url = objectUrls.get(file);
          if (!url) {
            try {
              url = URL.createObjectURL(file);
              objectUrls.set(file, url);
            } catch {
              url = undefined;
            }
          }
          if (url) {
            const thumbnail = input.ownerDocument.createElement('img');
            thumbnail.className = 'attachment-thumbnail';
            thumbnail.src = url;
            thumbnail.alt = `${file.name} のプレビュー`;
            item.append(thumbnail);
          } else {
            const icon = input.ownerDocument.createElement('span');
            icon.className = 'attachment-icon';
            icon.dataset.fileIcon = '';
            icon.textContent = 'IMG';
            icon.setAttribute('aria-hidden', 'true');
            item.append(icon);
          }
        } else {
          const icon = input.ownerDocument.createElement('span');
          icon.className = 'attachment-icon';
          icon.dataset.fileIcon = '';
          icon.textContent = fileIcon(file);
          icon.setAttribute('aria-hidden', 'true');
          item.append(icon);
        }

        const details = input.ownerDocument.createElement('span');
        details.className = 'attachment-details';
        const name = input.ownerDocument.createElement('span');
        name.className = 'attachment-name';
        name.dataset.fileName = '';
        name.textContent = file.name;
        const size = input.ownerDocument.createElement('span');
        size.className = 'attachment-size';
        size.textContent = formatFileSize(file.size);
        details.append(name, size);

        const remove = input.ownerDocument.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.dataset.fileRemove = String(index);
        remove.textContent = '削除';
        remove.setAttribute('aria-label', `${file.name} を削除`);
        remove.addEventListener('click', () => {
          const nextFiles = removeInternalFormAttachmentFile(selectedFiles, index);
          if (!replaceInputFiles(input, nextFiles)) {
            fallbackToNative();
            return;
          }
          selectedFiles = nextFiles;
          handleExistingRemovalChange();
          render();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const nextRemove = list.querySelectorAll<HTMLButtonElement>('[data-file-remove]')
            .item(Math.min(index, selectedFiles.length - 1));
          (nextRemove || input).focus();
        });
        item.append(details, remove);
        fragment.append(item);
      });
      list.replaceChildren(fragment);
    };

    handleChange = () => {
      const update = addInternalFormAttachmentFiles(
        selectedFiles,
        Array.from(input.files ?? []),
        { ...limits, existingFiles: retainedFileCount() },
      );
      if (!replaceInputFiles(input, update.files)) {
        fallbackToNative();
        return;
      }
      selectedFiles = update.files;
      showErrors(update.errors);
      render();
    };
    handleReset = () => {
      view?.setTimeout(() => {
        selectedFiles = [];
        if (!replaceInputFiles(input, selectedFiles)) {
          fallbackToNative();
          return;
        }
        showErrors([]);
        render();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, 0);
    };
    handleExistingRemovalChange = () => {
      showErrors(retainedFileCount() + selectedFiles.length > maxFiles
        ? [`添付できるファイルは最大${maxFiles}件です`]
        : []);
    };
    handlePageHide = (event) => {
      if (event.persisted) return;
      releaseAllUrls();
      view?.removeEventListener('pagehide', handlePageHide);
    };
    input.addEventListener('change', handleChange);
    input.form?.addEventListener('reset', handleReset);
    existingRemovalControls.forEach((control) => (
      control.addEventListener('change', handleExistingRemovalChange)
    ));
    view?.addEventListener('pagehide', handlePageHide);
    render();
  });
}
