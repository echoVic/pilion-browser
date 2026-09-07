import { randomUUID } from 'node:crypto';
import { BrowserError } from './errors.js';
import { TabRegistry, type RegisteredTab } from './tab-registry.js';
import type {
  BrowserEffect,
  BrowserPageFactory,
  BrowserServicePort,
  ElementRef,
  ExecutePreparedRequest,
  ExecutionGrantVerifier,
  HostResolver,
  NavigateRequest,
  Observation,
  ObservedElement,
  ObserveRequest,
  OpenTabRequest,
  PrepareEffectRequest,
  PreparedEffect,
  PrincipalId,
  TabAcl,
  TabId,
  TabPermission,
} from './types.js';
import { canonicalizeUrl } from './url-policy.js';
import { PRESS_KEYS } from './types.js';

interface StoredElement {
  ref: ElementRef;
  elementKey: string;
  role: string;
  name: string;
  disabled: boolean;
  tagName: string;
  inputType?: string;
  formAction?: string;
  optionValues?: ReadonlyArray<string>;
  checked?: boolean;
}

interface StoredPreparation extends PreparedEffect {
  principalId: PrincipalId;
  elementRef: ElementRef;
  elementKey: string;
  effect: BrowserEffect;
  generation: number;
}

export interface BrowserServiceOptions {
  pageFactory: BrowserPageFactory;
  grantVerifier: ExecutionGrantVerifier;
  resolver?: HostResolver;
  allowPrivateNetwork?: boolean;
  preparationTtlMs?: number;
  now?: () => number;
  idFactory?: () => string;
  registry?: TabRegistry;
  authorizePrincipal?: (principalId: PrincipalId) => void;
}

export class BrowserService implements BrowserServicePort {
  readonly registry: TabRegistry;
  private readonly elements = new Map<string, StoredElement>();
  private readonly preparations = new Map<string, StoredPreparation>();
  private readonly usedExecutionTokens = new Set<string>();
  private readonly principalGenerations = new Map<PrincipalId, number>();
  private readonly operations = new Map<PrincipalId, Set<AbortController>>();
  private readonly navigationTokens = new Map<TabId, symbol>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly preparationTtlMs: number;

  constructor(private readonly options: BrowserServiceOptions) {
    this.registry = options.registry ?? new TabRegistry();
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.preparationTtlMs = options.preparationTtlMs ?? 15_000;
  }

  async openTab(request: OpenTabRequest): Promise<{ tabId: TabId; url: string }> {
    this.requirePrincipal(request.principalId);
    return this.withOperation(request.principalId, async (signal, generation) => {
      const url = await this.safeUrl(request.url);
      this.assertContext(request.principalId, generation, signal);
      const page = await this.options.pageFactory.create(url);
      try {
        this.assertContext(request.principalId, generation, signal);
      } catch (error) {
        await page.close();
        throw error;
      }
      const tabId = this.idFactory();
      this.registry.add(tabId, page, request.principalId);
      page.setLifecycleListener((event) => {
        if (!this.registry.has(tabId)) return;
        if (event.kind === 'document-committed') this.registry.commitDocument(tabId);
        else if (event.kind === 'frame-committed') this.registry.commitFrame(tabId, event.frameId);
        else if (event.kind === 'destroyed') {
          this.registry.remove(tabId);
          this.dropTabState(tabId);
        }
      });
      return { tabId, url };
    });
  }

  async closeTab(principalId: PrincipalId, tabId: TabId): Promise<void> {
    const tab = this.registry.require(tabId, principalId, 'manage');
    this.registry.remove(tabId);
    this.dropTabState(tabId);
    await tab.page.close();
  }

  async navigate(request: NavigateRequest): Promise<{ url: string }> {
    return this.withOperation(request.principalId, async (signal, generation) => {
      this.registry.require(request.tabId, request.principalId, 'navigate');
      const url = await this.safeUrl(request.url);
      this.assertContext(request.principalId, generation, signal);
      const tab = this.registry.require(request.tabId, request.principalId, 'navigate');
      tab.fencing += 1;
      const expectedFencing = tab.fencing;
      this.assertContext(request.principalId, generation, signal);
      this.assertTabContext(request.tabId, request.principalId, 'navigate', expectedFencing);
      const navigationToken = Symbol(request.tabId);
      this.navigationTokens.set(request.tabId, navigationToken);
      try {
        await tab.page.navigate(url, signal);
        this.assertContext(request.principalId, generation, signal);
        this.registry.require(request.tabId, request.principalId, 'navigate');
        if (this.navigationTokens.get(request.tabId) !== navigationToken) {
          throw new BrowserError(
            'STALE_FENCING_TOKEN',
            'A newer navigation invalidated this operation',
            true,
          );
        }
      } finally {
        if (this.navigationTokens.get(request.tabId) === navigationToken)
          this.navigationTokens.delete(request.tabId);
      }
      return { url };
    });
  }

