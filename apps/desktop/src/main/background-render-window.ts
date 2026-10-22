import type { BrowserWindow } from 'electron';

/** Keep the export compositor painting without intercepting desktop input. */
export function showBackgroundRenderWindow(window: BrowserWindow): void {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  if (process.platform === 'darwin' || process.platform === 'win32') window.setFocusable(false);
  if (process.platform === 'darwin') window.setHiddenInMissionControl(true);
  window.showInactive();
}
