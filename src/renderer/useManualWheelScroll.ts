import { useCallback, useRef } from 'react';

/**
 * 在可滚动元素上接管 wheel 滚动结算，消除流式内容增长与浏览器原生滚动之间的竞态。
 *
 * 问题：transcript 在流式输出时几乎每帧长高，assistant-ui 同时用 scrollToBottom
 * 下发 instant 滚动。Chromium 的 wheel 默认滚动（含合成器 fast-scroll 与主线程
 * 平滑滚动序列）按**上一帧的滚动边界**计算目标位置：在内容追加同帧上滚时，
 * 「滚到顶部」会被钳制在距顶一个内容块（约 53px）处，follow-bottom 解除后
 * 视口永久钉在错误位置；本地单用例连跑 6 次复现 5 次，全量 E2E 三轮中两轮首试失败。
 *
 * 对策：非 passive 监听里 preventDefault 原生滚动，在主线程按**当前**布局
 * （scrollHeight/clientHeight）即时同步结算目标 scrollTop，不再经过跨帧动画。
 * trackpad 高频与惯性事件逐事件即时结算，视觉上仍连续；键盘等非 wheel 滚动不受影响。
 *
 * 返回 callback ref 而非接收对象 ref：Viewport 会在聊天/活动视图切换与会话切换时
 * 卸载重挂，callback ref 在旧节点卸载时解绑、新节点挂载时重绑，不会持有失联的旧节点。
 */
export function useManualWheelScroll<T extends HTMLElement>(): (node: T | null) => void {
  const detach = useRef<(() => void) | null>(null);

  return useCallback((node: T | null) => {
    detach.current?.();
    detach.current = null;
    if (!node) return;

    const handleWheel = (event: WheelEvent): void => {
      // ctrlKey + wheel 是浏览器/系统的缩放手势，交给原生。
      if (event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();

      const computedLineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
      const lineHeight = Number.isFinite(computedLineHeight) ? computedLineHeight : 16;
      const scale =
        event.deltaMode === event.DOM_DELTA_LINE
          ? lineHeight
          : event.deltaMode === event.DOM_DELTA_PAGE
            ? node.clientHeight
            : 1;

      const maxScrollTop = Math.max(node.scrollHeight - node.clientHeight, 0);
      const target = Math.min(Math.max(node.scrollTop + event.deltaY * scale, 0), maxScrollTop);
      node.scrollTop = target;
    };

    node.addEventListener('wheel', handleWheel, { passive: false });
    detach.current = () => node.removeEventListener('wheel', handleWheel);
  }, []);
}
