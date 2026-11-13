/**
 * 读截图的像素宽高（issue #7）：Agent 要把图里的位置换算回 CSS 像素，得知道图有多大。
 * 只认 PNG 的 IHDR 与 JPEG 的 SOF 段；认不出就返回 undefined，调用方不报几何。
 */
export function imageSize(
  base64: string,
  mimeType: 'image/png' | 'image/jpeg',
): { width: number; height: number } | undefined {
  // PNG 的尺寸就在开头 24 字节里，只解码一小段；JPEG 的 SOF 位置不定，整张解码（不超过约 700 KiB）。
  const bytes = Buffer.from(mimeType === 'image/png' ? base64.slice(0, 64) : base64, 'base64');
  const size = mimeType === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  // 签名 8 字节，接着第一个块必须是 IHDR：长度 4、类型 4，然后宽、高各 4 字节大端。
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // 填充字节与不带长度的标记直接跳过。
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    // SOF0..SOF15，除去 DHT(C4)、JPG(C8)、DAC(CC)：段里是精度 1 字节、高 2、宽 2。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}
