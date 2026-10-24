/**
 * dsh-geogebra · 极简 PNG 编解码（只用 node:zlib，不引第三方依赖）
 *
 * 存在的唯一理由：`transparent: true` 时，无头截图拿到的 GeoGebra 画布是不透明白底
 * （GeoGebra 自己填的白，CDP 的背景覆盖管不到 canvas 像素），
 * 需要在宿主端把"白底"还原成 alpha：
 *   - 全白像素 → 完全透明
 *   - 抗锯齿的灰边 → 半透明 + 反预乘，避免出现白边/灰边
 *
 * 只支持 8bit、非隔行的 RGB / RGBA（Chromium 截图正好落在这两种里）；
 * 其它情况 decodePng 返回 null，调用方保持原图并在结果里说明。
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * @returns {{width:number,height:number,channels:number,data:Buffer}|null}
 *   data 是解过滤后的原始像素（未做行填充）
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;

  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!ihdr || !idat.length) return null;

  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : 0;
  if (!channels || ihdr.depth !== 8 || ihdr.interlace !== 0) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const { width, height } = ihdr;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = raw[lineStart + x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: return null;
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/** 编码成 RGBA8 PNG（filter 0，简单可靠）。 */
export function encodePng({ width, height, data, channels }) {
  const rgba = channels === 4 ? data : (() => {
    const out = Buffer.alloc(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j];
      out[i * 4 + 1] = data[j + 1];
      out[i * 4 + 2] = data[j + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  })();

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把白底图转成透明底：alpha = 255 - min(r,g,b)，再反预乘去掉白边。
 * @returns {Buffer|null} 新的 PNG；解码失败返回 null
 */
export function whiteToTransparent(pngBuffer) {
  const decoded = decodePng(pngBuffer);
  if (!decoded) return null;
  const { width, height, channels, data } = decoded;
  const out = Buffer.alloc(width * height * 4);

  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const alpha = 255 - Math.min(r, g, b);
    const o = i * 4;
    if (alpha <= 0) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      continue;
    }
    // 反预乘：像素是在白底上混出来的，c_orig = (c - (255 - alpha)) * 255 / alpha
    const fix = (value) => {
      const v = Math.round(((value - (255 - alpha)) * 255) / alpha);
      return v < 0 ? 0 : v > 255 ? 255 : v;
    };
    out[o] = fix(r);
    out[o + 1] = fix(g);
    out[o + 2] = fix(b);
    out[o + 3] = alpha;
  }

  return encodePng({ width, height, data: out, channels: 4 });
}

export default { decodePng, encodePng, whiteToTransparent };
