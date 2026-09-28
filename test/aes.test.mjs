// AES-128-CBC 实现校验：拿 Node 的 crypto 当标准答案。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { aes128CbcDecrypt, decryptAes128, sequenceToIv, parseHexIv } from '../extension/src/lib/aes.js';

function nodeEncrypt(plain, key, iv, pad) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(plain), c.final()]);
}

test('AES-128-CBC 纯 JS 实现与 Node crypto 一致（PKCS#7 填充）', () => {
  for (let i = 0; i < 40; i++) {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const len = 16 + Math.floor(Math.random() * 400);
    const plain = crypto.randomBytes(len);
    const ct = nodeEncrypt(plain, key, iv, true);
    const got = Buffer.from(aes128CbcDecrypt(new Uint8Array(ct), new Uint8Array(key), new Uint8Array(iv)));
    assert.equal(got.toString('hex'), plain.toString('hex'), `第 ${i} 组不一致`);
  }
});

test('AES-128-CBC 能处理没有补位的分片', () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const plain = crypto.randomBytes(512);
  const ct = nodeEncrypt(plain, key, iv, false);
  const got = Buffer.from(aes128CbcDecrypt(new Uint8Array(ct), new Uint8Array(key), new Uint8Array(iv)));
  assert.equal(got.length, plain.length);
  assert.equal(got.toString('hex'), plain.toString('hex'));
});

test('decryptAes128 主路径（WebCrypto）结果正确', async () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const plain = crypto.randomBytes(1024);
  const ct = nodeEncrypt(plain, key, iv, true);
  const got = Buffer.from(await decryptAes128(new Uint8Array(ct), new Uint8Array(key), new Uint8Array(iv), crypto.webcrypto));
  assert.equal(got.toString('hex'), plain.toString('hex'));
});

test('decryptAes128 在 WebCrypto 失败时回落到纯 JS', async () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const plain = crypto.randomBytes(1024);
  const ct = nodeEncrypt(plain, key, iv, false); // 没有补位，WebCrypto 必然抛错
  const got = Buffer.from(await decryptAes128(new Uint8Array(ct), new Uint8Array(key), new Uint8Array(iv), crypto.webcrypto));
  assert.equal(got.toString('hex'), plain.toString('hex'));
});

test('序号转 IV 是大端 16 字节', () => {
  const iv = sequenceToIv(258);
  const hex = Buffer.from(iv).toString('hex');
  assert.equal(hex, '00000000000000000000000000000102');
});

test('解析 0x 前缀 IV，长度不足时左侧补零', () => {
  assert.equal(Buffer.from(parseHexIv('0x0102')).toString('hex'), '00000000000000000000000000000102');
  assert.equal(
    Buffer.from(parseHexIv('0x0123456789abcdef0123456789abcdef')).toString('hex'),
    '0123456789abcdef0123456789abcdef'
  );
  assert.equal(parseHexIv(''), null);
});

test('密文长度非法时报错', () => {
  assert.throws(() => aes128CbcDecrypt(new Uint8Array(17), new Uint8Array(16), new Uint8Array(16)), /16 的整数倍/);
});
