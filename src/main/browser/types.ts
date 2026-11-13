import type { RecordingChannelOptions } from './recording-channel.js';
import type { PointerAction, SurfaceBox } from './pointer-action.js';
import { PRESS_KEYS, type PressKey } from '../../shared/press-keys.js';

export type PrincipalId = string;
export type TabId = string;
export type FrameId = string;

export type TabPermission = 'observe' | 'navigate' | 'effect' | 'manage';
export type TabRole = 'owner' | 'operator' | 'observer';

export interface TabAclEntry {
  principalId: PrincipalId;
  role: TabRole;
}

export interface TabAcl {
  entries: ReadonlyArray<TabAclEntry>;
}

/** An opaque, service-issued reference. It is never interpreted by an agent. */
export interface ElementRef {
  readonly id: string;
  readonly tabId: TabId;
  readonly frameId: FrameId;
  readonly documentEpoch: number;
  readonly frameEpoch: number;
  readonly localFingerprint: string;
}

/** input[type=file] 的元数据：observe 行与 upload 后验共用，便于分辨多个隐藏 input（issue #4）。 */
export interface FileInputMetadata {
  accept?: string;
  multiple?: boolean;
  /** 页面内第几个 file input（全量顺序，不受 --offset 影响）。 */
  inputIndex?: number;
  /** 关联 label 的文字。 */
  label?: string;
  /** 是否有可见 layout rect。 */
  visible?: boolean;
}

/** canvas/video 指针面的 observe 字段（issue #7）。 */
export interface PointerSurfaceMetadata {
  /** 这一行是指针面：只有它能用 browser.pointer 按坐标操作。 */
  surface?: true;
  /** 内容区，页面坐标的 CSS 像素，可原样当 screenshot 的 clip；没有布局时不给，visible 为 false。 */
  box?: SurfaceBox;
}

export interface ObservedElement extends FileInputMetadata, PointerSurfaceMetadata {
  ref: ElementRef;
  role: string;
  name: string;
  disabled: boolean;
  tagName: string;
  inputType?: string;
  formAction?: string;
  optionValues?: ReadonlyArray<string>;
  checked?: boolean;
  /** 带 click handler 的无语义元素被纳入 observe 的原因（issue #3），便于 Agent 区分来源。 */
  clickSource?: string;
  /** Native current value, bounded per field and observation; passwords omitted. */
  value?: string;
  valueTruncated?: true;
}

export interface Observation {
  observationId: string;
  tabId: TabId;
  documentEpoch: number;
  elements: ReadonlyArray<ObservedElement>;
}

/**
 * observe 列表与录制事件索引共用；改它会让所有已存录制的 nth 语义漂移，所以它只在这里出现一次。
 * issue #3：追加带明确可交互标记的无语义元素（onclick / tabindex / data-click / cursor:pointer），
 * 让 vue-weui-next 的 <dt onclick> 与委托 click 的纯 div 标签页进入候选。只对有标记的节点开放，
 * 避免无关 div 淹没结果；哪一类标记进来的由 semanticDetails 的 clickSource 标注。
 */
export const OBSERVE_SELECTOR =
  'a,button,input,textarea,select,[role],[contenteditable],[onclick],[tabindex],[data-click],[data-clickable],[style*="cursor"]';

/** applyEffect 的 elementKey 哨兵：press 不带 ref 时把按键发给 document.activeElement（issue #3）。 */
export const ACTIVE_ELEMENT_KEY = '__pilion_active__';

/**
 * 录制事件的目标上溯选择器。observe 必须把 contenteditable 宿主单列（自绘编辑器才能被 Agent
 * 观察与操作），但人点在编辑区内部时，点击/按键归属的仍是外层可交互外壳（卡片、按钮），
 * 不能让编辑宿主自身截胡——否则录制的点击从 role=button 外壳退化成无名 generic 元素。
 */
export const RECORD_SCOPE_SELECTOR = 'a,button,input,textarea,select,[role]';

/** 按键白名单只有 src/shared/press-keys.ts 一份；这里转出去，适配器、服务与录制脚本照旧从这里取。 */
export { PRESS_KEYS };
export type BrowserPressKey = PressKey;
export type BrowserPressModifier = 'Shift';

