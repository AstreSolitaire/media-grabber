// 打包扩展：生成 zip 与签名的 crx3。
// 为什么必须出 crx：安卓版 Edge 没有「加载已解压的扩展程序」，
// 只能通过「开发者选项 → 通过 crx 安装扩展」来侧载。
// 签名用自签 RSA 密钥，密钥存在 build/ 下，以后要更新得用同一把密钥才能保持扩展 ID 不变。

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');
const BUILD = path.join(ROOT, 'build');
const KEY_FILE = path.join(BUILD, 'media-grabber.pem');

// ---------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

function makeZip(entries) {
  const now = new Date();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要的版本
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime(now), 10);
    local.writeUInt16LE(dosDate(now), 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime(now), 12);
    cen.writeUInt16LE(dosDate(now), 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- protobuf

function varint(n) {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

function bytesField(fieldNumber, data) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(data.length), data]);
}

// ---------------------------------------------------------------- 扩展 ID

function extensionIdFromKey(publicKeyDer) {
  const digest = createHash('sha256').update(publicKeyDer).digest();
  const id = digest.subarray(0, 16);
  let out = '';
  for (const byte of id) {
    out += String.fromCharCode(97 + (byte >> 4));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return { id: out, raw: id };
}

// ---------------------------------------------------------------- 主流程

await mkdir(BUILD, { recursive: true });

const files = await walk(EXT);
files.sort();
const entries = [];
for (const f of files) {
  entries.push({ name: f, data: await readFile(path.join(EXT, f)) });
}
const zip = makeZip(entries);
const zipPath = path.join(BUILD, 'media-grabber.zip');
await writeFile(zipPath, zip);
console.log(`zip 已生成：${zipPath}（${(zip.length / 1024).toFixed(1)} KB，${entries.length} 个文件）`);

// 密钥：没有就生成一把
let privateKeyPem;
try {
  await access(KEY_FILE);
  privateKeyPem = await readFile(KEY_FILE, 'utf8');
  console.log('复用已有签名密钥：' + KEY_FILE);
} catch {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKeyPem = pair.privateKey;
  await writeFile(KEY_FILE, privateKeyPem);
  await writeFile(path.join(BUILD, 'media-grabber.pub.der'), pair.publicKey);
  console.log('已生成新的签名密钥：' + KEY_FILE);
}

const publicKeyDer = await readFile(path.join(BUILD, 'media-grabber.pub.der')).catch(() => null);
let pubDer = publicKeyDer;
if (!pubDer) {
  // 只有私钥文件时，从私钥导出公钥
  const { createPublicKey } = await import('node:crypto');
  pubDer = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  await writeFile(path.join(BUILD, 'media-grabber.pub.der'), pubDer);
}

const { id: extensionId, raw: crxId } = extensionIdFromKey(pubDer);

// CRX3 签名：签名覆盖 "CRX3 SignedData\0" + 小端 header 长度 + signed_header_data + zip
const signedHeaderData = bytesField(1, crxId); // SignedData { crx_id = 1 }
const prefix = Buffer.concat([
  Buffer.from('CRX3 SignedData\x00', 'latin1'),
  (() => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(signedHeaderData.length, 0);
    return b;
  })(),
  signedHeaderData,
  zip,
]);
const signature = sign('sha256', prefix, { key: privateKeyPem, padding: 1 /* RSA_PKCS1_PADDING */ });

const keyProof = Buffer.concat([bytesField(1, pubDer), bytesField(2, signature)]);
const header = Buffer.concat([bytesField(2, keyProof), bytesField(10000, signedHeaderData)]);

const crx = Buffer.concat([
  Buffer.from('Cr24', 'latin1'),
  (() => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(3, 0);
    return b;
  })(),
  (() => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(header.length, 0);
    return b;
  })(),
  header,
  zip,
]);
const crxPath = path.join(BUILD, 'media-grabber.crx');
await writeFile(crxPath, crx);
console.log(`crx 已生成：${crxPath}（${(crx.length / 1024).toFixed(1)} KB）`);

const info = [
  `扩展 ID：${extensionId}`,
  '',
  '这个 ID 由签名密钥决定（密钥文件：build/media-grabber.pem）。',
  '以后更新扩展时请继续使用同一把密钥，否则扩展 ID 会变，安卓上需要重新安装。',
  '',
  `zip：media-grabber.zip（用于桌面版「加载已解压」之外的场景，以及 Kiwi 等支持从 zip 安装的浏览器）`,
  `crx：media-grabber.crx（安卓 Edge Canary 用「通过 crx 安装扩展」侧载）`,
  '',
  '手动加载：桌面 Edge 打开 edge://extensions → 打开「开发人员模式」→「加载解压缩的扩展」→ 选择 extension/ 目录。',
  '',
].join('\n');
await writeFile(path.join(BUILD, 'extension-id.txt'), info, 'utf8');
console.log('\n' + info);

// 自检：结构 + 签名都验一遍，避免 Chrome 装的时候报一句看不懂的错
const magic = crx.subarray(0, 4).toString('latin1');
const version = crx.readUInt32LE(4);
const headerLen = crx.readUInt32LE(8);
const okStructure = magic === 'Cr24' && version === 3 && headerLen === header.length && crx.length - 12 - headerLen === zip.length;
console.log('crx 结构自检：' + (okStructure ? '通过' : '异常'));

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos.i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return result;
}

function parseFields(buf, start, end) {
  const pos = { i: start };
  const fields = [];
  while (pos.i < end) {
    const tag = Number(readVarint(buf, pos));
    const fieldNumber = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      const len = Number(readVarint(buf, pos));
      fields.push({ fieldNumber, data: buf.subarray(pos.i, pos.i + len) });
      pos.i += len;
    } else if (wireType === 0) {
      readVarint(buf, pos);
    } else {
      break;
    }
  }
  return fields;
}

const headerFields = parseFields(crx, 12, 12 + headerLen);
const signedHeader = headerFields.find((f) => f.fieldNumber === 10000);
const keyProofField = headerFields.find((f) => f.fieldNumber === 2);
let okSignature = false;
if (signedHeader && keyProofField) {
  const proof = parseFields(keyProofField.data, 0, keyProofField.data.length);
  const pubKey = proof.find((f) => f.fieldNumber === 1).data;
  const sig = proof.find((f) => f.fieldNumber === 2).data;
  const signedFields = parseFields(signedHeader.data, 0, signedHeader.data.length);
  const crxIdInHeader = signedFields.find((f) => f.fieldNumber === 1).data;

  const expectedPrefix = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'latin1'),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(signedHeader.data.length, 0);
      return b;
    })(),
    signedHeader.data,
    zip,
  ]);
  const { createPublicKey, verify } = await import('node:crypto');
  okSignature = verify('sha256', expectedPrefix, { key: createPublicKey({ key: pubKey, format: 'der', type: 'spki' }), padding: 1 }, sig);
  const idMatches = Buffer.compare(crxIdInHeader, crxId) === 0;
  console.log('crx 签名验签：' + (okSignature ? '通过' : '失败') + '，header 里的 crx_id 与公钥一致：' + (idMatches ? '是' : '否'));
  if (!idMatches) okSignature = false;
} else {
  console.log('crx 签名验签：无法解析 header');
}
if (!okStructure || !okSignature) process.exit(1);
