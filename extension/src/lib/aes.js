// AES-128-CBC 解密。
// 主路径用 WebCrypto（快、走硬件），但 WebCrypto 的 AES-CBC 一定会做 PKCS#7 去填充，
// 遇到个别 CDN 没按规范补位的分片会直接抛 OperationError。
// 这里带一个纯 JS 的“不去填充”实现作为兜底，两者都用测试对过 Node 的 crypto。

let TABLES = null;

function xtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function gmul(a, b) {
  let p = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>= 1;
  }
  return p & 0xff;
}

function ginv(a) {
  if (a === 0) return 0;
  let r = 1;
  let base = a;
  let e = 254;
  while (e) {
    if (e & 1) r = gmul(r, base);
    base = gmul(base, base);
    e >>= 1;
  }
  return r;
}

function buildTables() {
  const SBOX = new Uint8Array(256);
  const ISBOX = new Uint8Array(256);
  const rot = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
  for (let i = 0; i < 256; i++) {
    const inv = ginv(i);
    SBOX[i] = (inv ^ rot(inv, 1) ^ rot(inv, 2) ^ rot(inv, 3) ^ rot(inv, 4) ^ 0x63) & 0xff;
  }
  for (let i = 0; i < 256; i++) ISBOX[SBOX[i]] = i;
  // 逆 MixColumns 用到的 14/11/13/9 乘法表
  const M9 = new Uint8Array(256);
  const M11 = new Uint8Array(256);
  const M13 = new Uint8Array(256);
  const M14 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    M9[i] = gmul(i, 9);
    M11[i] = gmul(i, 11);
    M13[i] = gmul(i, 13);
    M14[i] = gmul(i, 14);
  }
  return { SBOX, ISBOX, M9, M11, M13, M14 };
}

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function expandKey(key, t) {
  const w = new Uint8Array(176);
  w.set(key);
  const tmp = new Uint8Array(4);
  let generated = 16;
  let rconIdx = 0;
  while (generated < 176) {
    for (let i = 0; i < 4; i++) tmp[i] = w[generated - 4 + i];
    if (generated % 16 === 0) {
      const b0 = tmp[0];
      tmp[0] = tmp[1];
      tmp[1] = tmp[2];
      tmp[2] = tmp[3];
      tmp[3] = b0;
      for (let i = 0; i < 4; i++) tmp[i] = t.SBOX[tmp[i]];
      tmp[0] ^= RCON[rconIdx++];
    }
    for (let i = 0; i < 4; i++) {
      w[generated] = w[generated - 16] ^ tmp[i];
      generated++;
    }
  }
  return w;
}

function invSubBytes(s, t) {
  for (let i = 0; i < 16; i++) s[i] = t.ISBOX[s[i]];
}

// 状态按列优先排列：下标 = 列 * 4 + 行。行 r 的 4 个字节在 r, r+4, r+8, r+12。
function invShiftRows(s) {
  let tmp;
  // 行 1 右移 1
  tmp = s[13];
  s[13] = s[9];
  s[9] = s[5];
  s[5] = s[1];
  s[1] = tmp;
  // 行 2 右移 2
  tmp = s[2];
  s[2] = s[10];
  s[10] = tmp;
  tmp = s[6];
  s[6] = s[14];
  s[14] = tmp;
  // 行 3 右移 3（等价于左移 1）
  tmp = s[3];
  s[3] = s[7];
  s[7] = s[11];
  s[11] = s[15];
  s[15] = tmp;
}

function invMixColumns(s, t) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i];
    const a1 = s[i + 1];
    const a2 = s[i + 2];
    const a3 = s[i + 3];
    s[i] = t.M14[a0] ^ t.M11[a1] ^ t.M13[a2] ^ t.M9[a3];
    s[i + 1] = t.M9[a0] ^ t.M14[a1] ^ t.M11[a2] ^ t.M13[a3];
    s[i + 2] = t.M13[a0] ^ t.M9[a1] ^ t.M14[a2] ^ t.M11[a3];
    s[i + 3] = t.M11[a0] ^ t.M13[a1] ^ t.M9[a2] ^ t.M14[a3];
  }
}

function addRoundKey(s, w, round) {
  const off = round * 16;
  for (let i = 0; i < 16; i++) s[i] ^= w[off + i];
}

/**
 * 纯 JS 的 AES-128-CBC 解密，去掉 PKCS#7 填充（如果存在）。
 * @param {Uint8Array} ct 密文
 * @param {Uint8Array} key 16 字节密钥
 * @param {Uint8Array} iv 16 字节 IV
 * @returns {Uint8Array} 明文
 */
export function aes128CbcDecrypt(ct, key, iv) {
  if (key.length !== 16) throw new Error('AES-128 需要 16 字节密钥，实际 ' + key.length);
  if (iv.length !== 16) throw new Error('AES-CBC 需要 16 字节 IV，实际 ' + iv.length);
  if (ct.length === 0) return new Uint8Array(0);
  if (ct.length % 16 !== 0) throw new Error('密文长度不是 16 的整数倍：' + ct.length);
  if (!TABLES) TABLES = buildTables();
  const t = TABLES;
  const w = expandKey(key, t);

  const out = new Uint8Array(ct.length);
  const prev = new Uint8Array(16);
  prev.set(iv);
  const state = new Uint8Array(16);
  for (let off = 0; off < ct.length; off += 16) {
    const cipherBlock = ct.subarray(off, off + 16);
    state.set(cipherBlock);
    addRoundKey(state, w, 10);
    for (let round = 9; round >= 1; round--) {
      invShiftRows(state);
      invSubBytes(state, t);
      addRoundKey(state, w, round);
      invMixColumns(state, t);
    }
    invShiftRows(state);
    invSubBytes(state, t);
    addRoundKey(state, w, 0);
    for (let i = 0; i < 16; i++) out[off + i] = state[i] ^ prev[i];
    prev.set(cipherBlock);
  }

  // 去掉 PKCS#7 填充：末字节是 1..16 且整段重复，才认定有填充
  const pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16 && pad <= out.length) {
    let ok = true;
    for (let i = out.length - pad; i < out.length; i++) {
      if (out[i] !== pad) {
        ok = false;
        break;
      }
    }
    if (ok) return out.subarray(0, out.length - pad);
  }
  return out;
}

/** 用 WebCrypto 解密；失败时回落到纯 JS 实现。 */
export async function decryptAes128(ct, key, iv, cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && cryptoImpl.subtle && cryptoImpl.subtle.importKey) {
    try {
      const k = await cryptoImpl.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
      const plain = await cryptoImpl.subtle.decrypt({ name: 'AES-CBC', iv }, k, ct);
      return new Uint8Array(plain);
    } catch (e) {
      // 走到这里通常是分片没做 PKCS#7 补位，交给纯 JS 版本
      try {
        return aes128CbcDecrypt(ct, key, iv);
      } catch {
        throw e;
      }
    }
  }
  return aes128CbcDecrypt(ct, key, iv);
}

/** 把序号转成 HLS 默认 IV（16 字节大端）。 */
export function sequenceToIv(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

/** 解析 #EXT-X-KEY 里的 IV=0x... */
export function parseHexIv(s) {
  if (!s) return null;
  let h = String(s).trim();
  if (/^0x/i.test(h)) h = h.slice(2);
  if (h.length === 0) return null;
  if (h.length % 2) h = '0' + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  if (out.length === 16) return out;
  if (out.length > 16) return out.subarray(out.length - 16);
  const padded = new Uint8Array(16);
  padded.set(out, 16 - out.length);
  return padded;
}
