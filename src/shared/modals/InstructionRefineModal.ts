import type { App } from 'obsidian';
import { Modal, TextAreaComponent } from 'obsidian';

import { t } from '@/i18n/i18n';

type ModalState = 'loading' | 'clarification' | 'confirmation';

export interface InstructionRefineModalCallbacks {
  /** Receives the final (possibly user-edited) refined prompt. */
  onAccept: (finalInstruction: string) => void;
  onReject: () => void;
  onClarificationSubmit: (response: string) => Promise<void>;
}

/**
 * Unified modal for composer instruction refinement: loading while the provider
 * refines, clarification when it asks back, confirmation with inline editing of
 * the refined prompt.
 */
export class InstructionRefineModal extends Modal {
  private state: ModalState = 'loading';
  private resolved = false;

  private contentSectionEl: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private clarificationEl: HTMLElement | null = null;
  private confirmationEl: HTMLElement | null = null;
  private buttonsEl: HTMLElement | null = null;

  private clarificationTextEl: HTMLElement | null = null;
  private responseTextarea: TextAreaComponent | null = null;
  private isSubmitting = false;

  private refinedInstruction = '';
  private editTextarea: TextAreaComponent | null = null;
  private isEditing = false;
  private refinedDisplayEl: HTMLElement | null = null;
  private editContainerEl: HTMLElement | null = null;
  private editBtnEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly rawInstruction: string,
    private readonly callbacks: InstructionRefineModalCallbacks,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('claudian-instruction-modal');
    this.setTitle(t('chat.instructionMode.modal.title'));

    const inputSection = contentEl.createDiv({ cls: 'claudian-instruction-section' });
    inputSection.createDiv({ cls: 'claudian-instruction-label' })
      .setText(t('chat.instructionMode.modal.yourInput'));
    inputSection.createDiv({ cls: 'claudian-instruction-original' })
      .setText(this.rawInstruction);

    this.contentSectionEl = contentEl.createDiv({ cls: 'claudian-instruction-content-section' });

    this.loadingEl = this.contentSectionEl.createDiv({ cls: 'claudian-instruction-loading' });
    this.loadingEl.createDiv({ cls: 'claudian-instruction-spinner' });
    this.loadingEl.createSpan({ text: t('chat.instructionMode.modal.processing') });

    this.clarificationEl = this.contentSectionEl.createDiv({ cls: 'claudian-instruction-clarification-section' });
    this.clarificationEl.addClass('claudian-hidden');
    this.clarificationTextEl = this.clarificationEl.createDiv({ cls: 'claudian-instruction-clarification' });

    const responseSection = this.clarificationEl.createDiv({ cls: 'claudian-instruction-section' });
    responseSection.createDiv({ cls: 'claudian-instruction-label' })
      .setText(t('chat.instructionMode.modal.yourResponse'));

    this.responseTextarea = new TextAreaComponent(responseSection);
    this.responseTextarea.inputEl.addClass('claudian-instruction-response-textarea');
    this.responseTextarea.inputEl.rows = 3;
    this.responseTextarea.inputEl.placeholder = t('chat.instructionMode.modal.responsePlaceholder');

