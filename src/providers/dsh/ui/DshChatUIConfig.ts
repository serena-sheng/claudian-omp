import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { DSH_PROVIDER_ICON } from '../../../shared/icons';
import { dshModelPolicy } from '../DshModelPolicy';
import { DSH_PERMISSION_MODE_OPTIONS } from '../permissionModes';

export const dshChatUIConfig: ProviderChatUIConfig = {
  ...dshModelPolicy,
  getPermissionModeOptions() {
    return DSH_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return DSH_PROVIDER_ICON;
  },
};
