import { describe, expect, it, vi } from 'vitest';
import { RecordingCapture } from '../src/main/recording/capture';
import { playSteps, samePage } from '../src/main/recording/player';
import { project } from '../src/main/recording/project';
import {
  REDACTED,
  URL_REDACTED_REASON,
  hasRedactedSecret,
  redactUrl,
} from '../src/main/recording/redact';
import { LoggedEventSchema, type Step } from '../src/main/recording/types';

describe('redactUrl', () => {
  it('凭据参数只换值，参数名与其它参数逐字节不变', () => {
    expect(redactUrl('https://a.com/cb?q=a%20b&flag&code=xyz&state=s1')).toBe(
      'https://a.com/cb?q=a%20b&flag&code=REDACTED&state=s1',
    );
  });

  it('参数名不分大小写，编码过的名字与以 token、secret、signature 结尾的名字也认', () => {
    expect(
      redactUrl(
        'https://s3.example.com/f.csv?X-Amz-Signature=abc&X-Amz-Security-Token=def&X-Amz-Date=1',
      ),
    ).toBe(
      'https://s3.example.com/f.csv?X-Amz-Signature=REDACTED&X-Amz-Security-Token=REDACTED&X-Amz-Date=1',
    );
    expect(redactUrl('https://a.com/?accessToken=1&client_secret=2&%74oken=3&PWD=4')).toBe(
      'https://a.com/?accessToken=REDACTED&client_secret=REDACTED&%74oken=REDACTED&PWD=REDACTED',
    );
  });

  it('片段里的凭据也抹：#/ 路由的查询串、隐式授权的 #access_token', () => {
    expect(redactUrl('https://a.com/app#/callback?code=1&tab=2')).toBe(
      'https://a.com/app#/callback?code=REDACTED&tab=2',
    );
    expect(redactUrl('https://a.com/cb#access_token=abc&token_type=bearer&expires_in=3600')).toBe(
      'https://a.com/cb#access_token=REDACTED&token_type=bearer&expires_in=3600',
    );
  });

  it('没有凭据的地址原样返回：锚点、路由、空值都不动', () => {
    for (const url of [
      'https://example.com/',
      'https://example.com/report?month=2026-09#summary',
      'https://example.com/app#/list?page=2',
      'https://example.com/?code=',
      'https://example.com/?zipcode=100000&barcode=1',
    ])
      expect(redactUrl(url)).toBe(url);
  });
});

describe('hasRedactedSecret', () => {
  it('只认凭据参数上的 REDACTED，别的参数碰巧叫这个值不算', () => {
    expect(hasRedactedSecret(redactUrl('https://a.com/?token=abc'))).toBe(true);
    expect(hasRedactedSecret(redactUrl('https://a.com/#/cb?code=abc'))).toBe(true);
    expect(hasRedactedSecret(redactUrl('https://a.com/#id_token=abc'))).toBe(true);
    expect(hasRedactedSecret(`https://a.com/?status=${REDACTED}`)).toBe(false);
    expect(hasRedactedSecret('https://a.com/?token=abc')).toBe(false);
    expect(hasRedactedSecret('https://a.com/')).toBe(false);
  });
});

const SECRET_URL = 'https://report.example.com/login?next=%2Fdash&code=4f2a9c&state=xyz';
const el = { tagName: 'button', role: 'button', name: '登录' };

