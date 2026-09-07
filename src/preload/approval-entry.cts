import { ipcRenderer } from 'electron';
import type { ApprovalViewState } from '../shared/contracts.js';

const IPC = { approvalRequest: 'approval:request', approvalGesture: 'approval:gesture', approvalRespond: 'approval:respond' } as const;
type ApprovalPayload = ApprovalViewState & { nonce: string; actionDigest: string };
window.addEventListener('DOMContentLoaded', () => {
  const title = document.getElementById('approval-title')!;
  const summary = document.getElementById('approval-summary')!;
  const status = document.getElementById('approval-status')!;
  const approve = document.getElementById('approval-approve') as HTMLButtonElement;
  const deny = document.getElementById('approval-deny') as HTMLButtonElement;
  let current: ApprovalPayload | undefined;
  let resolved = false;
  const finish = async (event: MouseEvent, decision: 'approve' | 'deny') => {
    if (!event.isTrusted || !current || resolved) return;
    resolved = true; approve.disabled = true; deny.disabled = true;
    try {
      const gestureToken = await ipcRenderer.invoke(IPC.approvalGesture, { approvalId: current.approvalId, nonce: current.nonce, actionDigest: current.actionDigest }) as string;
      await ipcRenderer.invoke(IPC.approvalRespond, { approvalId: current.approvalId, nonce: current.nonce, actionDigest: current.actionDigest, decision, gestureToken });
      status.textContent = decision === 'approve' ? '已批准' : '已拒绝';
    } catch (error) {
      resolved = false; approve.disabled = false; deny.disabled = false;
      status.textContent = `无法提交：${error instanceof Error ? error.message : String(error)}`;
    }
  };
  approve.addEventListener('click', event => { void finish(event, 'approve'); });
  deny.addEventListener('click', event => { void finish(event, 'deny'); });
  ipcRenderer.on(IPC.approvalRequest, (_event, payload: ApprovalPayload) => {
    current = payload; resolved = false;
    title.textContent = `Agent 请求：${payload.tool}`; summary.textContent = payload.summary;
    status.textContent = payload.statusText ?? '请确认页面和操作内容。页面变化后该审批将自动失效。';
    approve.disabled = false; deny.disabled = false;
  });
});
