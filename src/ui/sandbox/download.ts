/** Browser file helpers for the scenario editor: save text as a download, and read a picked text file. Both are no-ops without a DOM. */

/** Starts a download of `text` as `filename` (Blob + object URL + `<a download>`); false without a DOM. */
export function downloadText(filename: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

/** Opens a file picker and resolves with the chosen file's text and size, or null when cancelled or unreadable. */
export function pickTextFile(accept: string): Promise<{ text: string; size: number; name: string } | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (v: { text: string; size: number; name: string } | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      file.text().then(
        (text) => done({ text, size: file.size, name: file.name }),
        () => done(null),
      );
    });
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
