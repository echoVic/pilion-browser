import { describe, expect, it, vi } from 'vitest';
import {
  BrowserError,
  BrowserService,
  canonicalizeUrl,
  installNetworkBoundary,
  validateNetworkRequestUrl,
  type BrowserEffect,
  type BrowserPagePort,
  type ElementRef,
  type PageLifecycleEvent,
} from '../src/main/browser/index';

class FakePage implements BrowserPagePort {
  listener: (event: PageLifecycleEvent) => void = () => undefined;
  fingerprint = 'button:save:1';
  tagName = 'button';
  role = 'button';
  inputType: string | undefined;
  optionValues: string[] | undefined;
  checked: boolean | undefined;
  effects: BrowserEffect[] = [];
  navigations: string[] = [];

  async snapshot() {
    return { url: 'https://example.com/', title: 'Example', loading: false };
  }
  async screenshot() {
    return { mimeType: 'image/png' as const, data: 'ZmFrZQ==' };
  }
  async navigate(url: string) {
    this.navigations.push(url);
  }
  async observeElements() {
    return [
      {
        elementKey: 'internal-node-7',
        frameId: 'main',
        localFingerprint: this.fingerprint,
        role: this.role,
        name: 'Save',
        disabled: false,
        tagName: this.tagName,
        inputType: this.inputType,
        optionValues: this.optionValues,
        checked: this.checked,
      },
    ];
  }
  async elementFingerprint() {
    return this.fingerprint || undefined;
  }
  async applyEffect(_frameId: string, elementKey: string, effect: BrowserEffect) {
    expect(elementKey).toBe('internal-node-7');
    this.effects.push(effect);
  }
  setLifecycleListener(listener: (event: PageLifecycleEvent) => void) {
    this.listener = listener;
  }
  close() {
    return undefined;
  }
  emit(event: PageLifecycleEvent) {
    this.listener(event);
  }
}

function fixture() {
  const page = new FakePage();
  let id = 0;
  const verifier = { verify: vi.fn(async () => ({ grantId: 'grant-1', expiresAt: 10_000 })) };
  const service = new BrowserService({
    pageFactory: { create: vi.fn(async () => page) },
    grantVerifier: verifier,
    resolver: { resolve: vi.fn(async () => ['93.184.216.34']) },
    now: () => 1_000,
    idFactory: () => `id-${++id}`,
  });
  return { service, page, verifier };
}

async function observed(f = fixture()) {
  const opened = await f.service.openTab({ principalId: 'owner', url: 'example.com' });
  const observation = await f.service.observe({ principalId: 'owner', tabId: opened.tabId });
  return { ...f, tabId: opened.tabId, ref: observation.elements[0].ref };
}

function expectCode(code: string) {
  return (error: unknown) => {
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe(code);
    return true;
  };
}

describe('BrowserService element lifetime', () => {
  it('returns trusted observed semantics and rejects a forged ref', async () => {
    const f = await observed();
    await expect(f.service.describeElement('owner', f.tabId, f.ref)).resolves.toEqual({
      role: 'button',
      name: 'Save',
      disabled: false,
      tagName: 'button',
    });
    await expect(
      f.service.describeElement('owner', f.tabId, { ...f.ref, localFingerprint: 'forged' }),
    ).rejects.toSatisfy(expectCode('STALE_ELEMENT'));
  });

  it('rejects a ref after a document commit', async () => {
    const f = await observed();
    f.page.emit({ kind: 'document-committed' });
    await expect(
      f.service.prepareEffect({
        principalId: 'owner',
        tabId: f.tabId,
        elementRef: f.ref,
        effect: { kind: 'click' },
        grant: 'signed-grant',
      }),
    ).rejects.toSatisfy(expectCode('STALE_ELEMENT'));
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });

  it('checks frame epoch and local fingerprint', async () => {
    const f = await observed();
    f.page.fingerprint = 'button:replaced:2';
    await expect(
      f.service.prepareEffect({
        principalId: 'owner',
        tabId: f.tabId,
        elementRef: f.ref,
        effect: { kind: 'click' },
        grant: 'signed-grant',
      }),
    ).rejects.toSatisfy(expectCode('STALE_ELEMENT'));

    f.page.fingerprint = f.ref.localFingerprint;
    f.page.emit({ kind: 'frame-committed', frameId: 'main' });
    await expect(
      f.service.prepareEffect({
        principalId: 'owner',
        tabId: f.tabId,
        elementRef: f.ref,
        effect: { kind: 'click' },
        grant: 'signed-grant',
      }),
    ).rejects.toSatisfy(expectCode('STALE_ELEMENT'));
  });

  it('rejects forged ref fields even when the opaque id exists', async () => {
    const f = await observed();
    const forged: ElementRef = { ...f.ref, localFingerprint: 'forged' };
    await expect(
      f.service.prepareEffect({
        principalId: 'owner',
        tabId: f.tabId,
        elementRef: forged,
        effect: { kind: 'click' },
        grant: 'signed-grant',
      }),
    ).rejects.toSatisfy(expectCode('STALE_ELEMENT'));
  });
});

