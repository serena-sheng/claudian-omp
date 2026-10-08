import type { ToolCallInfo } from '@/core/types';
import { t } from '@/i18n/i18n';

/** Outcome a plan approval card can submit. */
export type PlanApprovalDecision = 'approve' | 'reject';

/**
 * Tab-owned submission channel behind an inline plan approval card. The card only
 * displays and collects the decision; the tab controller performs the actual send.
 */
export interface PlanApprovalPort {
  /** False when the active provider has no plan mode, which hides the card entirely. */
  isSupported(): boolean;
  /** Sends the decision through the tab's ordinary message channel. */
  submit(decision: PlanApprovalDecision): void;
}

/** Per-render context handed to a card body that needs more than the tool snapshot. */
export interface PlanApprovalRenderContext {
  planApproval?: PlanApprovalPort;
}

/** Decisions already taken, so a re-render keeps the settled state and blocks double submits. */
const DECIDED = new WeakMap<ToolCallInfo, PlanApprovalDecision>();

const DECISION_LABEL_KEY = {
  approve: 'chat.planApproval.approved',
  reject: 'chat.planApproval.rejected',
} as const;

/** Plan bullet points from a provider's plan-mode exit input, most specific source first. */
function extractPlanPoints(input: Record<string, unknown>): string[] {
  const raw = [input.planContent, input.plan]
    .find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
  if (!raw) return [];
  return raw
    .split('\n')
    .map(line => line.trim().replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter(line => line.length > 0)
    .slice(0, 8);
}

/**
 * Card body for a plan-mode exit: the plan's key points with a one-click
 * approve/reject pair. Renders nothing when the provider has no plan mode.
 */
export function renderPlanApprovalContent(
  container: HTMLElement,
  tool: ToolCallInfo,
  context?: PlanApprovalRenderContext,
): void {
  const port = context?.planApproval;
  if (!port?.isSupported()) return;

  const decide = (decision: PlanApprovalDecision): void => {
    if (DECIDED.has(tool)) return;
    DECIDED.set(tool, decision);
    port.submit(decision);
    renderCard();
  };

  const renderCard = (): void => {
    container.empty();
    const rootEl = container.createDiv({ cls: 'claudian-ask-question-inline claudian-plan-approval' });

    const decided = DECIDED.get(tool);
    if (decided) {
      rootEl.createDiv({
        cls: `claudian-plan-approval-decision is-${decided}`,
        text: t(DECISION_LABEL_KEY[decided]),
        attr: { role: 'status' },
      });
      return;
    }

    rootEl.createDiv({ cls: 'claudian-ask-inline-title claudian-plan-approval-prompt', text: t('chat.planApproval.prompt') });

    const points = extractPlanPoints(tool.input);
    if (points.length > 0) {
      const listEl = rootEl.createDiv({ cls: 'claudian-ask-list claudian-plan-points' });
      for (const point of points) {
        listEl.createDiv({ cls: 'claudian-ask-item' })
          .createSpan({ text: point, cls: 'claudian-ask-item-label' });
      }
    } else {
      rootEl.createDiv({ cls: 'claudian-plan-approval-empty', text: t('chat.planApproval.noDetails') });
    }

    const actionsEl = rootEl.createDiv({ cls: 'claudian-ask-actions' });

    const approveRow = actionsEl.createEl('button', {
      cls: 'claudian-ask-item claudian-ask-action claudian-ask-action--primary',
      attr: { type: 'button', 'aria-label': t('chat.planApproval.approve') },
    });
    approveRow.createSpan({ text: t('chat.planApproval.approve'), cls: 'claudian-ask-item-label' });
    approveRow.addEventListener('click', () => decide('approve'));

    const rejectRow = actionsEl.createEl('button', {
      cls: 'claudian-ask-item claudian-ask-action',
      attr: { type: 'button', 'aria-label': t('chat.planApproval.reject') },
    });
    rejectRow.createSpan({ text: t('chat.planApproval.reject'), cls: 'claudian-ask-item-label' });
    rejectRow.addEventListener('click', () => decide('reject'));
  };

  renderCard();
}