  async observe(request: ObserveRequest): Promise<Observation> {
    return this.withOperation(request.principalId, async (signal, generation) => {
      let tab = this.registry.require(request.tabId, request.principalId, 'observe');
      const expectedFencing = tab.fencing;
      const expectedDocumentEpoch = tab.documentEpoch;
      const rows = await tab.page.observeElements(signal);
      this.assertContext(request.principalId, generation, signal);
      tab = this.assertTabContext(request.tabId, request.principalId, 'observe', expectedFencing);
      if (tab.documentEpoch !== expectedDocumentEpoch)
        throw new BrowserError('STALE_ELEMENT', 'Document changed while observing', true);
      const observationId = this.idFactory();
      const elements = rows.map((row) => {
        const frameEpoch = tab.frameEpochs.get(row.frameId) ?? 0;
        if (!tab.frameEpochs.has(row.frameId)) tab.frameEpochs.set(row.frameId, frameEpoch);
        const ref: ElementRef = Object.freeze({
          id: this.idFactory(),
          tabId: tab.id,
          frameId: row.frameId,
          documentEpoch: tab.documentEpoch,
          frameEpoch,
          localFingerprint: row.localFingerprint,
        });
        this.elements.set(ref.id, {
          ref,
          elementKey: row.elementKey,
          role: row.role,
          name: row.name,
          disabled: row.disabled,
          tagName: row.tagName,
          inputType: row.inputType,
          formAction: row.formAction,
          optionValues: row.optionValues ? [...row.optionValues] : undefined,
          checked: row.checked,
        });
        return {
          ref,
          role: row.role,
          name: row.name,
          disabled: row.disabled,
          tagName: row.tagName,
          inputType: row.inputType,
          formAction: row.formAction,
          optionValues: row.optionValues ? [...row.optionValues] : undefined,
          checked: row.checked,
        };
      });
      return { observationId, tabId: tab.id, documentEpoch: tab.documentEpoch, elements };
    });
  }

  async describeElement(
    principalId: PrincipalId,
    tabId: TabId,
    elementRef: ElementRef,
  ): Promise<Omit<ObservedElement, 'ref'>> {
    return this.withOperation(principalId, async (signal, generation) => {
      const tab = this.registry.require(tabId, principalId, 'observe');
      const element = await this.requireFreshElement(tab, elementRef, signal);
      this.assertContext(principalId, generation, signal);
      this.registry.require(tabId, principalId, 'observe');
      return {
        role: element.role,
        name: element.name,
        disabled: element.disabled,
        tagName: element.tagName,
        inputType: element.inputType,
        formAction: element.formAction,
        optionValues: element.optionValues ? [...element.optionValues] : undefined,
        checked: element.checked,
      };
    });
  }

