import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '../../core/providers/types';

/**
 * dsh has no native mode switch (no `session/set_mode`, no mode config option),
 * so permission modes are enforced client-side: Ask routes every permission
 * prompt to the user; Accept edits auto-approves edit-kind prompts.
 */
export const DSH_PERMISSION_MODES = ['normal', 'acceptEdits'] as const;
export type DshPermissionMode = typeof DSH_PERMISSION_MODES[number];

export const DSH_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: DSH_PERMISSION_MODES,
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

export const DSH_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'normal', label: 'Ask', description: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Automatically accept file edits' },
]);

export function shouldAutoApproveDshPermission(
  permissionMode: string | undefined,
  toolKind: string | null | undefined,
): boolean {
  return permissionMode === 'acceptEdits' && toolKind === 'edit';
}
