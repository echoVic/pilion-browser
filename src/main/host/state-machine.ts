import {
  HostError,
  type ActionState,
  type ApprovalState,
  type AttachmentState,
  type AttemptState,
  type SessionState,
} from './types.js';

const transitions = {
  session: {
    creating: ['active', 'failed'],
    active: ['draining', 'failed'],
    draining: ['closed', 'failed'],
    closed: [],
    failed: [],
  } satisfies Record<SessionState, readonly SessionState[]>,
  attachment: {
    attaching: ['attached', 'failed'],
    attached: ['detached', 'expired', 'closed', 'failed'],
    detached: ['closed'],
    expired: [],
    closed: [],
    failed: [],
  } satisfies Record<AttachmentState, readonly AttachmentState[]>,
  action: {
    created: ['queued', 'cancelled'],
    queued: ['awaiting_approval', 'executing', 'failed', 'cancelled'],
    awaiting_approval: ['approved', 'cancelled', 'stale'],
    approved: ['executing', 'cancelled', 'stale'],
    executing: ['succeeded', 'failed', 'outcome_unknown', 'cancelled'],
    succeeded: [],
    failed: [],
    outcome_unknown: [],
    cancelled: [],
    stale: [],
  } satisfies Record<ActionState, readonly ActionState[]>,
  attempt: {
    prepared: ['dispatched', 'cancelled', 'failed_before_dispatch'],
    dispatched: ['effect_started', 'failed_before_dispatch', 'outcome_unknown', 'cancelled'],
    effect_started: ['succeeded', 'failed', 'outcome_unknown', 'cancelled'],
    succeeded: [],
    failed: [],
    outcome_unknown: [],
    cancelled: [],
    failed_before_dispatch: [],
  } satisfies Record<AttemptState, readonly AttemptState[]>,
  approval: {
    pending: ['approved', 'denied', 'expired', 'stale'],
    approved: ['stale'],
    denied: [],
    expired: [],
    stale: [],
  } satisfies Record<ApprovalState, readonly ApprovalState[]>,
};

export type StateMachineKind = keyof typeof transitions;
type StateFor<K extends StateMachineKind> = K extends 'session'
  ? SessionState
  : K extends 'attachment'
    ? AttachmentState
    : K extends 'action'
      ? ActionState
      : K extends 'attempt'
        ? AttemptState
        : ApprovalState;

export function canTransition<K extends StateMachineKind>(
  kind: K,
  from: StateFor<K>,
  to: StateFor<K>,
): boolean {
  const allowed = transitions[kind] as Record<string, readonly string[]>;
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition<K extends StateMachineKind>(
  kind: K,
  from: StateFor<K>,
  to: StateFor<K>,
): void {
  if (!canTransition(kind, from, to)) {
    throw new HostError('INVALID_STATE_TRANSITION', `Illegal ${kind} transition: ${from} -> ${to}`);
  }
}

export const stateTransitions = transitions;
