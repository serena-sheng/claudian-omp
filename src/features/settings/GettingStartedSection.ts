import { Setting } from 'obsidian';

import { t } from '@/i18n/i18n';

const STEPS = ['install', 'provider', 'chat'] as const;

/** Three-step orientation for a first run: where the pieces live, in order. */
export function renderGettingStartedSection(container: HTMLElement): void {
  for (const step of STEPS) {
    new Setting(container)
      .setName(t(`settings.gettingStarted.${step}.name`))
      .setDesc(t(`settings.gettingStarted.${step}.desc`));
  }
}
