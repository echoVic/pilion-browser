// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordingState } from '../src/shared/contracts';
import { RecordingBar, useRecordingStop } from '../src/renderer/RecordingBar';

const stop = vi.fn<(name: string) => Promise<unknown>>();
const onSaved = vi.fn();
const onContinue = vi.fn();
const run = vi.fn(async () => true);
const recording: RecordingState = {
  tabId: 't1',
  steps: 12,
  unsupported: 0,
  startedAt: '2026-11-12T08:00:00.000Z',
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stop.mockReset();
  onSaved.mockReset();
  onContinue.mockReset();
  run.mockClear();
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: { recording: { stop, note: vi.fn(async () => undefined) } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});

type HarnessProps = { shown?: boolean; naming?: boolean; recording?: RecordingState };
/** 和 App 一样：停止状态在外层，录制条按 state.recording 挂上卸下。 */
function Harness({ shown = true, naming = true, recording: current = recording }: HarnessProps) {
  const stop = useRecordingStop(onSaved);
  return shown
    ? createElement(RecordingBar, {
        recording: current,
        naming,
        name: '录制 一',
        onNameChange() {},
        onContinue,
        onCancel() {},
        stop,
        note: '',
        onNoteChange() {},
        run,
      })
    : null;
}
async function render(props: HarnessProps = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
const saveButton = () =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === '保存')!;
const alertText = () => container.querySelector('[role="alert"]')?.textContent;

it('says the recording stopped taking steps once the log is capped', async () => {
  await render({ naming: false });
  expect(container.textContent).not.toContain('已达到录制上限');
  await render({ naming: false, recording: { ...recording, capped: true } });
  expect(container.textContent).toContain('已达到录制上限，后面的操作不会记下');
});

it('keeps the bar and explains a failed save, and a second 保存 retries', async () => {
  stop.mockRejectedValueOnce(
    new Error("Error invoking remote method 'recording:stop': Error: 磁盘空间不足。"),
  );
  await render();
  await act(async () => saveButton().click());
  expect(stop).toHaveBeenCalledWith('录制 一');
  expect(alertText()).toBe('录制没有保存成功：磁盘空间不足。再点一次「保存」会重试。');
  expect(onSaved).not.toHaveBeenCalled();
  // 只在录制条上说一次，不再经 run 报到全局错误条。
  expect(run).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="录制名称"]')).not.toBeNull();

  stop.mockResolvedValueOnce({ id: 'r1' });
  await act(async () => saveButton().click());
  expect(stop).toHaveBeenCalledTimes(2);
  expect(onSaved).toHaveBeenCalledOnce();
  expect(alertText()).toBeUndefined();
});

it('stops once when 保存 is pressed twice while the first stop is in flight', async () => {
  let finish!: (value: unknown) => void;
  stop.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await render();
  await act(async () => {
    saveButton().click();
    saveButton().click();
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(saveButton().disabled).toBe(true);
  await act(async () => finish({ id: 'r1' }));
  expect(onSaved).toHaveBeenCalledOnce();
});

it('drops the failure note when the person goes back to recording', async () => {
  stop.mockRejectedValueOnce(new Error('写不进录制目录'));
  await render();
  await act(async () => saveButton().click());
  expect(alertText()).toContain('写不进录制目录');
  const resume = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '继续录',
  )!;
  await act(async () => resume.click());
  expect(onContinue).toHaveBeenCalledOnce();
  expect(alertText()).toBeUndefined();
});

it('still explains the failure when the bar was unmounted while main was stopping', async () => {
  let fail!: (cause: Error) => void;
  stop.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
  await render();
  await act(async () => saveButton().click());
  // 主进程停止期间广播的状态里没有 recording：录制条卸载。
  await render({ shown: false });
  await act(async () => fail(new Error('磁盘空间不足')));
  // 保存失败，录制恢复，录制条重新挂上：原因还在。
  await render({ shown: true });
  expect(alertText()).toBe('录制没有保存成功：磁盘空间不足。再点一次「保存」会重试。');
  expect(onSaved).not.toHaveBeenCalled();
});
