/** Open a URL in the user's default browser. Uses Electron shell when
 * available, falls back to window.open. */
export function openUrl(url: string): void {
  try {
    const { shell } = require('electron') as { shell: { openExternal: (u: string) => void } };
    shell.openExternal(url);
  } catch {
    window.open(url, '_blank');
  }
}