    this.responseTextarea.inputEl.addEventListener('keydown', (event) => {
      // Check !event.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this.isSubmitting) {
        event.preventDefault();
        void this.submitClarification();
      }
    });

    this.confirmationEl = this.contentSectionEl.createDiv({ cls: 'claudian-instruction-confirmation-section' });
    this.confirmationEl.addClass('claudian-hidden');

    const refinedSection = this.confirmationEl.createDiv({ cls: 'claudian-instruction-section' });
    refinedSection.createDiv({ cls: 'claudian-instruction-label' })
      .setText(t('chat.instructionMode.modal.refinedPrompt'));

    this.refinedDisplayEl = refinedSection.createDiv({ cls: 'claudian-instruction-refined' });
    this.editContainerEl = refinedSection.createDiv({ cls: 'claudian-instruction-edit-container' });
    this.editContainerEl.addClass('claudian-hidden');

    this.editTextarea = new TextAreaComponent(this.editContainerEl);
    this.editTextarea.inputEl.addClass('claudian-instruction-edit-textarea');
    this.editTextarea.inputEl.rows = 4;

    this.buttonsEl = contentEl.createDiv({ cls: 'claudian-instruction-buttons' });
    this.updateButtons();

    this.showState('loading');
  }

  showClarification(clarification: string): void {
    this.clarificationTextEl?.setText(clarification);
    this.responseTextarea?.setValue('');
    this.isSubmitting = false;
    this.showState('clarification');
    this.responseTextarea?.inputEl.focus();
  }

  showConfirmation(refinedInstruction: string): void {
    this.refinedInstruction = refinedInstruction;
    this.refinedDisplayEl?.setText(refinedInstruction);
    this.editTextarea?.setValue(refinedInstruction);
    this.showState('confirmation');
  }

  /** Closes without a resolution callback; the caller reports the error itself. */
  showError(): void {
    this.resolved = true;
    this.close();
  }

  showClarificationLoading(): void {
    this.isSubmitting = true;
    const text = this.loadingEl?.querySelector('span');
    if (text) {
      text.textContent = t('chat.instructionMode.modal.processing');
    }
    this.showState('loading');
  }

  private showState(state: ModalState): void {
    this.state = state;
    this.loadingEl?.toggleClass('claudian-hidden', state !== 'loading');
    this.clarificationEl?.toggleClass('claudian-hidden', state !== 'clarification');
    this.confirmationEl?.toggleClass('claudian-hidden', state !== 'confirmation');
    this.updateButtons();
  }

  private updateButtons(): void {
    if (!this.buttonsEl) return;
    this.buttonsEl.empty();

    const cancelBtn = this.buttonsEl.createEl('button', {
      text: t('common.cancel'),
      cls: 'claudian-instruction-btn claudian-instruction-reject-btn',
      attr: { 'aria-label': t('common.cancel') },
    });
    cancelBtn.addEventListener('click', () => this.handleReject());

    if (this.state === 'clarification') {
      const submitBtn = this.buttonsEl.createEl('button', {
        text: t('chat.instructionMode.modal.submit'),
        cls: 'claudian-instruction-btn claudian-instruction-accept-btn',
        attr: { 'aria-label': t('chat.instructionMode.modal.submit') },
      });
      submitBtn.addEventListener('click', () => {
        void this.submitClarification();
      });
    } else if (this.state === 'confirmation') {
      this.editBtnEl = this.buttonsEl.createEl('button', {
        text: t('common.edit'),
        cls: 'claudian-instruction-btn claudian-instruction-edit-btn',
        attr: { 'aria-label': t('common.edit') },
      });
      this.editBtnEl.addEventListener('click', () => this.toggleEdit());

      const acceptBtn = this.buttonsEl.createEl('button', {
        text: t('chat.instructionMode.modal.accept'),
        cls: 'claudian-instruction-btn claudian-instruction-accept-btn',
        attr: { 'aria-label': t('chat.instructionMode.modal.accept') },
      });
      acceptBtn.addEventListener('click', () => this.handleAccept());
      acceptBtn.focus();
    }
  }

  private async submitClarification(): Promise<void> {
    const response = this.responseTextarea?.getValue().trim();
    if (!response || this.isSubmitting) return;

    this.showClarificationLoading();

    try {
      await this.callbacks.onClarificationSubmit(response);
    } catch {
      this.isSubmitting = false;
      this.showState('clarification');
    }
  }

  private toggleEdit(): void {
    this.isEditing = !this.isEditing;

    if (this.isEditing) {
      this.refinedDisplayEl?.addClass('claudian-hidden');
      this.editContainerEl?.removeClass('claudian-hidden');
      this.editBtnEl?.setText(t('chat.instructionMode.modal.preview'));
      this.editTextarea?.inputEl.focus();
    } else {
      const edited = this.editTextarea?.getValue() || this.refinedInstruction;
      this.refinedInstruction = edited;
      if (this.refinedDisplayEl) {
        this.refinedDisplayEl.setText(edited);
        this.refinedDisplayEl.removeClass('claudian-hidden');
      }
      this.editContainerEl?.addClass('claudian-hidden');
      this.editBtnEl?.setText(t('common.edit'));
    }
  }

  private handleAccept(): void {
    if (this.resolved) return;
    this.resolved = true;

    const finalInstruction = this.isEditing
      ? (this.editTextarea?.getValue() || this.refinedInstruction)
      : this.refinedInstruction;

    this.callbacks.onAccept(finalInstruction);
    this.close();
  }

  private handleReject(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.callbacks.onReject();
    this.close();
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.callbacks.onReject();
    }
    this.contentEl.empty();
  }
}