export type BrowserEffect =
  | { kind: 'click'; force?: boolean }
  /** 悬停：把指针移到目标（或其可悬停祖先）并停留，使 hover-only 子控件获得布局（issue #3）。 */
  | { kind: 'hover' }
  | { kind: 'type'; text: string; replace?: boolean }
  | { kind: 'select'; value: string }
  | { kind: 'check'; checked: boolean }
  | { kind: 'press'; key: BrowserPressKey; modifiers: ReadonlyArray<BrowserPressModifier> }
  | { kind: 'upload'; files: ReadonlyArray<string> }
  /** 指针面上按坐标的点击/移动/拖拽/滚轮，只对 canvas/video 有效（issue #7）。 */
  | { kind: 'pointer'; action: PointerAction };

export interface GrantContext {
  principalId: PrincipalId;
  tabId: TabId;
  elementRef: ElementRef;
  effect: BrowserEffect;
}

export interface VerifiedExecutionGrant {
  grantId: string;
  expiresAt: number;
}

export interface ExecutionGrantVerifier {
  /** Returns a verified, scoped grant or throws. The service never parses grants itself. */
  verify(grant: unknown, context: GrantContext): Promise<VerifiedExecutionGrant>;
}

export interface PreparedEffect {
  executionToken: string;
  tabId: TabId;
  documentEpoch: number;
  frameId: FrameId;
  frameEpoch: number;
  fencing: number;
  expiresAt: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  loading: boolean;
}
export interface PageScreenshot {
  mimeType: 'image/png' | 'image/jpeg';
  data: string;
  /** 自动降级后才会带上这些诊断字段；未降级时返回体保持最小，兼容旧契约。 */
  downgraded?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
  scale?: number;
  /**
   * 瞄准用的几何（issue #7）：图片像素宽高，与它覆盖的页面区域的 CSS 宽高。
   * 图里的像素 × cssWidth / width 就是 CSS 像素。读不出图片尺寸时四个字段都不给。
   */
  width?: number;
  height?: number;
  cssWidth?: number;
  cssHeight?: number;
  /** clip 有一部分在当前视口之外：那部分在图里是空白，不代表页面上没有内容。 */
  partial?: true;
}

/** 传给 BrowserPagePort.screenshot 的显式降采样参数（已由 CLI / 契约层校验过）。 */
export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  /** jpeg 质量 1..100；png 忽略。 */
  quality?: number;
  /** 输出缩放 0.1..1，经 CDP clip.scale 实现。 */
  scale?: number;
  /** 页面坐标下的裁剪区域（CSS 像素，按缩放换算后交给 CDP）；与 scale 合并为 CDP clip。 */
  clip?: { x: number; y: number; width: number; height: number };
}

export interface PageTextSnapshot {
  text: string;
  textTruncated?: true;
}

/** Safe element data returned by an Electron adapter; elementKey stays process-local. */
export interface PageObservedElement extends FileInputMetadata, PointerSurfaceMetadata {
  elementKey: string;
  frameId: FrameId;
  localFingerprint: string;
  role: string;
  name: string;
  disabled: boolean;
  tagName: string;
  inputType?: string;
  formAction?: string;
  optionValues?: ReadonlyArray<string>;
  checked?: boolean;
  /** 带 click handler 的无语义元素被纳入 observe 的原因（issue #3）。 */
  clickSource?: string;
  value?: string;
  valueTruncated?: true;
}

/** press/force 等动作的结果：ok 只表示已派发，effect 说明是否真正激活页面（issue #3）。 */
export interface ActionEffect {
  ok: boolean;
  /** activated：检测到页面状态变化；none：已派发但页面无变化；dispatched：无法检测，仅确认派发。 */
  effect: 'activated' | 'none' | 'dispatched';
  /** 检测方式，便于诊断。 */
  detectedBy?: string;
}

