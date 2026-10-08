import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

export interface InstructionModeCallbacks {
  onSubmit: (rawInstruction: string) => Promise<void>;
  getInputWrapper: () => HTMLElement | null;
  /**
   * Decides whether an Enter keydown submits (mirrors the composer's send
   * shortcut rules, including requireCommandOrControlEnterToSend).
   */
  shouldSubmitOnEnter: (event: KeyboardEvent) => boolean;
  /**
   * Re-resolves the composer placeholder for the current destination; the
   * manager never caches one because side chat swaps it per destination.
   */
  restorePlaceholder: () => void;
}

export interface InstructionModeState {
  active: boolean;
  rawInstruction: string;
}

/**
 * Composer instruction mode: `#` in an empty input arms refinement, Enter submits
 * the raw text for polishing, Escape cancels. The manager owns only mode state,
 * the wrapper indicator class, and the mode placeholder; refinement lives in the
 * submission controller and placeholder restoration is delegated to the owner,
 * which re-resolves it for the current composer destination.
 */
export class InstructionModeManager {
  private state: InstructionModeState = { active: false, rawInstruction: '' };
  private isSubmitting = false;
  /**
   * The CodeMirror composer inserts typed text from `beforeinput`, where a
   * consumed keydown cannot stop it; suppress the trigger `#` character there.
   */
  private awaitingTriggerInsertion = false;
  /** Bounds `awaitingTriggerInsertion` when no `beforeinput` ever arrives. */
  private awaitingTriggerResetTimer: number | null = null;
  private readonly onBeforeInput = (event: InputEvent): void => {
    if (!this.awaitingTriggerInsertion) return;
    this.awaitingTriggerInsertion = false;
    if (event.inputType === 'insertText' && event.data === '#') {
      event.preventDefault();
    }
  };

  constructor(
    private readonly inputEl: ComposerInputElement,
    private readonly placeholder: string,
    private readonly callbacks: InstructionModeCallbacks,
  ) {
    inputEl.addEventListener('beforeinput', this.onBeforeInput, true);
  }

  /**
   * Detects the `#` trigger on an empty input. Returns true when the event was
   * consumed and instruction mode entered.
   */
  handleTriggerKey(event: KeyboardEvent): boolean {
    // Check !event.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (this.state.active || this.inputEl.value !== '' || event.key !== '#' || event.isComposing) {
      return false;
    }
    if (!this.enterMode()) {
      return false;
    }
    this.awaitingTriggerInsertion = true;
    // The browser may skip `beforeinput` for a prevented keydown; never let the
    // suppression survive past this key's default action.
    this.awaitingTriggerResetTimer = window.setTimeout(() => {
      this.awaitingTriggerInsertion = false;
      this.awaitingTriggerResetTimer = null;
    }, 0);
    event.preventDefault();
    return true;
  }

  /** Tracks the raw instruction text; empty text exits the mode. */
  handleInputChange(): void {
    if (!this.state.active) return;

    const text = this.inputEl.value;
    if (text === '') {
      this.deactivate();
    } else {
      this.state.rawInstruction = text;
    }
  }

  /** Handles Enter/Escape while active. Returns true when handled. */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.state.active) return false;

    // Check !event.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing
      && this.callbacks.shouldSubmitOnEnter(event)) {
      if (!this.state.rawInstruction.trim()) {
        return false;
      }
      event.preventDefault();
      void this.submit();
      return true;
    }

    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      // Keep the typed draft: the user may still send it as a plain message.
      this.deactivate();
      return true;
    }

    return false;
  }

  isActive(): boolean {
    return this.state.active;
  }

  getRawInstruction(): string {
    return this.state.rawInstruction;
  }

  /** Exits the mode without touching the input text. */
  deactivate(): void {
    const wasActive = this.state.active;
    const wrapper = this.callbacks.getInputWrapper();
    wrapper?.removeClass('claudian-input-instruction-mode');
    this.state = { active: false, rawInstruction: '' };
    if (wasActive) {
      this.callbacks.restorePlaceholder();
    }
  }

  destroy(): void {
    this.inputEl.removeEventListener('beforeinput', this.onBeforeInput, true);
    if (this.awaitingTriggerResetTimer !== null) {
      window.clearTimeout(this.awaitingTriggerResetTimer);
      this.awaitingTriggerResetTimer = null;
    }
    this.deactivate();
  }

  private enterMode(): boolean {
    // Indicator is the single source of truth - only enter mode if we can show it.
    const wrapper = this.callbacks.getInputWrapper();
    if (!wrapper) return false;

    wrapper.addClass('claudian-input-instruction-mode');
    this.state = { active: true, rawInstruction: '' };
    this.inputEl.placeholder = this.placeholder;
    return true;
  }

  private async submit(): Promise<void> {
    if (this.isSubmitting) return;

    const rawInstruction = this.state.rawInstruction.trim();
    if (!rawInstruction) return;

    this.isSubmitting = true;
    try {
      await this.callbacks.onSubmit(rawInstruction);
    } finally {
      this.isSubmitting = false;
    }
  }
}
