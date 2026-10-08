/** @jest-environment jsdom */

import { Component, MarkdownRenderer } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { BangBashModeManager } from '@/features/chat/composer/BangBashModeManager';
import { BangBashRunner } from '@/features/chat/input/BangBashRunner';
import type { BangBashResult } from '@/features/chat/input/BangBashService';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { buildTabRuntimeInputBindings } from '@/features/chat/tabs/runtime/TabRuntimeInputBindings';
import { shouldSendMessageFromEnterKey } from '@/features/chat/tabs/TabInputEvents';
import type { TabControllers, TabUIComponents } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.empty = function () { this.replaceChildren(); };

const COMPOSER_PLACEHOLDER = 'Ask to make changes';

interface Scenario {
  readonly inputEl: ComposerInputElement;
  readonly inputWrapper: HTMLElement;
  readonly messagesEl: HTMLElement;
  readonly state: ChatState;
  readonly manager: BangBashModeManager;
  readonly submit: jest.Mock;
  readonly execute: jest.Mock;
  readonly cleanup: (() => void)[];
}

/**
 * Wires the real mode manager, runner, renderer and tab input bindings, with
 * only the shell and Obsidian boundaries replaced: `exec` (BangBashService) and
 * MarkdownRenderer.
 */
function createScenario(
  options: { enabled: boolean; result?: Partial<BangBashResult>; requireCommandOrControlEnterToSend?: boolean },
): Scenario {
  const messagesEl = document.body.createDiv();
  const inputComposerEl = document.body.createDiv();
  const inputWrapper = inputComposerEl.createDiv();
  const inputEl = inputComposerEl.createEl('textarea') as unknown as ComposerInputElement;
  inputEl.placeholder = COMPOSER_PLACEHOLDER;

  const state = new ChatState();
  const renderer = new MessageRenderer(
    // Partial host stub: content rendering only needs the Obsidian app and media folder.
    { app: {}, settings: { mediaFolder: '' } } as unknown as ChatFeatureHost,
    new Component(),
    messagesEl,
  );

  const execute = jest.fn().mockResolvedValue({
    command: 'echo hi',
    stdout: 'hi\n',
    stderr: '',
    exitCode: 0,
    ...options.result,
  });
  let sequence = 0;
  const runner = new BangBashRunner({
    service: { execute },
    createMessageId: () => `bash-${++sequence}`,
    getTranscript: () => ({ state, renderer }),
  });
  const submit = jest.fn((command: string) => runner.run(command));

  const settings = {
    enableBangBash: options.enabled,
    enableInstructionMode: false,
    requireCommandOrControlEnterToSend: options.requireCommandOrControlEnterToSend ?? false,
    enableAutoScroll: true,
    keyboardNavigation: { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' },
  };
  const manager = new BangBashModeManager(inputEl, {
    isEnabled: () => settings.enableBangBash,
    getInputWrapper: () => inputWrapper,
    onSubmit: command => submit(command),
    shouldSubmitOnEnter: event => shouldSendMessageFromEnterKey(event, settings),
    restorePlaceholder: () => { inputEl.placeholder = COMPOSER_PLACEHOLDER; },
  });

  const cleanup: (() => void)[] = [() => { manager.destroy(); renderer.dispose(); }];
  // Partial stubs: the binding only reads the members exercised below.
  buildTabRuntimeInputBindings(
    { dom: { messagesEl, inputEl, inputComposerEl, inputWrapper }, state } as unknown as TabRuntimeShellBundle,
    {
      bangBashModeManager: manager,
      instructionModeManager: {
        isActive: () => false, handleTriggerKey: () => false, handleKeydown: () => false,
        handleInputChange: jest.fn(),
      },
      composerDropdown: { handleInputChange: jest.fn(), handleKeydown: () => false },
      promptSuggestion: { handleKeydown: () => false },
      navigationSidebar: { setOnScrollIntent: jest.fn() },
    } as unknown as TabUIComponents,
    {
      conversationController: { cancelBranchDraft: jest.fn() },
      sideChatController: { handleComposerInput: jest.fn() },
      builtInCommandController: { handleResumeKeydown: () => false },
    } as unknown as TabControllers,
    {
      plugin: { settings },
      registerCleanup: (_resource: string, dispose: () => void) => { cleanup.push(dispose); },
    } as unknown as TabRuntimeConstructionContext,
    {
      requirePublished: () => ({ lifecycleState: 'open', session: { claimUserOwnership: jest.fn() } }),
    } as unknown as PublishedTabRuntimeRef,
  );

  return { inputEl, inputWrapper, messagesEl, state, manager, submit, execute, cleanup };
}

function pressKey(inputEl: ComposerInputElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  inputEl.dispatchEvent(event);
  return event;
}

function pressTrigger(inputEl: ComposerInputElement, init: KeyboardEventInit = {}): KeyboardEvent {
  return pressKey(inputEl, { key: '!', ...init });
}

function typeCommand(inputEl: ComposerInputElement, command: string): void {
  inputEl.value = command;
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Runs the armed command and awaits the submission the binding started. */
async function submitCommand(created: Scenario): Promise<void> {
  pressKey(created.inputEl, { key: 'Enter' });
  await created.submit.mock.results.at(-1)?.value;
}

let scenarios: Scenario[] = [];

function scenario(options: Parameters<typeof createScenario>[0]): Scenario {
  const created = createScenario(options);
  scenarios.push(created);
  return created;
}

beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(
    async (_app, markdown, target) => { (target as HTMLElement).textContent = markdown; },
  );
});

