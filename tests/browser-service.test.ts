import { describe, expect, it, vi } from 'vitest';
import {
  BrowserError,
  BrowserService,
  canonicalizeUrl,
  type BrowserEffect,
  type BrowserPagePort,
  type ElementRef,
  type PageLifecycleEvent,
} from '../src/main/browser/index';
import type { PageObservedElement } from '../src/main/browser/types';

class FakePage implements BrowserPagePort {
  listener: (event: PageLifecycleEvent) => void = () => undefined;
  fingerprint = 'button:save:1';
  tagName = 'button';
  role = 'button';
  inputType: string | undefined;
  optionValues: string[] | undefined;
  checked: boolean | undefined;
  value: string | undefined;
  valueTruncated: true | undefined;
  effects: BrowserEffect[] = [];
  navigations: string[] = [];
  scrolls: Array<{ direction: 'up' | 'down'; amount?: number }> = [];

  async snapshot() {
    return { url: 'https://example.com/', title: 'Example', loading: false };
  }
  async screenshot() {
    return { mimeType: 'image/png' as const, data: 'ZmFrZQ==' };
  }
  async navigate(url: string) {
    this.navigations.push(url);
  }
  async scrollBy(direction: 'up' | 'down', amount?: number) {
    this.scrolls.push({ direction, ...(amount === undefined ? {} : { amount }) });
  }
  async observeElements(): Promise<ReadonlyArray<PageObservedElement>> {
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
        value: this.value,
        valueTruncated: this.valueTruncated,
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

describe('BrowserService observed values', () => {
  it('preserves exact value snapshots and their truncation signal with trusted refs', async () => {
    const f = fixture();
    f.page.tagName = 'textarea';
    f.page.value = '  first\nsecond\n';
    const { tabId, ref } = await observed(f);
    await expect(f.service.describeElement('owner', tabId, ref)).resolves.toMatchObject({
      value: '  first\nsecond\n',
    });
    f.page.value = 'x'.repeat(100_000);
    f.page.valueTruncated = true;
    const later = await f.service.observe({ principalId: 'owner', tabId });
    expect(later.elements[0]).toMatchObject({
      value: 'x'.repeat(100_000),
      valueTruncated: true,
    });
    expect(later.elements[0].ref.localFingerprint).toBe(ref.localFingerprint);
    expect(later.elements[0]).not.toHaveProperty('elementKey');
    await expect(
      f.service.describeElement('owner', tabId, later.elements[0].ref),
    ).resolves.toMatchObject({ valueTruncated: true });
  });

  it.each([
    { label: 'ASCII', unit: 'a' },
    { label: 'multibyte', unit: '界😀' },
    { label: 'JSON escaped', unit: '"\\\n\u0000' },
  ])('bounds aggregate $label values without losing candidate refs', async ({ unit }) => {
    const f = fixture();
    const value = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
    const rows: PageObservedElement[] = Array.from({ length: 200 }, (_, index) => ({
      elementKey: `node-${index}`,
      frameId: 'main',
      localFingerprint: f.page.fingerprint,
      role: 'textbox',
      name: `Draft ${index}`,
      disabled: false,
      tagName: 'textarea',
      inputType: 'text',
      formAction: 'https://example.com/submit',
      optionValues: ['first', 'second'],
      checked: false,
      ...(index < 199 ? { value } : {}),
      ...(index === 0 ? { valueTruncated: true as const } : {}),
    }));
    vi.spyOn(f.page, 'observeElements').mockResolvedValue(rows);
    const { tabId } = await f.service.openTab({ principalId: 'owner', url: 'example.com' });

    const result = await f.service.observe({ principalId: 'owner', tabId });
    const valueRows = result.elements.filter((row) => row.value !== undefined);
    const valueBytes = valueRows.reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value), 'utf8'),
      0,
    );

    expect(valueBytes).toBeLessThanOrEqual(256 * 1024);
    expect(result.elements).toHaveLength(200);
    expect(valueRows).toHaveLength(199);
    expect(new Set(result.elements.map((row) => row.ref.id)).size).toBe(200);
    for (const [index, row] of result.elements.entries()) {
      expect(row).toMatchObject({
        role: rows[index].role,
        name: rows[index].name,
        disabled: rows[index].disabled,
        tagName: rows[index].tagName,
        inputType: rows[index].inputType,
        formAction: rows[index].formAction,
        optionValues: rows[index].optionValues,
        checked: rows[index].checked,
        ref: {
          tabId,
          frameId: 'main',
          documentEpoch: 0,
          frameEpoch: 0,
          localFingerprint: f.page.fingerprint,
        },
      });
      expect(row).not.toHaveProperty('elementKey');
      if (row.value !== undefined) {
        expect(row.value.length).toBeGreaterThan(0);
        expect(value.startsWith(row.value)).toBe(true);
        expect(row.valueTruncated).toBe(true);
        // The prefix must end at a code point boundary, including emoji.
        expect(
          Array.from(row.value).every(
            (char) => char.length === 2 || !/[\uD800-\uDFFF]/u.test(char),
          ),
        ).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(row.value), 'utf8')).toBeLessThanOrEqual(
          Math.floor((256 * 1024) / 199),
        );
      }
    }
    expect(result.elements[199]).not.toHaveProperty('value');
    expect(result.elements[199]).not.toHaveProperty('valueTruncated');
    await expect(
      f.service.describeElement('owner', tabId, result.elements[1].ref),
    ).resolves.toMatchObject({
      value: result.elements[1].value,
      valueTruncated: true,
    });
    expect(rows[1].value).toBe(value);
    expect(rows[1]).not.toHaveProperty('valueTruncated');
  });

  it('preserves exact small values and an existing adapter truncation signal', async () => {
    const f = fixture();
    const values = ['', "O'Connor\n", '"\\\t\u0000界😀', 'partial'];
    vi.spyOn(f.page, 'observeElements').mockResolvedValue(
      values.map((value, index) => ({
        elementKey: `node-${index}`,
        frameId: 'main',
        localFingerprint: f.page.fingerprint,
        role: 'textbox',
        name: `Draft ${index}`,
        disabled: false,
        tagName: 'textarea',
        value,
        ...(index === 3 ? { valueTruncated: true as const } : {}),
      })),
    );
    const { tabId } = await f.service.openTab({ principalId: 'owner', url: 'example.com' });

    const result = await f.service.observe({ principalId: 'owner', tabId });

    expect(result.elements.map((row) => row.value)).toEqual(values);
    for (const row of result.elements.slice(0, 3)) expect(row).not.toHaveProperty('valueTruncated');
    expect(result.elements[3].valueTruncated).toBe(true);
  });
});

