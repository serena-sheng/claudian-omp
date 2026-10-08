/** @jest-environment jsdom */

import {
  type InstructionModeCallbacks,
  InstructionModeManager,
} from '@/features/chat/composer/InstructionModeManager';
import { shouldSendMessageFromEnterKey } from '@/features/chat/tabs/TabInputEvents';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

function createHarness(
  callbacks: Partial<InstructionModeCallbacks> = {},
  settings: { requireCommandOrControlEnterToSend: boolean } = { requireCommandOrControlEnterToSend: false },
) {
  const inputEl = document.createElement('textarea') as unknown as ComposerInputElement;
  inputEl.placeholder = 'Ask to make changes';
  document.body.appendChild(inputEl as unknown as HTMLElement);
  const wrapper = document.createElement('div');
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const restorePlaceholder = jest.fn();
  const manager = new InstructionModeManager(inputEl, 'Describe your instruction', {
    getInputWrapper: () => wrapper,
    onSubmit,
    shouldSubmitOnEnter: event => shouldSendMessageFromEnterKey(event, settings),
    restorePlaceholder,
    ...callbacks,
  });
  return { inputEl, wrapper, manager, onSubmit, restorePlaceholder };
}

function enterTrigger(manager: InstructionModeManager): void {
  const consumed = manager.handleTriggerKey(new KeyboardEvent('keydown', { key: '#' }));
  expect(consumed).toBe(true);
  expect(manager.isActive()).toBe(true);
}

function typeDraft(inputEl: ComposerInputElement, manager: InstructionModeManager, text: string): void {
  inputEl.value = text;
  manager.handleInputChange();
}

function enterKey(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', ...init });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('InstructionModeManager trigger', () => {
  it('ignores `#` while an IME composition is active', () => {
    const { manager } = createHarness();
    const consumed = manager.handleTriggerKey(
      new KeyboardEvent('keydown', { key: '#', isComposing: true }),
    );
    expect(consumed).toBe(false);
    expect(manager.isActive()).toBe(false);
  });

  it('suppresses the trigger `#` insertion only until the next macrotask', () => {
    jest.useFakeTimers();
    try {
      const { inputEl, manager } = createHarness();
      enterTrigger(manager);

      const insertion = new InputEvent('beforeinput', {
        inputType: 'insertText', data: '#', cancelable: true,
      });
      inputEl.dispatchEvent(insertion);
      expect(insertion.defaultPrevented).toBe(true);

      // No beforeinput may arrive for a prevented keydown; the guard must not
      // survive into a later, genuine `#` keystroke.
      jest.runOnlyPendingTimers();
      const laterInsertion = new InputEvent('beforeinput', {
        inputType: 'insertText', data: '#', cancelable: true,
      });
      inputEl.dispatchEvent(laterInsertion);
      expect(laterInsertion.defaultPrevented).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('InstructionModeManager Enter handling', () => {
  it('submits on plain Enter when requireCommandOrControlEnterToSend is off', () => {
    const { inputEl, manager, onSubmit } = createHarness();
    enterTrigger(manager);
    typeDraft(inputEl, manager, 'refactor the parser');

    const consumed = manager.handleKeydown(enterKey());
    expect(consumed).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith('refactor the parser');
  });

  it('leaves plain Enter to the composer newline when requireCommandOrControlEnterToSend is on', () => {
    const { inputEl, manager, onSubmit } = createHarness(
      {}, { requireCommandOrControlEnterToSend: true },
    );
    enterTrigger(manager);
    typeDraft(inputEl, manager, 'refactor the parser');

    const event = enterKey();
    const consumed = manager.handleKeydown(event);
    expect(consumed).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(manager.isActive()).toBe(true);
    expect(inputEl.value).toBe('refactor the parser');
  });

  it('submits on Cmd+Enter when requireCommandOrControlEnterToSend is on', () => {
    const { inputEl, manager, onSubmit } = createHarness(
      {}, { requireCommandOrControlEnterToSend: true },
    );
    enterTrigger(manager);
    typeDraft(inputEl, manager, 'refactor the parser');

    const consumed = manager.handleKeydown(enterKey({ metaKey: true }));
    expect(consumed).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith('refactor the parser');
  });
});

describe('InstructionModeManager draft preservation', () => {
  it('keeps the draft when Escape exits the mode', () => {
    const { inputEl, manager } = createHarness();
    enterTrigger(manager);
    typeDraft(inputEl, manager, 'draft to keep');

    const consumed = manager.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(consumed).toBe(true);
    expect(manager.isActive()).toBe(false);
    expect(inputEl.value).toBe('draft to keep');
  });

  it('delegates placeholder restoration to the owner instead of restoring a cached one', () => {
    const { inputEl, manager, restorePlaceholder } = createHarness();
    enterTrigger(manager);
    expect(inputEl.placeholder).toBe('Describe your instruction');

    // The owner callback intentionally does nothing: the manager must not
    // write a placeholder of its own on exit.
    manager.deactivate();
    expect(restorePlaceholder).toHaveBeenCalledTimes(1);
    expect(inputEl.placeholder).toBe('Describe your instruction');
  });
});
