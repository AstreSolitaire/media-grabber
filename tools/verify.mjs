// 静态自检：语法、manifest 引用、消息类型是否对得上、有没有漏文件。
// 跑这个比装进浏览器再发现打不开要快得多。

import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');

let problems = 0;
let warnings = 0;

function fail(msg) {
  problems++;
  console.log('  [错误] ' + msg);
}
function warn(msg) {
  warnings++;
  console.log('  [注意] ' + msg);
}
function ok(msg) {
  console.log('  [通过] ' + msg);
}

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

const files = await walk(EXT);
console.log('扩展文件清单（' + files.length + ' 个）：');
for (const f of files) {
  const s = await stat(path.join(EXT, f));
  console.log(`  ${String(s.size).padStart(8)}  ${f}`);
}

// ---------------------------------------------------------------- manifest

console.log('\n1) manifest 引用检查');
let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8'));
  ok('manifest.json 是合法 JSON');
} catch (e) {
  fail('manifest.json 解析失败：' + e.message);
  process.exit(1);
}

const referenced = new Set();
function refAny(value) {
  if (typeof value === 'string') {
    if (/\.(js|html|css|png|json)$/i.test(value) && !value.includes('*')) referenced.add(value);
  } else if (Array.isArray(value)) {
    value.forEach(refAny);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(refAny);
  }
}
refAny(manifest);

