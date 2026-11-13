import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/main/browser/image-size.js';

function png(width: number, height: number): string {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  // 后面跟上一段假的像素数据：只读头部，整张图有多大都不影响。
  return Buffer.concat([header, Buffer.alloc(4096, 7)]).toString('base64');
}

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function jpeg(width: number, height: number, sof = 0xc0): string {
  const frame = Buffer.alloc(15);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    // DHT 也落在 C0..CF 区间里，不能被当成帧头。
    segment(0xc4, Buffer.alloc(20, 1)),
    Buffer.from([0xff]),
    segment(sof, frame),
    segment(0xda, Buffer.alloc(10)),
    Buffer.from([0xff, 0xd9]),
  ]).toString('base64');
}

describe('imageSize', () => {
  it('reads PNG width and height from IHDR', () => {
    expect(imageSize(png(1600, 1200), 'image/png')).toEqual({ width: 1600, height: 1200 });
    expect(imageSize(png(1, 70_000), 'image/png')).toEqual({ width: 1, height: 70_000 });
  });

  it('reads JPEG width and height from the frame header, skipping DHT and fill bytes', () => {
    expect(imageSize(jpeg(800, 600), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    expect(imageSize(jpeg(640, 480, 0xc2), 'image/jpeg')).toEqual({ width: 640, height: 480 });
  });

  it('returns undefined for anything it cannot read', () => {
    expect(imageSize(Buffer.from('png').toString('base64'), 'image/png')).toBeUndefined();
    expect(imageSize('', 'image/png')).toBeUndefined();
    expect(imageSize(png(0, 10), 'image/png')).toBeUndefined();
    expect(imageSize(jpeg(800, 600), 'image/png')).toBeUndefined();
    expect(imageSize(png(800, 600), 'image/jpeg')).toBeUndefined();
    expect(imageSize(Buffer.from('jpeg-bytes').toString('base64'), 'image/jpeg')).toBeUndefined();
    // 帧头之前就到了扫描段：没有尺寸可读。
    const noFrame = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xda, Buffer.alloc(4)),
    ]).toString('base64');
    expect(imageSize(noFrame, 'image/jpeg')).toBeUndefined();
    // 截断在帧头中间。
    const truncated = Buffer.from(jpeg(800, 600), 'base64');
    const cut = truncated.indexOf(Buffer.from([0xff, 0xc0])) + 6;
    expect(imageSize(truncated.subarray(0, cut).toString('base64'), 'image/jpeg')).toBeUndefined();
  });
});
