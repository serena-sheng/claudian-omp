import {
  buildInstructionRefinePrompt,
  INSTRUCTION_REFINE_SYSTEM_PROMPT,
  parseInstructionRefineResponse,
} from '../prompt/instructionRefine';
import type {
  InstructionRefineResult,
  InstructionRefineService as InstructionRefineServiceContract,
} from '../providers/types';
import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { AuxiliarySessionController } from './AuxiliarySessionController';

const CONTINUITY_RESET_MESSAGE =
  'The provider environment changed. Start a new instruction refinement.';

export class InstructionRefineService implements InstructionRefineServiceContract {
  private readonly controller: AuxiliarySessionController;
  private hasConversation = false;
  private modelOverride: string | undefined;

  constructor(context: AuxiliaryExecutionContext) {
    this.controller = new AuxiliarySessionController(
      context,
      'instruction',
      { kind: 'passive' },
    );
  }

  setModelOverride(model?: string): void {
    const trimmed = model?.trim();
    this.modelOverride = trimmed ? trimmed : undefined;
  }

  resetConversation(): void {
    this.hasConversation = false;
    this.controller.reset();
  }

  async refineInstruction(rawInstruction: string): Promise<InstructionRefineResult> {
    this.hasConversation = false;
    try {
      await this.controller.startRoot();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
    return this.sendMessage(buildInstructionRefinePrompt(rawInstruction));
  }

  async continueConversation(message: string): Promise<InstructionRefineResult> {
    if (this.controller.requiresReset) {
      return {
        error: CONTINUITY_RESET_MESSAGE,
        resetRequired: true,
        success: false,
      };
    }
    if (!this.hasConversation || !this.controller.hasSession) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message);
  }

  cancel(): void {
    this.hasConversation = false;
    this.controller.cancel();
  }

  private async sendMessage(prompt: string): Promise<InstructionRefineResult> {
    try {
      const text = await this.controller.execute({
        model: this.modelOverride,
        prompt,
        systemPrompt: INSTRUCTION_REFINE_SYSTEM_PROMPT,
      });
      this.hasConversation = true;
      return parseInstructionRefineResponse(text);
    } catch (error) {
      this.hasConversation = false;
      await this.controller.dispose();
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