  async prepareEffect(request: PrepareEffectRequest): Promise<PreparedEffect> {
    return this.withOperation(request.principalId, async (signal, generation) => {
      let tab = this.registry.require(request.tabId, request.principalId, 'effect');
      const element = await this.requireFreshElement(tab, request.elementRef, signal);
      this.validateEffectTarget(element, request.effect);
      this.assertContext(request.principalId, generation, signal);
      this.registry.require(request.tabId, request.principalId, 'effect');
      if (request.grant === undefined || request.grant === null)
        throw new BrowserError('GRANT_REQUIRED', 'An execution grant is required');
      let grantExpiresAt: number;
      try {
        const verified = await this.options.grantVerifier.verify(request.grant, {
          principalId: request.principalId,
          tabId: request.tabId,
          elementRef: request.elementRef,
          effect: request.effect,
        });
        this.assertContext(request.principalId, generation, signal);
        tab = this.registry.require(request.tabId, request.principalId, 'effect');
        const revalidated = await this.requireFreshElement(tab, request.elementRef, signal);
        this.validateEffectTarget(revalidated, request.effect);
        this.assertContext(request.principalId, generation, signal);
        tab = this.registry.require(request.tabId, request.principalId, 'effect');
        if (!verified.grantId || verified.expiresAt <= this.now())
          throw new Error('Grant is missing an id or has expired');
        grantExpiresAt = verified.expiresAt;
      } catch (error) {
        if (error instanceof BrowserError) throw error;
        throw new BrowserError('INVALID_GRANT', 'Execution grant was rejected', false, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      this.assertContext(request.principalId, generation, signal);
      tab = this.registry.require(request.tabId, request.principalId, 'effect');
      tab.fencing += 1;
      const prepared: StoredPreparation = {
        executionToken: this.idFactory(),
        tabId: tab.id,
        documentEpoch: tab.documentEpoch,
        frameId: request.elementRef.frameId,
        frameEpoch: request.elementRef.frameEpoch,
        fencing: tab.fencing,
        expiresAt: Math.min(this.now() + this.preparationTtlMs, grantExpiresAt),
        principalId: request.principalId,
        elementRef: request.elementRef,
        elementKey: element.elementKey,
        effect: cloneEffect(request.effect),
        generation,
      };
      this.preparations.set(prepared.executionToken, prepared);
      return this.publicPreparation(prepared);
    });
  }

  async executePrepared(request: ExecutePreparedRequest): Promise<{ ok: true }> {
    return this.withOperation(request.principalId, async (signal, generation) => {
      if (this.usedExecutionTokens.has(request.executionToken))
        throw new BrowserError('EXECUTION_TOKEN_USED', 'Execution token has already been consumed');
      const prepared = this.preparations.get(request.executionToken);
      if (!prepared)
        throw new BrowserError('PREPARATION_NOT_FOUND', 'Prepared effect does not exist');
      if (prepared.generation !== generation) {
        this.preparations.delete(request.executionToken);
        throw new BrowserError('STALE_FENCING_TOKEN', 'Execution generation was revoked', true);
      }
      let tab = this.registry.require(prepared.tabId, request.principalId, 'effect');
      if (prepared.principalId !== request.principalId)
        throw new BrowserError('PERMISSION_DENIED', 'Execution token belongs to another principal');
      if (prepared.expiresAt <= this.now()) {
        this.preparations.delete(request.executionToken);
        throw new BrowserError('PREPARATION_EXPIRED', 'Prepared effect has expired', true);
      }
      if (prepared.fencing !== tab.fencing) {
        this.preparations.delete(request.executionToken);
        throw new BrowserError(
          'STALE_FENCING_TOKEN',
          'A newer tab operation fenced this token',
          true,
        );
      }
      await this.requireFreshElement(tab, prepared.elementRef, signal);
      this.assertContext(request.principalId, generation, signal);
      tab = this.registry.require(prepared.tabId, request.principalId, 'effect');
      if (
        prepared.generation !== this.generation(request.principalId) ||
        prepared.fencing !== tab.fencing
      ) {
        this.preparations.delete(request.executionToken);
        throw new BrowserError(
          'STALE_FENCING_TOKEN',
          'Execution was revoked before dispatch',
          true,
        );
      }
      this.preparations.delete(request.executionToken);
      this.usedExecutionTokens.add(request.executionToken);
      this.assertContext(request.principalId, generation, signal);
      this.registry.require(prepared.tabId, request.principalId, 'effect');
      await tab.page.applyEffect(
        prepared.frameId,
        prepared.elementKey,
        cloneEffect(prepared.effect),
        signal,
      );
      this.assertContext(request.principalId, generation, signal);
      return { ok: true };
    });
  }

  invalidatePrincipal(principalId: PrincipalId): void {
    this.principalGenerations.set(principalId, this.generation(principalId) + 1);
    for (const controller of this.operations.get(principalId) ?? []) controller.abort();
    this.operations.delete(principalId);
    for (const [token, prepared] of this.preparations) {
      if (prepared.principalId === principalId) this.preparations.delete(token);
    }
    for (const tab of this.registry.listFor(principalId)) {
      tab.fencing += 1;
      this.navigationTokens.delete(tab.id);
    }
  }

  setTabAcl(actor: PrincipalId, tabId: TabId, acl: TabAcl): void {
    this.registry.setAcl(actor, tabId, acl);
  }

  private validateEffectTarget(element: StoredElement, effect: BrowserEffect): void {
    if (element.disabled)
      throw new BrowserError('UNSUPPORTED_ELEMENT', 'Effect target is disabled');
    if (effect.kind === 'select') {
      if (element.tagName !== 'select')
        throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.select requires a <select> target');
      if (!element.optionValues?.includes(effect.value))
        throw new BrowserError(
          'OPTION_NOT_FOUND',
          'Requested option does not exist in the observed <select>',
        );
    }
    if (
      effect.kind === 'check' &&
      (element.tagName !== 'input' || !['checkbox', 'radio'].includes(element.inputType ?? ''))
    ) {
      throw new BrowserError(
        'UNSUPPORTED_ELEMENT',
        'browser.check requires an input[type=checkbox|radio] target',
      );
    }
    if (effect.kind === 'check' && element.inputType === 'radio' && effect.checked === false) {
      throw new BrowserError('UNSUPPORTED_ELEMENT', 'A radio control cannot be unchecked directly');
    }
    if (
      effect.kind === 'press' &&
      (!PRESS_KEYS.includes(effect.key) ||
        !Array.isArray(effect.modifiers) ||
        effect.modifiers.length > 1 ||
        effect.modifiers.some((modifier) => modifier !== 'Shift'))
    )
      throw new BrowserError(
        'KEY_NOT_ALLOWED',
        'Key or modifier is not in the browser.press allowlist',
      );
  }

  private async requireFreshElement(
    tab: RegisteredTab,
    candidate: ElementRef,
    signal?: AbortSignal,
  ): Promise<StoredElement> {
    const stored = this.elements.get(candidate.id);
    const frameEpoch = tab.frameEpochs.get(candidate.frameId) ?? 0;
    if (
      !stored ||
      stored.ref.tabId !== tab.id ||
      candidate.tabId !== tab.id ||
      stored.ref.frameId !== candidate.frameId ||
      stored.ref.documentEpoch !== candidate.documentEpoch ||
      stored.ref.frameEpoch !== candidate.frameEpoch ||
      stored.ref.localFingerprint !== candidate.localFingerprint ||
      candidate.documentEpoch !== tab.documentEpoch ||
      candidate.frameEpoch !== frameEpoch
    ) {
      throw new BrowserError('STALE_ELEMENT', 'Element reference is stale', true);
    }
    const expectedDocumentEpoch = tab.documentEpoch;
    const expectedFrameEpoch = frameEpoch;
    const currentFingerprint = await tab.page.elementFingerprint(
      candidate.frameId,
      stored.elementKey,
      signal,
    );
    if (signal?.aborted) throw new BrowserError('PERMISSION_DENIED', 'Operation was revoked');
    if (
      tab.documentEpoch !== expectedDocumentEpoch ||
      (tab.frameEpochs.get(candidate.frameId) ?? 0) !== expectedFrameEpoch
    ) {
      throw new BrowserError('STALE_ELEMENT', 'Element changed while being validated', true);
    }
    if (currentFingerprint === undefined || currentFingerprint !== candidate.localFingerprint) {
      throw new BrowserError('STALE_ELEMENT', 'Element identity changed', true);
    }
    return stored;
  }

  private assertTabContext(
    tabId: TabId,
    principalId: PrincipalId,
    permission: TabPermission,
    fencing: number,
  ): RegisteredTab {
    const tab = this.registry.require(tabId, principalId, permission);
    if (tab.fencing !== fencing)
      throw new BrowserError(
        'STALE_FENCING_TOKEN',
        'A newer tab operation invalidated this operation',
        true,
      );
    return tab;
  }

  private generation(principalId: PrincipalId): number {
    return this.principalGenerations.get(principalId) ?? 0;
  }

  private assertContext(principalId: PrincipalId, generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.generation(principalId)) {
      throw new BrowserError('PERMISSION_DENIED', 'Operation was revoked');
    }
    this.options.authorizePrincipal?.(principalId);
  }

  private async withOperation<T>(
    principalId: PrincipalId,
    operation: (signal: AbortSignal, generation: number) => Promise<T>,
  ): Promise<T> {
    this.options.authorizePrincipal?.(principalId);
    const generation = this.generation(principalId);
    const controller = new AbortController();
    const active = this.operations.get(principalId) ?? new Set<AbortController>();
    active.add(controller);
    this.operations.set(principalId, active);
    try {
      return await operation(controller.signal, generation);
    } finally {
      active.delete(controller);
      if (!active.size) this.operations.delete(principalId);
    }
  }

  private safeUrl(raw: string): Promise<string> {
    return canonicalizeUrl(raw, {
      resolver: this.options.resolver,
      allowPrivateNetwork: this.options.allowPrivateNetwork,
    });
  }

  private dropTabState(tabId: TabId): void {
    for (const [id, element] of this.elements)
      if (element.ref.tabId === tabId) this.elements.delete(id);
    for (const [token, prepared] of this.preparations)
      if (prepared.tabId === tabId) this.preparations.delete(token);
  }

  private publicPreparation(prepared: StoredPreparation): PreparedEffect {
    const { executionToken, tabId, documentEpoch, frameId, frameEpoch, fencing, expiresAt } =
      prepared;
    return { executionToken, tabId, documentEpoch, frameId, frameEpoch, fencing, expiresAt };
  }

  private requirePrincipal(principalId: string): void {
    if (!principalId.trim()) throw new BrowserError('INVALID_ARGUMENT', 'Principal id is required');
  }
}

function cloneEffect(effect: BrowserEffect): BrowserEffect {
  if (effect.kind === 'click') return { kind: 'click' };
  if (effect.kind === 'type')
    return {
      kind: 'type',
      text: effect.text,
      ...(effect.replace === undefined ? {} : { replace: effect.replace }),
    };
  if (effect.kind === 'select') return { kind: 'select', value: effect.value };
  if (effect.kind === 'check') return { kind: 'check', checked: effect.checked };
  return { kind: 'press', key: effect.key, modifiers: [...effect.modifiers] };
}
