import type { ProviderCapabilities } from '../../core/providers/types';

export const DSH_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'dsh',
  supportsResponseThroughput: false,
  // dsh transcripts are zstd-compressed v4 JSONL under $DSH_HOME/sessions; the
  // event schema is not public, so native history reading is not implemented.
  supportsNativeHistory: false,
  supportsEphemeralSessions: false,
  // No native checkpoint/fork support: dsh implements neither session/fork nor rewind.
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: true,
  // dsh initialize reports promptCapabilities { image: false, audio: false, embeddedContext: false }.
  supportsImageAttachments: false,
  // Turn steering relies on Grok-specific _meta hooks; dsh has no documented equivalent.
  supportsTurnSteer: false,
  // dsh exposes no reasoning/effort config options; never fabricate effort choices.
  reasoningControl: 'none',
});
