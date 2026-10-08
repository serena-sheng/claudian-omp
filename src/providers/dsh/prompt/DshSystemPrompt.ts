import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

export type DshSystemPromptSettings = SystemPromptSettings;

export function buildDshSystemPrompt(settings: DshSystemPromptSettings): string {
  return buildSystemPrompt(settings);
}
