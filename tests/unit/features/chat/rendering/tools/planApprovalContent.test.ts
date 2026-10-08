import { createMockEl, type MockElement } from '@test/helpers/MockElement';

import type { ToolCallInfo } from '@/core/types';
import {
  type PlanApprovalPort,
  renderPlanApprovalContent,
} from '@/features/chat/rendering/tools/planApprovalContent';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { t } from '@/i18n/i18n';

jest.mock('obsidian', () => ({
  Platform: { resourcePathPrefix: 'app://local/' },
  setIcon: jest.fn(),
}));

function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'plan-1',
    name: 'ExitPlanMode',
    input: { planContent: '# Plan\n- Add parser\n- Wire renderer' },
    status: 'completed',
    ...overrides,
  };
}

function createPort(): { port: PlanApprovalPort; submit: jest.Mock; setSupported: (value: boolean) => void } {
  const submit = jest.fn();
  let supported = true;
  return {
    port: {
      isSupported: () => supported,
      submit,
    },
    setSupported: value => { supported = value; },
    submit,
  };
}

function labelTexts(container: MockElement): string[] {
  return container.querySelectorAll('.claudian-ask-item-label').map((el: MockElement) => el.textContent);
}

function actionButtons(container: MockElement): MockElement[] {
  return container.querySelectorAll('.claudian-ask-action');
}

describe('renderPlanApprovalContent', () => {
  it('renders the plan points and the approve/reject actions', () => {
    const container = createMockEl();
    renderPlanApprovalContent(container as unknown as HTMLElement, createToolCall(), { planApproval: createPort().port });

    expect(labelTexts(container.querySelector('.claudian-plan-points'))).toEqual(['Plan', 'Add parser', 'Wire renderer']);
    expect(labelTexts(container)).toEqual([
      'Plan', 'Add parser', 'Wire renderer',
      t('chat.planApproval.approve'), t('chat.planApproval.reject'),
    ]);
  });

  it('submits an approve decision and settles the card', () => {
    const container = createMockEl();
    const { port, submit } = createPort();
    renderPlanApprovalContent(container as unknown as HTMLElement, createToolCall(), { planApproval: port });

    container.querySelector('.claudian-ask-action--primary').click();

    expect(submit).toHaveBeenCalledWith('approve');
    expect(container.querySelector('.claudian-plan-approval-decision').textContent)
      .toBe(t('chat.planApproval.approved'));
    expect(actionButtons(container)).toHaveLength(0);
  });

  it('submits a reject decision exactly once', () => {
    const container = createMockEl();
    const { port, submit } = createPort();
    renderPlanApprovalContent(container as unknown as HTMLElement, createToolCall(), { planApproval: port });

    const rejectButton = actionButtons(container)[1];
    rejectButton.click();
    rejectButton.click();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('reject');
    expect(container.querySelector('.claudian-plan-approval-decision').textContent)
      .toBe(t('chat.planApproval.rejected'));
  });

  it('renders nothing when the provider has no plan mode', () => {
    const container = createMockEl();
    const { port, submit, setSupported } = createPort();
    setSupported(false);

    renderPlanApprovalContent(container as unknown as HTMLElement, createToolCall(), { planApproval: port });

    expect(container._children).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('states that plan details are missing when the tool input has none', () => {
    const container = createMockEl();
    renderPlanApprovalContent(container as unknown as HTMLElement, createToolCall({ input: {} }), { planApproval: createPort().port });

    expect(container.querySelector('.claudian-plan-approval-empty').textContent)
      .toBe(t('chat.planApproval.noDetails'));
    expect(actionButtons(container)).toHaveLength(2);
  });
});

describe('ExitPlanMode tool card', () => {
  it('presents the approval card as the tool body and reaches the tab submit channel', () => {
    const parentEl = createMockEl();
    const { port, submit } = createPort();

    const toolEl = renderStoredToolCall(parentEl, createToolCall(), { planApproval: port }) as unknown as MockElement;
    toolEl.querySelector('.claudian-ask-action--primary')!.click();

    expect(submit).toHaveBeenCalledWith('approve');
  });

  it('offers no approval actions for a provider without plan mode', () => {
    const parentEl = createMockEl();
    const { port, setSupported } = createPort();
    setSupported(false);

    const toolEl = renderStoredToolCall(parentEl, createToolCall(), { planApproval: port }) as unknown as MockElement;

    expect(actionButtons(toolEl)).toHaveLength(0);
  });
});