afterEach(() => {
  for (const created of scenarios) {
    for (const dispose of created.cleanup) dispose();
  }
  scenarios = [];
  jest.mocked(MarkdownRenderer.render).mockReset();
});

describe('BangBashModeManager', () => {
  it('leaves `!` to the composer while the bash mode setting is off', () => {
    const { inputEl, messagesEl, manager, execute } = scenario({ enabled: false });

    const event = pressTrigger(inputEl);

    expect(event.defaultPrevented).toBe(false);
    expect(manager.isActive()).toBe(false);
    expect(inputEl.value).toBe('');
    expect(execute).not.toHaveBeenCalled();
    expect(messagesEl.querySelector('.claudian-message')).toBeNull();
  });

  it('arms bash mode on `!` in an empty composer and shows the bash placeholder', () => {
    const { inputEl, inputWrapper, manager } = scenario({ enabled: true });

    const event = pressTrigger(inputEl);

    expect(event.defaultPrevented).toBe(true);
    expect(manager.isActive()).toBe(true);
    expect(inputWrapper.classList.contains('claudian-input-bang-bash-mode')).toBe(true);
    expect(inputEl.placeholder).toBe(t('chat.bangBash.placeholder'));
  });

  it('ignores `!` while an IME composition is active', () => {
    const { inputEl, manager } = scenario({ enabled: true });

    const event = pressTrigger(inputEl, { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(manager.isActive()).toBe(false);
  });

  it('ignores `!` when the composer already has text', () => {
    const { inputEl, manager } = scenario({ enabled: true });
    inputEl.value = 'hello';

    const event = pressTrigger(inputEl);

    expect(event.defaultPrevented).toBe(false);
    expect(manager.isActive()).toBe(false);
  });

  it('suppresses the trigger `!` insertion only until the next macrotask', () => {
    jest.useFakeTimers();
    try {
      const { inputEl, manager } = scenario({ enabled: true });
      pressTrigger(inputEl);

      const insertion = new InputEvent('beforeinput', {
        inputType: 'insertText', data: '!', cancelable: true,
      });
      inputEl.dispatchEvent(insertion);
      expect(insertion.defaultPrevented).toBe(true);

      // No beforeinput may arrive for a prevented keydown; the guard must not
      // survive into a later, genuine `!` keystroke.
      jest.runOnlyPendingTimers();
      const laterInsertion = new InputEvent('beforeinput', {
        inputType: 'insertText', data: '!', cancelable: true,
      });
      inputEl.dispatchEvent(laterInsertion);
      expect(laterInsertion.defaultPrevented).toBe(false);
      expect(manager.isActive()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('abandons the command on Escape and restores the composer', () => {
    const { inputEl, inputWrapper, manager } = scenario({ enabled: true });
    pressTrigger(inputEl);
    typeCommand(inputEl, 'rm -rf build');

    const event = pressKey(inputEl, { key: 'Escape' });

    expect(event.defaultPrevented).toBe(true);
    expect(inputEl.value).toBe('');
    expect(manager.isActive()).toBe(false);
    expect(inputWrapper.classList.contains('claudian-input-bang-bash-mode')).toBe(false);
    expect(inputEl.placeholder).toBe(COMPOSER_PLACEHOLDER);
  });

  it('keeps an empty command armed instead of falling through to sending', () => {
    const { inputEl, manager, execute } = scenario({ enabled: true });
    pressTrigger(inputEl);
    typeCommand(inputEl, '   ');

    const event = pressKey(inputEl, { key: 'Enter' });

    expect(event.defaultPrevented).toBe(true);
    expect(manager.isActive()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves plain Enter to a newline when the composer requires Cmd/Ctrl+Enter to send', () => {
    const { inputEl, manager, execute } = scenario({
      enabled: true, requireCommandOrControlEnterToSend: true,
    });
    pressTrigger(inputEl);
    typeCommand(inputEl, 'echo one\necho two');

    const event = pressKey(inputEl, { key: 'Enter' });

    expect(event.defaultPrevented).toBe(false);
    expect(manager.isActive()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('composer bash mode execution', () => {
  it('runs the command on Enter and appends its output to the transcript', async () => {
    const created = scenario({ enabled: true });
    const { inputEl, messagesEl, state, manager, execute } = created;
    pressTrigger(inputEl);
    expect(manager.isActive()).toBe(true);
    typeCommand(inputEl, 'echo hi');

    const event = pressKey(inputEl, { key: 'Enter' });
    expect(event.defaultPrevented).toBe(true);
    expect(inputEl.value).toBe('');
    expect(manager.isActive()).toBe(false);

    await created.submit.mock.results.at(-1)?.value;

    expect(execute).toHaveBeenCalledWith('echo hi');
    expect(state.messages).toHaveLength(1);
    const [message] = state.messages;
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('```console\n$ echo hi\nhi\n```');
    expect(message.completedAt).toBeDefined();
    const rendered = messagesEl.querySelector('.claudian-message-assistant .claudian-message-content');
    expect(rendered?.textContent).toContain('$ echo hi');
  });

  it('reports the exit code and stderr of a failing command', async () => {
    const created = scenario({
      enabled: true,
      result: { command: 'ls missing', stdout: '', stderr: 'ls: missing: No such file or directory\n', exitCode: 2 },
    });
    pressTrigger(created.inputEl);
    typeCommand(created.inputEl, 'ls missing');

    await submitCommand(created);

    expect(created.state.messages[0].content).toBe(
      '```console\n$ ls missing\nls: missing: No such file or directory\n\nExit code 2\n```',
    );
  });

  it('grows the fence past backticks in the command output', async () => {
    const created = scenario({
      enabled: true,
      result: { command: 'cat doc.md', stdout: 'Use ```console``` for shell transcripts\n', stderr: '', exitCode: 0 },
    });
    pressTrigger(created.inputEl);
    typeCommand(created.inputEl, 'cat doc.md');

    await submitCommand(created);

    expect(created.state.messages[0].content).toBe(
      '````console\n$ cat doc.md\nUse ```console``` for shell transcripts\n````',
    );
  });

  it('reports a timed-out command instead of its partial output alone', async () => {
    const created = scenario({
      enabled: true,
      result: { command: 'sleep 999', stdout: '', stderr: '', exitCode: 124, failure: 'timeout' },
    });
    pressTrigger(created.inputEl);
    typeCommand(created.inputEl, 'sleep 999');

    await submitCommand(created);

    expect(created.state.messages[0].content).toBe(
      `\`\`\`console\n$ sleep 999\n${t('chat.bangBash.timeout')}\n\`\`\``,
    );
  });
});