describe('Tab ACL', () => {
  it('enforces observer/operator/owner permissions', async () => {
    const f = await observed();
    f.service.setTabAcl('owner', f.tabId, {
      entries: [
        { principalId: 'owner', role: 'owner' },
        { principalId: 'reader', role: 'observer' },
        { principalId: 'agent', role: 'operator' },
      ],
    });

    await expect(
      f.service.observe({ principalId: 'reader', tabId: f.tabId }),
    ).resolves.toBeDefined();
    await expect(
      f.service.navigate({ principalId: 'reader', tabId: f.tabId, url: 'example.org' }),
    ).rejects.toSatisfy(expectCode('PERMISSION_DENIED'));
    await expect(
      f.service.navigate({ principalId: 'agent', tabId: f.tabId, url: 'example.org' }),
    ).resolves.toEqual({ url: 'https://example.org/' });
    expect(() =>
      f.service.setTabAcl('agent', f.tabId, { entries: [{ principalId: 'agent', role: 'owner' }] }),
    ).toThrowError(BrowserError);
  });
});

describe('URL policy', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x'])(
    'blocks dangerous protocol %s',
    async (url) => {
      await expect(canonicalizeUrl(url)).rejects.toSatisfy(expectCode('DANGEROUS_URL'));
    },
  );

  it.each([
    'http://127.0.0.1',
    'http://127.255.255.254',
    'http://127.1',
    'http://2130706433',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://10.0.0.2',
    'http://169.254.169.254',
    'http://192.0.0.8',
    'http://192.0.2.1',
  ])('blocks private address %s', async (url) => {
    await expect(canonicalizeUrl(url)).rejects.toSatisfy(expectCode('PRIVATE_NETWORK_BLOCKED'));
  });

  it('allows IANA public addresses adjacent to the special-purpose ranges', async () => {
    await expect(
      canonicalizeUrl('https://iana.org', {
        resolver: { resolve: async () => ['192.0.43.8', '2001:500:88:200::8'] },
      }),
    ).resolves.toBe('https://iana.org/');
    await expect(canonicalizeUrl('https://192.0.43.8')).resolves.toBe('https://192.0.43.8/');
  });

  it('installs a fail-closed request hook for documents, subresources and WebSockets', async () => {
    let filter: { urls: string[] } | undefined;
    let listener:
      | ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void)
      | undefined;
    const fakeSession = {
      webRequest: {
        onBeforeRequest: (nextFilter: { urls: string[] }, nextListener: typeof listener) => {
          filter = nextFilter;
          listener = nextListener;
        },
      },
    };
    installNetworkBoundary(fakeSession as unknown as Parameters<typeof installNetworkBoundary>[0], {
      resolve: async () => ['127.0.0.1'],
    });
    expect(filter?.urls).toEqual(
      expect.arrayContaining(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']),
    );
    const result = await new Promise<{ cancel: boolean }>((resolve) =>
      listener!({ url: 'https://cdn.example/private.js' }, resolve),
    );
    expect(result).toEqual({ cancel: true });
    await expect(
      validateNetworkRequestUrl('wss://socket.example/events', {
        resolve: async () => ['10.2.3.4'],
      }),
    ).rejects.toSatisfy(expectCode('PRIVATE_NETWORK_BLOCKED'));
    await expect(
      validateNetworkRequestUrl('https://redirect-target.example/image.png', {
        resolve: async () => ['192.168.1.8'],
      }),
    ).rejects.toSatisfy(expectCode('PRIVATE_NETWORK_BLOCKED'));
  });
});

describe('two-phase execution gate', () => {
  it('requires a grant and never calls verifier when absent', async () => {
    const f = await observed();
    await expect(
      f.service.prepareEffect({
        principalId: 'owner',
        tabId: f.tabId,
        elementRef: f.ref,
        effect: { kind: 'click' },
      }),
    ).rejects.toSatisfy(expectCode('GRANT_REQUIRED'));
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });

  it('fences an older prepared token when a newer one is prepared', async () => {
    const f = await observed();
    const first = await f.service.prepareEffect({
      principalId: 'owner',
      tabId: f.tabId,
      elementRef: f.ref,
      effect: { kind: 'click' },
      grant: 'grant-a',
    });
    const second = await f.service.prepareEffect({
      principalId: 'owner',
      tabId: f.tabId,
      elementRef: f.ref,
      effect: { kind: 'click' },
      grant: 'grant-b',
    });

    await expect(
      f.service.executePrepared({ principalId: 'owner', executionToken: first.executionToken }),
    ).rejects.toSatisfy(expectCode('STALE_FENCING_TOKEN'));
    await expect(
      f.service.executePrepared({ principalId: 'owner', executionToken: second.executionToken }),
    ).resolves.toEqual({ ok: true });
    expect(f.page.effects).toEqual([{ kind: 'click' }]);
  });

  it('invalidates prepared tokens when a principal is revoked', async () => {
    const f = await observed();
    const prepared = await f.service.prepareEffect({
      principalId: 'owner',
      tabId: f.tabId,
      elementRef: f.ref,
      effect: { kind: 'click' },
      grant: 'grant',
    });
    f.service.invalidatePrincipal('owner');
    await expect(
      f.service.executePrepared({ principalId: 'owner', executionToken: prepared.executionToken }),
    ).rejects.toSatisfy(expectCode('PREPARATION_NOT_FOUND'));
    expect(f.page.effects).toHaveLength(0);
  });

  it('cancels an in-flight effect when authorization is revoked', async () => {
    const f = await observed();
    const prepared = await f.service.prepareEffect({
      principalId: 'owner',
      tabId: f.tabId,
      elementRef: f.ref,
      effect: { kind: 'click' },
      grant: 'grant',
    });
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.page.applyEffect = vi.fn(async (_frameId, _key, _effect, signal?: AbortSignal) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    });
    const execution = f.service.executePrepared({
      principalId: 'owner',
      executionToken: prepared.executionToken,
    });
    await dispatched;
    f.service.invalidatePrincipal('owner');
    await expect(execution).rejects.toThrow('aborted');
  });
});

