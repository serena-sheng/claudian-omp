import { t } from '@/i18n/i18n';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

export interface BangBashModeCallbacks {
  /** Bash mode is opt-in; the trigger stays inert while the feature is off. */
  isEnabled: () => boolean;
  /** Runs the raw command through the tab's transcript channel. */
  onSubmit: (command: string) => Promise<void>;
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

export interface BangBashModeState {
  active: boolean;
  rawCommand: string;
}

/**
 * Composer bash mode: `!` in an empty input arms a local shell command, Enter
 * runs it, Escape abandons it. The manager owns only the mode state, the
 * wrapper indicator class, and the mode placeholder; execution and transcript
 * rendering belong to the runner, and placeholder restoration is delegated to
 * the owner, which re-resolves it for the current composer destination.
 */
export class BangBashModeManager {
  private state: BangBashModeState = { active: false, rawCommand: '' };
  private isSubmitting = false;
  /**
   * The CodeMirror composer inserts typed text from `beforeinput`, where a
   * consumed keydown cannot stop it; suppress the trigger `!` character there.
   */
  private awaitingTriggerInsertion = false;
  /** Bounds `awaitingTriggerInsertion` when no `beforeinput` ever arrives. */
  private awaitingTriggerResetTimer: number | null = null;
  private readonly onBeforeInput = (event: InputEvent): void => {
    if (!this.awaitingTriggerInsertion) return;
    this.awaitingTriggerInsertion = false;
    if (event.inputType === 'insertText' && event.data === '!') {
      event.preventDefault();
    }
  };

  constructor(
    private readonly inputEl: ComposerInputElement,
    private readonly callbacks: BangBashModeCallbacks,
  ) {
    inputEl.addEventListener('beforeinput', this.onBeforeInput, true);
  }

  /**
   * Detects the `!` trigger on an empty input. Returns true when the event was
   * consumed and bash mode entered.
   */
  handleTriggerKey(event: KeyboardEvent): boolean {
    // Check !event.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (!this.callbacks.isEnabled()
      || this.state.active
      || this.inputEl.value !== ''
      || event.key !== '!'
      || event.isComposing) {
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

  /** Tracks the raw command text; the mode keeps its placeholder until it exits. */
  handleInputChange(): void {
    if (!this.state.active) return;
    this.state.rawCommand = this.inputEl.value;
  }

  /** Handles Enter/Escape while active. Returns true when handled. */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.state.active) return false;

    // Check !event.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      this.clear();
      return true;
    }

    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return false;
    }

    if (!this.state.rawCommand.trim()) {
      // An armed empty command never falls through to the composer's send path.
      event.preventDefault();
      return true;
    }

    if (!this.callbacks.shouldSubmitOnEnter(event)) {
      return false;
    }

    event.preventDefault();
    void this.submit();
    return true;
  }

  isActive(): boolean {
    return this.state.active;
  }

  getRawCommand(): string {
    return this.state.rawCommand;
  }

  /** Abandons the mode and empties the composer, so a command is never sent as a prompt. */
  clear(): void {
    this.inputEl.value = '';
    this.exitMode();
  }

  destroy(): void {
    this.inputEl.removeEventListener('beforeinput', this.onBeforeInput, true);
    if (this.awaitingTriggerResetTimer !== null) {
      window.clearTimeout(this.awaitingTriggerResetTimer);
      this.awaitingTriggerResetTimer = null;
    }
    this.exitMode();
  }

  private enterMode(): boolean {
    // Indicator is the single source of truth - only enter mode if we can show it.
    const wrapper = this.callbacks.getInputWrapper();
    if (!wrapper) return false;

    wrapper.addClass('claudian-input-bang-bash-mode');
    this.state = { active: true, rawCommand: '' };
    this.inputEl.placeholder = t('chat.bangBash.placeholder');
    return true;
  }

  private exitMode(): void {
    const wasActive = this.state.active;
    const wrapper = this.callbacks.getInputWrapper();
    wrapper?.removeClass('claudian-input-bang-bash-mode');
    this.state = { active: false, rawCommand: '' };
    if (wasActive) {
      this.callbacks.restorePlaceholder();
    }
  }

  private async submit(): Promise<void> {
    if (this.isSubmitting) return;

    const rawCommand = this.state.rawCommand.trim();
    if (!rawCommand) return;

    this.isSubmitting = true;
    try {
      // Clear first: the command is consumed here, and the composer must not
      // keep it once the shell owns it.
      this.clear();
      await this.callbacks.onSubmit(rawCommand);
    } finally {
      this.isSubmitting = false;
    }
  }
}