// 代码里用 runtime.getURL / <script src> 引到的文件也算被引用
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.html'));
for (const f of jsFiles) {
  const code = await readFile(path.join(EXT, f), 'utf8');
  for (const m of code.matchAll(/['"`](src\/[A-Za-z0-9._/-]+\.(?:js|html|css))['"`]/g)) referenced.add(m[1]);
  for (const m of code.matchAll(/['"`](icons\/[A-Za-z0-9._-]+\.png)['"`]/g)) referenced.add(m[1]);
}

for (const r of referenced) {
  const clean = r.replace(/^\//, '');
  if (!files.includes(clean)) fail(`manifest 或代码引用了不存在的文件：${r}`);
}
if (referenced.size) ok(`被引用的 ${referenced.size} 个文件都存在`);

const unused = files.filter((f) => !referenced.has(f) && !f.endsWith('.js') && f !== 'manifest.json');
if (unused.length) warn('这些资源没有被引用：' + unused.join(', '));

// 检查权限是不是都在用
const perms = manifest.permissions || [];
const allSrc = (await Promise.all(files.filter((f) => f.endsWith('.js')).map((f) => readFile(path.join(EXT, f), 'utf8')))).join('\n');
const permUsage = {
  storage: 'chrome.storage',
  downloads: 'chrome.downloads',
  webRequest: 'chrome.webRequest',
  scripting: 'chrome.scripting',
  declarativeNetRequestWithHostAccess: 'declarativeNetRequest',
};
for (const p of perms) {
  const needle = permUsage[p];
  if (needle && !allSrc.includes(needle)) fail(`申请了权限 ${p} 但代码里没用到`);
}
ok('权限都与代码用法对得上');

// ---------------------------------------------------------------- 语法

console.log('\n2) JavaScript 语法检查');
for (const f of files.filter((x) => x.endsWith('.js'))) {
  try {
    await exec('node', ['--check', path.join(EXT, f)], { cwd: ROOT });
    ok(f);
  } catch (e) {
    fail(`${f} 语法错误：\n${e.stderr || e.message}`);
  }
}

// ---------------------------------------------------------------- 消息类型

console.log('\n3) 消息类型一致性');
const sources = {};
for (const f of files.filter((x) => x.endsWith('.js'))) {
  sources[f] = await readFile(path.join(EXT, f), 'utf8');
}

// 后台的接收方：HANDLERS 对象里的键（允许 async 前缀）
const bgCode = sources['src/background.js'];
const handlersBlock = /const HANDLERS = \{([\s\S]*?)\n\};/.exec(bgCode);
const bgHandlers = new Set();
if (handlersBlock) {
  for (const m of handlersBlock[1].matchAll(/'((?:mg:)[a-z-]+)'\s*\(/g)) bgHandlers.add(m[1]);
}
if (!bgHandlers.size) fail('没能从 background.js 里解析出 HANDLERS，检查脚本本身是否需要更新');
bgHandlers.add('mg:ping');
bgHandlers.add('mg:saver-ready');

// 页面侧的接收方
function receivedIn(code) {
  const out = new Set();
  for (const m of code.matchAll(/msg\.type === '((?:mg:)[a-z-]+)'/g)) out.add(m[1]);
  return out;
}
const pageReceivers = {
  'src/content.js': receivedIn(sources['src/content.js']),
  'src/saver.js': receivedIn(sources['src/saver.js']),
  'src/popup.js': receivedIn(sources['src/popup.js']),
};
const anyPageReceives = new Set(Object.values(pageReceivers).flatMap((s) => [...s]));

/** 找出某个文件里所有作为「发送的消息类型」出现的 token */
function sentTokens(code) {
  const out = new Map();
  code.split('\n').forEach((line, i) => {
    const m = /type:\s*'((?:mg:)[a-z-]+)'/.exec(line);
    if (m) out.set(m[1], i + 1);
  });
  return out;
}

const allTokens = new Set();
let sendProblems = 0;
for (const [f, code] of Object.entries(sources)) {
  const tokens = sentTokens(code);
  const receives = receivedIn(code);
  for (const [token, line] of tokens) {
    allTokens.add(token);
    if (token === 'mg:ping') continue;
    // 同一个文件里既发又收（转发场景）不算问题
    if (receives.has(token)) continue;
    if (f === 'src/background.js') {
      if (!anyPageReceives.has(token)) warn(`后台发出 ${token}，页面侧没人接收（${f}:${line}）`);
    } else if (!bgHandlers.has(token)) {
      fail(`发往后台的消息 ${token}（${f}:${line}）在 HANDLERS 里没有对应处理函数`);
      sendProblems++;
    }
  }
}
if (!sendProblems) ok('所有发往后台的消息都有处理函数');

// 后台处理函数是否都有人调用
const sentToBg = new Set();
for (const [f, code] of Object.entries(sources)) {
  if (f === 'src/background.js') continue;
  for (const token of sentTokens(code).keys()) sentToBg.add(token);
}
const neverCalled = [...bgHandlers].filter((t) => t !== 'mg:ping' && !sentToBg.has(t));
if (neverCalled.length) warn('后台注册了但没有地方发送的消息类型：' + neverCalled.join(', '));
else ok('后台的处理函数都有调用方');

// 汇总一张表，方便人工扫一眼
console.log('  消息类型一览：');
for (const t of [...allTokens].sort()) {
  const who = [];
  if (bgHandlers.has(t)) who.push('后台处理');
  if (anyPageReceives.has(t)) who.push('页面处理');
  console.log(`    ${t.padEnd(20)} ${who.join(' + ') || '（仅转发）'}`);
}

// ---------------------------------------------------------------- 结构约定

console.log('\n4) 结构约定');
if (!/world"\s*:\s*"MAIN"/.test(await readFile(path.join(EXT, 'manifest.json'), 'utf8'))) {
  fail('manifest 里没有 MAIN world 的嗅探脚本，fetch/XHR 钩子不会生效');
} else {
  ok('MAIN world 嗅探脚本已声明');
}
if (!(manifest.permissions || []).includes('downloads')) fail('缺少 downloads 权限，无法保存到本地');
if (!(manifest.host_permissions || []).join(',').includes('<all_urls>')) {
  warn('没有 <all_urls> 主机权限，跨域抓取分片会受 CORS 限制');
} else {
  ok('主机权限包含 <all_urls>');
}
const scripts = {};
for (const cs of manifest.content_scripts || []) {
  scripts[cs.world || 'ISOLATED'] = cs.js || [];
}
if (!scripts.MAIN || !scripts.MAIN.includes('src/inject.js')) fail('MAIN world 里没有 inject.js');
if (!scripts.ISOLATED || !scripts.ISOLATED.includes('src/ui.js')) fail('content_scripts 里缺少 ui.js（面板会挂不上）');
if (!scripts.ISOLATED || !scripts.ISOLATED.includes('src/content.js')) fail('content_scripts 里缺少 content.js');
if ((scripts.ISOLATED || []).indexOf('src/ui.js') > (scripts.ISOLATED || []).indexOf('src/content.js')) {
  fail('ui.js 必须排在 content.js 前面，否则 window.MGUI 还没定义');
}
if (!problems) ok('content_scripts 顺序与依赖正确');

console.log(`\n结果：${problems} 个错误，${warnings} 个提醒`);
process.exit(problems ? 1 : 0);