describe('BrowserService observe pagination', () => {
  it('defaults to offset zero and preserves the observation shape', async () => {
    const f = fixture();
    const { tabId } = await f.service.openTab({ principalId: 'owner', url: 'example.com' });
    const query = vi.spyOn(f.page, 'observeElements');

    const observation = await f.service.observe({ principalId: 'owner', tabId });

    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), 0);
    expect(Object.keys(observation).sort()).toEqual([
      'documentEpoch',
      'elements',
      'observationId',
      'tabId',
    ]);
    expect(observation.elements).toHaveLength(1);
    expect(observation.elements[0]).toMatchObject({ role: 'button', name: 'Save' });
    expect(observation.elements[0]).not.toHaveProperty('elementKey');
  });

  it.each([0, 1, 199, 200, 100_000])('forwards valid offset %s to the page', async (offset) => {
    const f = fixture();
    const { tabId } = await f.service.openTab({ principalId: 'owner', url: 'example.com' });
    const query = vi.spyOn(f.page, 'observeElements');

    await f.service.observe({ principalId: 'owner', tabId, offset });

    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), offset);
  });

  it.each([
    { label: 'negative', value: -1 },
    { label: 'fractional', value: 0.5 },
    { label: 'over maximum', value: 100_001 },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'numeric string', value: '200' },
    { label: 'empty string', value: '' },
    { label: 'null', value: null },
    { label: 'true', value: true },
    { label: 'false', value: false },
    { label: 'object', value: {} },
    { label: 'array', value: [] },
    { label: 'bigint', value: 200n },
    { label: 'symbol', value: Symbol('offset') },
  ])('rejects $label offset before querying the page', async ({ value }) => {
    const f = fixture();
    const { tabId } = await f.service.openTab({ principalId: 'owner', url: 'example.com' });
    const query = vi.spyOn(f.page, 'observeElements');

    await expect(
      f.service.observe({ principalId: 'owner', tabId, offset: value as unknown as number }),
    ).rejects.toSatisfy(expectCode('INVALID_ARGUMENT'));
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the observation envelope when a page has no remaining elements', async () => {
    const f = fixture();
    const { tabId } = await f.service.openTab({ principalId: 'owner', url: 'example.com' });
    vi.spyOn(f.page, 'observeElements').mockResolvedValue([]);

    const observation = await f.service.observe({ principalId: 'owner', tabId, offset: 200 });

    expect(observation).toEqual({
      observationId: expect.any(String),
      tabId,
      documentEpoch: 0,
      elements: [],
    });
  });
});

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
    ['http://127.0.0.1', 'http://127.0.0.1/'],
    ['http://127.1', 'http://127.0.0.1/'],
    ['http://2130706433', 'http://127.0.0.1/'],
    ['http://[::1]', 'http://[::1]/'],
    ['http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]/'],
    ['http://10.0.0.2', 'http://10.0.0.2/'],
    ['http://192.168.1.1:8080', 'http://192.168.1.1:8080/'],
    ['http://desktop-my.byteintl.net/d/abc', 'http://desktop-my.byteintl.net/d/abc'],
  ])('allows browser navigation to private address %s', async (input, expected) => {
    await expect(canonicalizeUrl(input)).resolves.toBe(expected);
  });

  it('allows IANA public addresses adjacent to the special-purpose ranges', async () => {
    await expect(
      canonicalizeUrl('https://iana.org', {
        resolver: { resolve: async () => ['192.0.43.8', '2001:500:88:200::8'] },
      }),
    ).resolves.toBe('https://iana.org/');
    await expect(canonicalizeUrl('https://192.0.43.8')).resolves.toBe('https://192.0.43.8/');
  });

  it.each([
    ['example.com:8080/path', 'https://example.com:8080/path'],
    ['example.com:8080', 'https://example.com:8080/'],
  ])('reads %s from the address bar as a host and port', async (input, expected) => {
    await expect(canonicalizeUrl(input)).resolves.toBe(expected);
  });

  it('allows localhost typed with a port', async () => {
    await expect(canonicalizeUrl('localhost:3000')).resolves.toBe('https://localhost:3000/');
  });

  it.each(['http://localhost./', 'http://localhost.localdomain./'])(
    'allows %s despite the trailing dot',
    async (url) => {
      await expect(canonicalizeUrl(url)).resolves.toMatch(/^http:\/\/localhost/);
    },
  );
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