/** upload 后验回执：把「写入 input」与「页面确认接收」分开，绝不谎报成功（issue #4a）。 */
export interface UploadReceipt {
  ok: boolean;
  /** 请求的文件数。 */
  files: number;
  /** 回读 <input>.files 得到的实际文件数。 */
  appliedFiles: number;
  input: {
    accept: string;
    multiple: boolean;
    /** 页面内第几个 file input。 */
    index: number;
    label: string;
    visible: boolean;
  };
  /** applied：页面/DOM 已确认变化；unconfirmed：已写入但页面未确认；rejected：input 拒绝或消失。 */
  verified: 'applied' | 'unconfirmed' | 'rejected';
  /** verified !== 'applied' 时标记页面无效果。 */
  effect?: 'none';
  /** verified !== 'applied' 时的醒目提示。 */
  warning?: string;
  /** 回读到的文件名（便于复核）。 */
  names?: string[];
}

export type PageLifecycleEvent =
  | { kind: 'document-committed' }
  | { kind: 'frame-committed'; frameId: FrameId }
  | { kind: 'destroyed' };

/**
 * Narrow Electron boundary. Implementations may use WebContentsView/CDP internally,
 * but neither raw CDP nor arbitrary script/command execution crosses this interface.
 */
export interface BrowserPagePort {
  snapshot(): Promise<PageSnapshot>;
  screenshot(opts?: ScreenshotOptions): Promise<PageScreenshot>;
  readText?(): Promise<string>;
  readTextSnapshot?(): Promise<PageTextSnapshot>;
  /** 录制摘录用的正文：与 readText 同源，但输入框、文本域与编辑区里的字一律不带。可选：只有 Electron 适配器实现。 */
  readRecordableText?(): Promise<string>;
  navigate(canonicalUrl: string, signal?: AbortSignal): Promise<void>;
  /**
   * 视口内合成一次滚轮。可选：只有真实适配器实现；测试替身可省略。
   * 正数向下滚，单位是 CSS 像素。
   */
  scrollBy?(direction: 'up' | 'down', amount?: number, signal?: AbortSignal): Promise<void>;
  observeElements(
    signal?: AbortSignal,
    offset?: number,
    options?: ObserveOptions,
  ): Promise<ReadonlyArray<PageObservedElement>>;
  elementFingerprint(
    frameId: FrameId,
    elementKey: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  applyEffect(
    frameId: FrameId,
    elementKey: string,
    effect: BrowserEffect,
    signal?: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<void | UploadReceipt | ActionEffect>;
  /** 录制期间把 Pilion 自己的固定脚本放进隔离世界；页面 JS 看不到它。可选：只有 Electron 适配器实现。 */
  startRecording?(options: RecordingChannelOptions): Promise<void>;
  stopRecording?(): Promise<void>;
  setLifecycleListener(listener: (event: PageLifecycleEvent) => void): void;
  close(): Promise<void> | void;
}

export interface BrowserPageFactory {
  create(canonicalUrl: string): Promise<BrowserPagePort>;
}

export interface OpenTabRequest {
  principalId: PrincipalId;
  url: string;
}
/** observe 的内部选项：不来自 Agent 参数。 */
export interface ObserveOptions {
  /**
   * 默认 true：在常规候选之后追加 canvas/video 指针面（issue #7）。录制取词与技能回放传 false，
   * 让它们看到的列表与指针面出现之前完全一样，已存录制的目标匹配不受影响。
   */
  pointerSurfaces?: boolean;
}
export interface ObserveRequest extends ObserveOptions {
  principalId: PrincipalId;
  tabId: TabId;
  /** Zero-based element offset, default 0; must be an integer in [0, 100_000]. */
  offset?: number;
}
export interface NavigateRequest {
  principalId: PrincipalId;
  tabId: TabId;
  url: string;
}
export interface ScrollRequest {
  principalId: PrincipalId;
  tabId: TabId;
  direction: 'up' | 'down';
  /** CSS 像素；省略时由适配器按视口高度的 80% 计算。 */
  amount?: number;
}
export interface PrepareEffectRequest {
  principalId: PrincipalId;
  tabId: TabId;
  /** press 不带 ref 时可省略（发给 document.activeElement）。 */
  elementRef?: ElementRef;
  /** 省略 elementRef 的 press：仍走 tab 权限/grant/fencing/审批，但跳过具体元素身份校验。 */
  activeElement?: boolean;
  effect: BrowserEffect;
  grant?: unknown;
}
export interface ExecutePreparedRequest {
  principalId: PrincipalId;
  executionToken: string;
}
