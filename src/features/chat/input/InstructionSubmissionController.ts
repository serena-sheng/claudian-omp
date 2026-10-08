import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type {
  InstructionRefineResult,
  InstructionRefineService,
  ProviderId,
} from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { InstructionModeManager } from '@/features/chat/composer/InstructionModeManager';
import { t } from '@/i18n/i18n';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';
import { InstructionRefineModal } from '@/shared/modals/InstructionRefineModal';

export interface InstructionSubmissionControllerDeps {
  plugin: ChatFeatureHost;
  getInputEl: () => ComposerInputElement;
  getInstructionModeManager: () => InstructionModeManager | null;
  getTabProviderId: () => ProviderId | null;
  getModelOverride: () => string | undefined;
  /** Returns true when the provider execution environment is ready. */
  ensureExecutionInitialized: () => Promise<boolean>;
}

/** Providers spell cancellation variously ('Cancelled', 'cancelled', 'canceled'). */
function isRefineCancellation(message: string | undefined): boolean {
  const normalized = message?.trim().toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled';
}

/**
 * Coordinates composer instruction refinement: opens the refine modal, drives the
 * provider's auxiliary refine conversation, and backfills the accepted prompt into
 * the composer. The refined text is sent through the ordinary composer submit path.
 */
export class InstructionSubmissionController {
  #refineService: { providerId: ProviderId; service: InstructionRefineService } | null = null;
  /** Modal opened by the in-flight submit(); reachable so cancel() can close it. */
  #activeModal: InstructionRefineModal | null = null;

  constructor(private readonly deps: InstructionSubmissionControllerDeps) {}

  async submit(rawInstruction: string): Promise<void> {
    const modeManager = this.deps.getInstructionModeManager();
    if (!await this.deps.ensureExecutionInitialized()) {
      new Notice(t('chat.instructionMode.initFailed'));
      return;
    }

    const providerId = this.deps.getTabProviderId();
    if (!providerId) {
      new Notice(t('chat.selectAvailableModel'));
      return;
    }

    const service = this.#getRefineService(providerId);
    if (!service) {
      new Notice(t('chat.instructionMode.unsupportedProvider'));
      modeManager?.deactivate();
      return;
    }

    let wasCancelled = false;
    try {
      const modal = new InstructionRefineModal(this.deps.plugin.app, rawInstruction, {
        onAccept: finalInstruction => {
          this.#activeModal = null;
          service.cancel();
          const inputEl = this.deps.getInputEl();
          modeManager?.deactivate();
          inputEl.value = finalInstruction;
          inputEl.focus();
          new Notice(t('chat.instructionMode.applied'));
        },
        onReject: () => {
          this.#activeModal = null;
          wasCancelled = true;
          service.cancel();
          // Keep the draft: the user may still send it as a plain message.
          modeManager?.deactivate();
        },
        onClarificationSubmit: async response => {
          service.setModelOverride?.(this.deps.getModelOverride());
          const result = await service.continueConversation(response);
          if (wasCancelled) return;
          this.#presentResult(result, modal, service, modeManager);
        },
      });
      this.#activeModal = modal;
      modal.open();

      service.setModelOverride?.(this.deps.getModelOverride());
      service.resetConversation();
      const result = await service.refineInstruction(rawInstruction);
      if (wasCancelled) return;
      this.#presentResult(result, modal, service, modeManager);
    } catch (error) {
      service.cancel();
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (isRefineCancellation(message)) return;
      new Notice(t('chat.instructionMode.failed', { error: message }));
      this.#activeModal?.showError();
      modeManager?.deactivate();
    }
  }

  /** Releases a parked refine conversation and closes its modal (tab teardown). */
  cancel(): void {
    this.#refineService?.service.cancel();
    // Closing an unresolved modal triggers onReject, which keeps the draft.
    const modal = this.#activeModal;
    this.#activeModal = null;
    modal?.close();
  }

  #getRefineService(providerId: ProviderId): InstructionRefineService | null {
    if (this.#refineService && this.#refineService.providerId !== providerId) {
      this.#refineService.service.cancel();
      this.#refineService = null;
    }
    if (!this.#refineService) {
      const service = ProviderRegistry.createInstructionRefineService(
        this.deps.plugin.providerHost,
        providerId,
      );
      if (!service) return null;
      this.#refineService = { providerId, service };
    }
    return this.#refineService.service;
  }

  #presentResult(
    result: InstructionRefineResult,
    modal: InstructionRefineModal | null,
    service: InstructionRefineService,
    modeManager: InstructionModeManager | null,
  ): void {
    if (!result.success) {
      if (isRefineCancellation(result.error)) return;
      service.cancel();
      const message = result.error || t('chat.instructionMode.failed', { error: 'Unknown error' });
      new Notice(message);
      modal?.showError();
      modeManager?.deactivate();
      return;
    }
    if (result.clarification) {
      modal?.showClarification(result.clarification);
    } else if (result.refinedInstruction) {
      modal?.showConfirmation(result.refinedInstruction);
    } else {
      service.cancel();
      new Notice(t('chat.instructionMode.noResult'));
      modal?.showError();
      modeManager?.deactivate();
    }
  }
}