describe('scroll primitive', () => {
  it('forwards direction and amount to the page adapter', async () => {
    const { service, page, tabId } = await observed();
    await service.scroll({ principalId: 'owner', tabId, direction: 'down' });
    await service.scroll({ principalId: 'owner', tabId, direction: 'up', amount: 250 });
    expect(page.scrolls).toEqual([{ direction: 'down' }, { direction: 'up', amount: 250 }]);
  });

  it('reports UNSUPPORTED_ELEMENT when the adapter cannot scroll', async () => {
    const { service, page, tabId } = await observed();
    Object.defineProperty(page, 'scrollBy', { value: undefined, configurable: true });
    await expect(
      service.scroll({ principalId: 'owner', tabId, direction: 'down' }),
    ).rejects.toBeInstanceOf(BrowserError);
    await expect(
      service.scroll({ principalId: 'owner', tabId, direction: 'down' }),
    ).rejects.toSatisfy(expectCode('UNSUPPORTED_ELEMENT'));
  });
});

describe('upload effect target', () => {
  it('accepts input[type=file] and rejects any other target', async () => {
    const f = fixture();
    f.page.tagName = 'input';
    f.page.inputType = 'file';
    const { service, tabId, ref } = await observed(f);
    await expect(
      service.prepareEffect({
        principalId: 'owner',
        tabId,
        elementRef: ref,
        effect: { kind: 'upload', files: ['/tmp/photo.png'] },
        grant: 'grant-1',
      }),
    ).resolves.toMatchObject({ tabId });

    const g = fixture();
    g.page.tagName = 'button';
    const other = await observed(g);
    await expect(
      g.service.prepareEffect({
        principalId: 'owner',
        tabId: other.tabId,
        elementRef: other.ref,
        effect: { kind: 'upload', files: ['/tmp/photo.png'] },
        grant: 'grant-1',
      }),
    ).rejects.toSatisfy(expectCode('UNSUPPORTED_ELEMENT'));
  });

  it('rejects an empty file list', async () => {
    const f = fixture();
    f.page.tagName = 'input';
    f.page.inputType = 'file';
    const { service, tabId, ref } = await observed(f);
    await expect(
      service.prepareEffect({
        principalId: 'owner',
        tabId,
        elementRef: ref,
        effect: { kind: 'upload', files: [] },
        grant: 'grant-1',
      }),
    ).rejects.toSatisfy(expectCode('INVALID_ARGUMENT'));
  });
});
