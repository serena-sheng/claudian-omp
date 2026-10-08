import { Setting } from 'obsidian';

import { t } from '@/i18n/i18n';

/**
 * Points at where command hotkeys are bound rather than reading them back.
 * Obsidian's `hotkeyManager` is not part of the public API, and this codebase
 * deliberately uses only supported APIs — so this stays a signpost.
 */
export function renderHotkeysSection(container: HTMLElement): void {
  new Setting(container).setDesc(t('settings.hotkeys.desc'));
}
