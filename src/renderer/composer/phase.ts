/**
 * 输入框发送流程的阶段。一次提交用 token 标识：前一回合迟到的收尾不会把后一次提交错标成空闲。
 * - interrupting：⌘/Ctrl+Enter 已请求打断，正在等 Agent 收尾；
 * - submitting：已交给主进程、主进程还没收下（这期间不能再发，也不能撤回队列）；
 * - awaiting-turn：主进程已收下，回合还没结束（可以继续打字、排队）。
 */
export type ComposerPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'interrupting' }
  | { readonly kind: 'submitting'; readonly token: number }
  | { readonly kind: 'awaiting-turn'; readonly token: number };

export type ComposerPhaseEvent =
  | { readonly type: 'interrupt' }
  | { readonly type: 'interrupt-aborted' }
  | { readonly type: 'submit'; readonly token: number }
  | { readonly type: 'accepted'; readonly token: number }
  | { readonly type: 'settled'; readonly token: number };

export const IDLE_PHASE: ComposerPhase = Object.freeze({ kind: 'idle' });

export function composerPhase(phase: ComposerPhase, event: ComposerPhaseEvent): ComposerPhase {
  switch (event.type) {
    case 'interrupt':
      return phase.kind === 'submitting' ? phase : { kind: 'interrupting' };
    case 'interrupt-aborted':
      return phase.kind === 'interrupting' ? IDLE_PHASE : phase;
    case 'submit':
      return { kind: 'submitting', token: event.token };
    case 'accepted':
      return phase.kind === 'submitting' && phase.token === event.token
        ? { kind: 'awaiting-turn', token: event.token }
        : phase;
    case 'settled':
      return (phase.kind === 'submitting' || phase.kind === 'awaiting-turn') &&
        phase.token === event.token
        ? IDLE_PHASE
        : phase;
  }
}

/** 打断或提交在途：不能再发起一次发送，也不能改动将要发出的队列。 */
export function composerLocked(phase: ComposerPhase): boolean {
  return phase.kind === 'interrupting' || phase.kind === 'submitting';
}