describe('select/check/press target gates', () => {
  it('validates select tag and observed option before consuming a grant', async () => {
    const invalid = await observed();
    await expect(
      invalid.service.prepareEffect({
        principalId: 'owner',
        tabId: invalid.tabId,
        elementRef: invalid.ref,
        effect: { kind: 'select', value: 'prod' },
        grant: 'grant',
      }),
    ).rejects.toSatisfy(expectCode('UNSUPPORTED_ELEMENT'));
    expect(invalid.verifier.verify).not.toHaveBeenCalled();

    const configured = fixture();
    configured.page.tagName = 'select';
    configured.page.role = 'combobox';
    configured.page.optionValues = ['dev', 'prod'];
    const valid = await observed(configured);
    const prepared = await valid.service.prepareEffect({
      principalId: 'owner',
      tabId: valid.tabId,
      elementRef: valid.ref,
      effect: { kind: 'select', value: 'prod' },
      grant: 'grant',
    });
    await expect(
      valid.service.executePrepared({
        principalId: 'owner',
        executionToken: prepared.executionToken,
      }),
    ).resolves.toEqual({ ok: true });
    expect(valid.page.effects).toEqual([{ kind: 'select', value: 'prod' }]);

    const missing = fixture();
    missing.page.tagName = 'select';
    missing.page.role = 'combobox';
    missing.page.optionValues = ['dev'];
    const missingObserved = await observed(missing);
    await expect(
      missingObserved.service.prepareEffect({
        principalId: 'owner',
        tabId: missingObserved.tabId,
        elementRef: missingObserved.ref,
        effect: { kind: 'select', value: 'prod' },
        grant: 'grant',
      }),
    ).rejects.toSatisfy(expectCode('OPTION_NOT_FOUND'));
  });

  it('allows check only for checkbox/radio and carries desired state through the prepared effect', async () => {
    const invalid = await observed();
    await expect(
      invalid.service.prepareEffect({
        principalId: 'owner',
        tabId: invalid.tabId,
        elementRef: invalid.ref,
        effect: { kind: 'check', checked: true },
        grant: 'grant',
      }),
    ).rejects.toSatisfy(expectCode('UNSUPPORTED_ELEMENT'));

    const configured = fixture();
    configured.page.tagName = 'input';
    configured.page.role = 'checkbox';
    configured.page.inputType = 'checkbox';
    configured.page.checked = false;
    const valid = await observed(configured);
    const prepared = await valid.service.prepareEffect({
      principalId: 'owner',
      tabId: valid.tabId,
      elementRef: valid.ref,
      effect: { kind: 'check', checked: true },
      grant: 'grant',
    });
    await valid.service.executePrepared({
      principalId: 'owner',
      executionToken: prepared.executionToken,
    });
    expect(valid.page.effects).toEqual([{ kind: 'check', checked: true }]);
  });

  it('binds an allowlisted press and controlled modifier into the one-shot execution', async () => {
    const rejected = await observed();
    await expect(
      rejected.service.prepareEffect({
        principalId: 'owner',
        tabId: rejected.tabId,
        elementRef: rejected.ref,
        effect: { kind: 'press', key: 'F4', modifiers: ['Alt'] } as unknown as BrowserEffect,
        grant: 'grant',
      }),
    ).rejects.toSatisfy(expectCode('KEY_NOT_ALLOWED'));
    expect(rejected.verifier.verify).not.toHaveBeenCalled();

    const f = await observed();
    const effect = { kind: 'press', key: 'Enter', modifiers: ['Shift'] } as const;
    const prepared = await f.service.prepareEffect({
      principalId: 'owner',
      tabId: f.tabId,
      elementRef: f.ref,
      effect,
      grant: 'grant',
    });
    expect(f.verifier.verify).toHaveBeenCalledWith('grant', expect.objectContaining({ effect }));
    await f.service.executePrepared({
      principalId: 'owner',
      executionToken: prepared.executionToken,
    });
    expect(f.page.effects).toEqual([effect]);
  });
});
