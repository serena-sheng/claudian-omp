import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { OMP_PROVIDER_ICON } from '../../../shared/icons';
import { ompModelPolicy } from '../OmpModelPolicy';

export const ompChatUIConfig: ProviderChatUIConfig = {
  ...ompModelPolicy,
  getModeSelector(): null {
    return null;
  },
  getPermissionModeOptions() {
    return [
      {
        value: 'always-ask',
        label: 'Always ask',
        description: 'Ask before running commands or making file changes.',
      },
      {
        value: 'write',
        label: 'Write',
        description: 'Allow file writes; ask before other actions.',
      },
      {
        value: 'yolo',
        label: 'YOLO',
        bypassesApprovals: true,
        description: 'Auto-approve all tool calls. Use with care.',
      },
    ];
  },
  getProviderIcon() {
    return OMP_PROVIDER_ICON;
  },
};
