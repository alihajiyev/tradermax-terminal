import { deflateSync } from 'zlib';

/**
 * Runtime-generated tray icon (16×16 teal diamond on transparent bg).
 * Avoids shipping binary icon assets — dependency-free PNG encoder.
 */

function crc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

const CRC_TABLE = crc32Table();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function makeTrayIconPNG(): Buffer {
  const W = 16;
  const H = 16;
  // Teal diamond (TraderMax accent #00d4aa) with soft edge
  const px = (x: number, y: number): [number, number, number, number] => {
    const cx = (x - 7.5) / 7.5;
    const cy = (y - 7.5) / 7.5;
    const d = Math.abs(cx) + Math.abs(cy); // manhattan diamond
    if (d <= 0.55) return [0, 212, 170, 255];
    if (d <= 0.8) return [0, 180, 145, 255];
    if (d <= 1.0) return [0, 120, 100, 160];
    return [0, 0, 0, 0];
  };

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (1 + W * 4) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression, filter, interlace
  const idat = deflateSync(raw);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
