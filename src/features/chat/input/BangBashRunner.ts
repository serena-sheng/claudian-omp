import type { ChatMessage } from '@/core/types';
import type { BangBashService } from '@/features/chat/input/BangBashService';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { ChatState } from '@/features/chat/state/ChatState';
import { t } from '@/i18n/i18n';

/** Live transcript the runner appends into; absent while the tab runtime is unpublished. */
export interface BangBashTranscript {
  readonly state: ChatState;
  readonly renderer: Pick<MessageRenderer, 'addMessage' | 'renderContent' | 'scrollToBottom'>;
}

export interface BangBashRunnerDeps {
  service: Pick<BangBashService, 'execute'>;
  createMessageId: () => string;
  getTranscript: () => BangBashTranscript | null;
}

/**
 * Renders one `$ command` console block. The fence is grown past the longest
 * backtick run in the transcript so shell output that talks about Markdown
 * cannot close the block early.
 */
function formatBangBashTranscript(command: string, body: string): string {
  const transcript = `$ ${command}${body ? `\n${body}` : ''}`;
  let longestBacktickRun = 0;
  for (const match of transcript.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}console\n${transcript}\n${fence}`;
}

/**
 * Composer bash commands enter the conversation through the same transcript
 * channel as every other message: one assistant message is appended and its
 * block is re-rendered in place once the shell exits.
 */
export class BangBashRunner {
  constructor(private readonly deps: BangBashRunnerDeps) {}

  async run(command: string): Promise<void> {
    const transcript = this.deps.getTranscript();
    if (!transcript) return;

    const message: ChatMessage = {
      id: this.deps.createMessageId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    transcript.state.addMessage(message);
    const contentEl = transcript.renderer.addMessage(message)
      .querySelector<HTMLElement>('.claudian-message-content');
    if (contentEl) {
      await transcript.renderer.renderContent(
        contentEl,
        formatBangBashTranscript(command, t('chat.bangBash.running')),
      );
    }

    const result = await this.deps.service.execute(command);
    const output = [result.stdout, result.stderr]
      .map(part => part.trimEnd())
      .filter(part => part.length > 0)
      .join('\n');
    let note = '';
    if (result.failure === 'timeout') {
      note = t('chat.bangBash.timeout');
    } else if (result.failure === 'outputLimit') {
      note = t('chat.bangBash.outputLimit');
    } else if (result.exitCode !== 0) {
      note = t('chat.bangBash.exitCode', { code: result.exitCode });
    }
    const body = output && note ? `${output}\n\n${note}` : output || note;

    message.content = formatBangBashTranscript(command, body);
    message.completedAt = Date.now();

    if (contentEl?.isConnected) {
      await transcript.renderer.renderContent(contentEl, message.content);
      transcript.renderer.scrollToBottom();
    }
  }
}