describe('RecordingCapture 抹掉地址里的凭据', () => {
  it('页面、导航、元素事件、滚动与备注的地址进日志前都抹过', () => {
    const capture = new RecordingCapture();
    capture.page({ url: SECRET_URL, title: '登录', text: '' }, 'back');
    capture.navigate(SECRET_URL);
    capture.raw({ kind: 'click', url: SECRET_URL, index: 0, el, at: 1, detail: 1 });
    capture.raw({ kind: 'scroll', url: SECRET_URL, at: 2, x: 0, y: 10 });
    capture.note('这里登录', SECRET_URL);
    const events = capture.finish();
    expect(events).toHaveLength(6);
    const text = JSON.stringify(events);
    expect(text).not.toContain('4f2a9c');
    for (const event of events) {
      LoggedEventSchema.parse(event);
      const url = 'url' in event ? event.url : event.onUrl;
      expect(url).toBe('https://report.example.com/login?next=%2Fdash&code=REDACTED&state=xyz');
    }
  });

  it('抹过的地址不影响回放的页面比对：点击步骤照样认得出带着真凭据的那一页', () => {
    const capture = new RecordingCapture();
    capture.page({ url: SECRET_URL, title: '登录', text: '' });
    capture.raw({ kind: 'click', url: SECRET_URL, index: 0, el, at: 1, detail: 1 });
    const step = project(capture.finish()).entries.find((entry) => entry.kind === 'step');
    if (step?.kind !== 'step' || step.step.kind !== 'click') throw new Error('没有点击步骤');
    expect(step.step.onUrl).toContain('code=REDACTED');
    expect(samePage(SECRET_URL, step.step.onUrl)).toBe(true);
  });

  it('#/ 路由的片段留着、只抹它的查询串；隐式授权的片段整段按参数抹；普通锚点不动', () => {
    const capture = new RecordingCapture();
    capture.navigate('https://app.example.com/#/oauth/callback?code=4f2a9c&tab=orders');
    capture.navigate('https://app.example.com/#!/reset?token=4f2a9c');
    capture.navigate(
      'https://app.example.com/cb#access_token=4f2a9c&token_type=bearer&expires_in=3600',
    );
    capture.navigate('https://app.example.com/docs#install');
    expect(capture.finish().map((event) => ('url' in event ? event.url : ''))).toEqual([
      'https://app.example.com/#/oauth/callback?code=REDACTED&tab=orders',
      'https://app.example.com/#!/reset?token=REDACTED',
      'https://app.example.com/cb#access_token=REDACTED&token_type=bearer&expires_in=3600',
      'https://app.example.com/docs#install',
    ]);
  });
});

describe('playSteps 遇到抹过凭据的导航', () => {
  it('从录制到回放：录下的带凭据导航投影成 navigate，回放到这一步交给人，后面的不执行', async () => {
    const capture = new RecordingCapture();
    capture.navigate('https://app.example.com/#/oauth/callback?code=4f2a9c');
    capture.page({ url: 'https://app.example.com/#/orders', title: '订单', text: '' });
    capture.raw({
      kind: 'click',
      url: 'https://app.example.com/#/orders',
      index: 0,
      el,
      at: 1,
      detail: 1,
    });
    const steps = project(capture.finish()).entries.flatMap((entry) =>
      entry.kind === 'step' ? [entry.step] : [],
    );
    expect(steps.map((step) => step.kind)).toEqual(['navigate', 'click']);
    const execute = vi.fn(async (name: string) =>
      name === 'browser.snapshot' ? { url: 'about:blank', title: '', loading: false } : {},
    );
    expect(await playSteps(steps, { execute })).toMatchObject({
      reason: 'HUMAN',
      at: 1,
      humanReason: URL_REDACTED_REASON,
    });
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['browser.snapshot']);
  });

  // 磁盘上已有的录制没有经过这一道：地址里带着真凭据、带着什么片段，都要和以前一样原样导航。
  it('已经存下的老录制：带真凭据与片段的导航原样执行', async () => {
    const old = 'https://report.example.com/login?code=4f2a9c&state=xyz#/next?token=abc';
    const execute = vi.fn(async (name: string) =>
      name === 'browser.snapshot' ? { url: old, title: '', loading: false } : {},
    );
    const outcome = await playSteps([{ kind: 'navigate', url: old }], {
      execute,
      sleep: async () => undefined,
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith('browser.navigate', { url: old });
  });

  it('交给人，不带着 REDACTED 去导航', async () => {
    const execute = vi.fn(async (name: string) =>
      name === 'browser.snapshot' ? { url: 'about:blank', title: '', loading: false } : {},
    );
    const steps: Step[] = [{ kind: 'navigate', url: redactUrl(SECRET_URL) }];
    const outcome = await playSteps(steps, { execute });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'HUMAN',
      at: 1,
      humanReason: URL_REDACTED_REASON,
    });
    expect(execute.mock.calls.map(([name]) => name)).not.toContain('browser.navigate');
  });

  it('没有凭据的导航照常执行', async () => {
    const execute = vi.fn(async (name: string) =>
      name === 'browser.snapshot'
        ? { url: 'https://report.example.com/dash', title: '', loading: false }
        : {},
    );
    const outcome = await playSteps(
      [{ kind: 'navigate', url: 'https://report.example.com/dash' }],
      {
        execute,
        sleep: async () => undefined,
      },
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://report.example.com/dash',
    });
  });
});
