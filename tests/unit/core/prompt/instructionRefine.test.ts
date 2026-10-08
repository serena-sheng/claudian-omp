import {
  buildInstructionRefinePrompt,
  INSTRUCTION_REFINE_SYSTEM_PROMPT,
  parseInstructionRefineResponse,
} from '@/core/prompt/instructionRefine';

describe('buildInstructionRefinePrompt', () => {
  it('embeds the raw instruction', () => {
    const prompt = buildInstructionRefinePrompt('make it faster');
    expect(prompt).toContain('make it faster');
  });
});

describe('INSTRUCTION_REFINE_SYSTEM_PROMPT', () => {
  it('declares the instruction tag protocol and clarification fallback', () => {
    expect(INSTRUCTION_REFINE_SYSTEM_PROMPT).toContain('<instruction>');
    expect(INSTRUCTION_REFINE_SYSTEM_PROMPT).toContain('one focused question');
  });
});

describe('parseInstructionRefineResponse', () => {
  it('extracts a tagged refined instruction', () => {
    expect(parseInstructionRefineResponse('<instruction>Do X.</instruction>')).toEqual({
      success: true,
      refinedInstruction: 'Do X.',
    });
  });

  it('trims multiline instruction content', () => {
    expect(parseInstructionRefineResponse('<instruction>\nDo X.\nDo Y.\n</instruction>')).toEqual({
      success: true,
      refinedInstruction: 'Do X.\nDo Y.',
    });
  });

  it('treats untagged text as a clarifying question', () => {
    expect(parseInstructionRefineResponse('What do you mean?')).toEqual({
      success: true,
      clarification: 'What do you mean?',
    });
  });

  it('fails on an empty response', () => {
    expect(parseInstructionRefineResponse('  ')).toEqual({
      success: false,
      error: 'Empty response',
    });
  });
});
