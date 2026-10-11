import { expect, it, vi } from 'vitest';
import { ExternalUrlQueue } from '../src/main/external-urls';

function queue() {
  const opened: string[] = [];
  const errors: unknown[] = [];
  const urls = new ExternalUrlQueue(
    async (url) => {
      opened.push(url);
    },
    (error) => errors.push(error),
  );
  return { urls, opened, errors };
}

it('queues before ready and flushes once in arrival order', async () => {
  const { urls, opened } = queue();
  await urls.receive('https://example.com/first');
  await urls.receive('http://example.com/second');
  expect(opened).toEqual([]);
  await urls.flush();
  expect(opened).toEqual(['https://example.com/first', 'http://example.com/second']);
  await urls.flush();
  expect(opened).toHaveLength(2);
});

it('opens directly after ready, including addresses left for the URL policy to block', async () => {
  const { urls, opened } = queue();
  await urls.flush();
  await urls.receive('http://127.0.0.1/');
  expect(opened).toEqual(['http://127.0.0.1/']);
});

it('ignores non-http(s) URLs before and after ready', async () => {
  const { urls, opened } = queue();
  const ignored = [
    'file:///tmp/page.html',
    'about:blank',
    'javascript:alert(1)',
    'pilion://task',
    'mailto:a@example.com',
    'example.com',
  ];
  for (const url of ignored) await urls.receive(url);
  await urls.flush();
  for (const url of ignored) await urls.receive(url);
  await urls.receive('HTTPS://example.com/');
  expect(opened).toEqual(['HTTPS://example.com/']);
});

it('serializes links arriving while the startup queue is flushing', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opened: string[] = [];
  const urls = new ExternalUrlQueue(async (url) => {
    opened.push(url);
    if (opened.length === 1) await pending;
  }, vi.fn());
  await urls.receive('https://example.com/first');
  await urls.receive('https://example.com/second');
  const flush = urls.flush();
  await Promise.resolve();
  const later = urls.receive('https://example.com/third');
  expect(opened).toEqual(['https://example.com/first']);
  release();
  await Promise.all([flush, later]);
  expect(opened).toEqual([
    'https://example.com/first',
    'https://example.com/second',
    'https://example.com/third',
  ]);
});

it('reports a failed open and continues delivering subsequent links', async () => {
  const error = new Error('页面适配器未创建');
  const opened: string[] = [];
  const errors: unknown[] = [];
  const urls = new ExternalUrlQueue(
    async (url) => {
      if (url.endsWith('/first')) throw error;
      opened.push(url);
    },
    (cause) => errors.push(cause),
  );
  await urls.receive('https://example.com/first');
  await urls.receive('https://example.com/second');
  await urls.flush();
  expect(errors).toEqual([error]);
  expect(opened).toEqual(['https://example.com/second']);
});
