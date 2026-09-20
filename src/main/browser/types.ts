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

export interface EpochSnapshot {
  documentEpoch: number;
  frameEpochs: Readonly<Record<FrameId, number>>;
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

export interface ObservedElement {
  ref: ElementRef;
  role: string;
  name: string;
  disabled: boolean;
  tagName: string;
  inputType?: string;
  formAction?: string;
  optionValues?: ReadonlyArray<string>;
  checked?: boolean;
}

export interface Observation {
  observationId: string;
  tabId: TabId;
  documentEpoch: number;
  elements: ReadonlyArray<ObservedElement>;
}

/** observe 与录制脚本共用；改它会让所有已存录制的 nth 语义漂移，所以它只在这里出现一次。 */
export const OBSERVE_SELECTOR = 'a,button,input,textarea,select,[role]';

export const PRESS_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  'Space',
] as const;
export type BrowserPressKey = (typeof PRESS_KEYS)[number];
export type BrowserPressModifier = 'Shift';

export type BrowserEffect =
  | { kind: 'click' }
  | { kind: 'type'; text: string; replace?: boolean }
  | { kind: 'select'; value: string }
  | { kind: 'check'; checked: boolean }
  | { kind: 'press'; key: BrowserPressKey; modifiers: ReadonlyArray<BrowserPressModifier> };

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
  mimeType: 'image/png';
  data: string;
}

/** Safe element data returned by an Electron adapter; elementKey stays process-local. */
export interface PageObservedElement {
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
  screenshot(): Promise<PageScreenshot>;
  readText?(): Promise<string>;
  navigate(canonicalUrl: string, signal?: AbortSignal): Promise<void>;
  observeElements(signal?: AbortSignal): Promise<ReadonlyArray<PageObservedElement>>;
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
  ): Promise<void>;
  setLifecycleListener(listener: (event: PageLifecycleEvent) => void): void;
  close(): Promise<void> | void;
}

export interface BrowserPageFactory {
  create(canonicalUrl: string): Promise<BrowserPagePort>;
}

export interface HostResolver {
  resolve(hostname: string): Promise<ReadonlyArray<string>>;
}

export interface OpenTabRequest {
  principalId: PrincipalId;
  url: string;
}
export interface ObserveRequest {
  principalId: PrincipalId;
  tabId: TabId;
}
export interface NavigateRequest {
  principalId: PrincipalId;
  tabId: TabId;
  url: string;
}
export interface PrepareEffectRequest {
  principalId: PrincipalId;
  tabId: TabId;
  elementRef: ElementRef;
  effect: BrowserEffect;
  grant?: unknown;
}
export interface ExecutePreparedRequest {
  principalId: PrincipalId;
  executionToken: string;
}

/** Deliberately has no execute(command) or CDP escape hatch. */
export interface BrowserServicePort {
  openTab(request: OpenTabRequest): Promise<{ tabId: TabId; url: string }>;
  closeTab(principalId: PrincipalId, tabId: TabId): Promise<void>;
  setTabAcl(actor: PrincipalId, tabId: TabId, acl: TabAcl): void;
  navigate(request: NavigateRequest): Promise<{ url: string }>;
  observe(request: ObserveRequest): Promise<Observation>;
  describeElement(
    principalId: PrincipalId,
    tabId: TabId,
    elementRef: ElementRef,
  ): Promise<Omit<ObservedElement, 'ref'>>;
  invalidatePrincipal(principalId: PrincipalId): void;
  prepareEffect(request: PrepareEffectRequest): Promise<PreparedEffect>;
  executePrepared(request: ExecutePreparedRequest): Promise<{ ok: true }>;
}
