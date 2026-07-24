function scriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Native form navigation keeps the page alive until the response arrives, so
 * lock the submit event synchronously and let the response page reset the UI.
 */
export function renderInternalFormSubmitLock(pendingLabel: string): string {
  return `<script data-internal-form-submit-lock>
  (() => {
    const form = document.querySelector('form');
    if (!form) return;
    let submitting = false;
    form.addEventListener('submit', (event) => {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      const button = form.querySelector('button[type="submit"]');
      if (!button) return;
      button.disabled = true;
      button.textContent = ${scriptString(pendingLabel)};
    });
  })();
  </script>`;
}
