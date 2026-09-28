// 把扩展里的算法模块拼成单文件的用户脚本。
// 这样做的好处：算法只有一份实现（extension/src/lib/），不会出现两套代码各自演化。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const LIB = path.join(ROOT, 'extension', 'src', 'lib');
const PARTS = path.join(ROOT, 'userscript', 'parts');
const OUT = path.join(ROOT, 'userscript', 'media-grabber.user.js');

const VERSION = '1.1.0';

/** 去掉 import 语句和 export 关键字，让模块代码能直接放进同一个作用域。 */
function inlineModule(code, file) {
  const out = [];
  for (const line of code.split('\n')) {
    if (/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(line)) continue; // 内部模块之间不需要 import
    if (/^\s*\/\/.*$/.test(line) === false && /^export\s+/.test(line)) {
      out.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (/^export\s+/.test(line)) continue;
    out.push(line);
  }
  const text = out.join('\n');
  const leftovers = text.match(/^\s*(import|export)\s/gm);
  if (leftovers) throw new Error(`${file} 里还残留 ${leftovers.length} 处 import/export，内联规则要更新`);
  return text;
}

// 顺序有讲究：样式常量 → 界面（立刻挂到 window.MGUI）→ 算法 → 外壳
const LIB_FILES = ['util.js', 'detect.js', 'aes.js', 'hls.js', 'ts2mp4.js'];
const UI_FILE = path.join(ROOT, 'extension', 'src', 'ui.js');
const modules = [];
for (const f of LIB_FILES) {
  const code = await readFile(path.join(LIB, f), 'utf8');
  modules.push(`// ===== 来自 extension/src/lib/${f}（原样内联，勿手改；改请改源文件后重新构建）=====\n${inlineModule(code, f)}`);
}

const css = await readFile(path.join(ROOT, 'extension', 'src', 'panel.css'), 'utf8');
if (css.includes('`') || css.includes('${')) throw new Error('panel.css 里出现了反引号或 ${，需要换一种嵌入方式');

const uiCode = await readFile(UI_FILE, 'utf8');
const app = await readFile(path.join(PARTS, 'app.js'), 'utf8');
const icon = await readFile(path.join(ROOT, 'extension', 'icons', 'icon48.png')).toString('base64');

const meta = `// ==UserScript==
// @name         媒体嗅探下载器
// @namespace    local.media-grabber
// @version      ${VERSION}
// @description  抓取网页里的 mp3 / m4a / mp4 和 m3u8(HLS) 视频，自动合并分片、必要时转成 MP4 保存到本机。手机上点右下角悬浮按钮使用。
// @author       local
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      *
// @icon         data:image/png;base64,${icon}
// @noframes     false
// ==/UserScript==
`;

const body = [
  meta,
  '/* eslint-disable */',
  '(function () {',
  "'use strict';",
  '',
  '// 面板样式：来自 extension/src/panel.css',
  'const CSS = String.raw`' + css + '`;',
  '',
  '// ===== 来自 extension/src/ui.js（界面，共用同一份实现）=====',
  uiCode,
  '',
  ...modules,
  '',
  '// ===== 用户脚本外壳 =====',
  inlineModule(app, 'app.js'),
  '',
  '})();',
  '',
].join('\n');

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, body, 'utf8');

const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
console.log(`已生成 ${OUT}（${kb} KB）`);

// 语法检查
try {
  await exec('node', ['--check', OUT], { cwd: ROOT });
  console.log('语法检查：通过');
} catch (e) {
  console.error('语法检查失败：\n' + (e.stderr || e.message));
  process.exit(1);
}

// 拼接式构建最容易踩的坑：调用了某个函数，但它定义在没被内联的文件里。
// 把「被调用但整个产物里都没有定义」的名字找出来。
const BUILTINS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'do', 'else', 'delete', 'void', 'in', 'of', 'case', 'throw', 'yield',
  'document', 'window', 'globalThis', 'console', 'navigator', 'location', 'history', 'performance', 'screen', 'localStorage', 'sessionStorage', 'crypto',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Promise', 'Map', 'Set', 'WeakMap', 'Date', 'Error', 'TypeError', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa', 'structuredClone', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'fetch', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'TextDecoder', 'TextEncoder', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'BigInt', 'SharedArrayBuffer',
  'AbortController', 'AbortSignal', 'Response', 'Request', 'Headers', 'FormData', 'Image', 'Audio', 'Event', 'CustomEvent', 'MutationObserver',
  'PerformanceObserver', 'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'XMLSerializer', 'Node', 'Element', 'HTMLElement', 'CSS',
  'unsafeWindow', 'GM_xmlhttpRequest', 'GM_download', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_addStyle', 'GM_registerMenuCommand',
  'clearImmediate', 'setImmediate', 'import', 'require',
]);

const BT = String.fromCharCode(96); // 反引号

// 只扫 JS：把内联的 CSS 常量整段切掉，否则 calc()、rgba() 这些会被当成函数调用
function stripCssConstant(text) {
  const marker = 'const CSS = String.raw' + BT;
  const start = text.indexOf(marker);
  if (start < 0) return text;
  const end = text.indexOf(BT + ';', start + marker.length);
  if (end < 0) return text;
  return text.slice(0, start) + text.slice(end + 2);
}

const jsOnly = stripCssConstant(body);

const declared = new Set();
// 不用 \b / \s 这类转义，避免被上一层字符串处理吃掉（踩过一次坑）
for (const m of jsOnly.matchAll(/function +([A-Za-z_$][A-Za-z0-9_$]*)/g)) declared.add(m[1]);
for (const m of jsOnly.matchAll(/(?:const|let|var|class) +([A-Za-z_$][A-Za-z0-9_$]*)/g)) declared.add(m[1]);

const called = new Set();
for (const m of jsOnly.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)[ ]*\(/g)) called.add(m[1]);

// 出现在对象字面量键位、赋值左侧、方法简写、或参数位置的名字，都说明本来就存在
const looksDefined = (name) =>
  new RegExp('(^|[^A-Za-z0-9_$])' + name + '[ ]*:').test(jsOnly) || // 对象键
  new RegExp('(^|[^A-Za-z0-9_$])' + name + '[ ]*=[^=]').test(jsOnly) || // 赋值
  new RegExp('(^|[^A-Za-z0-9_$])' + name + '[ ]*\\([^)]*\\)[ ]*\\{').test(jsOnly) || // 方法简写 name(a) {
  new RegExp('[(,][ ]*' + name + '[ ]*[,)]').test(jsOnly); // 参数位置

const suspect = [...called].filter(
  (n) => !declared.has(n) && !BUILTINS.has(n) && !/^[A-Z]/.test(n) && !looksDefined(n)
);

// 结构自检
const checks = [
  // 这项只是启发式提醒：拼接式构建可能漏掉某个依赖。
  // 真正的门禁是 test/userscript-smoke.mjs，它在真浏览器里跑完整流程。
  ['启发式：没有疑似「调用了但没定义」的函数', suspect.length === 0],
  ['metadata 块', /\/\/ ==UserScript==[\s\S]*\/\/ ==\/UserScript==/.test(body)],
  ['GM_xmlhttpRequest 授权', /@grant\s+GM_xmlhttpRequest/.test(body)],
  ['@connect 通配', /@connect\s+\*/.test(body)],
  ['document-start', /@run-at\s+document-start/.test(body)],
  ['内联了 CSS', /const CSS = String\.raw`/.test(body)],
  ['内联了界面 ui.js', /window\.MGUI = \{ mount/.test(body)],
  ['界面含图片网格与预览', /mg-viewer/.test(body) && /mg-grid/.test(body)],
  ['界面含体积标识', /mg-size/.test(body)],
  ['内联了 HLS 下载', /async function downloadHls/.test(body)],
  ['内联了转封装', /async function remuxToMp4/.test(body)],
  ['内联了 AES 纯 JS 回落', /function aes128CbcDecrypt/.test(body)],
  ['没有残留 import', !/^\s*import\s/m.test(body)],
  ['没有残留 export', !/^\s*export\s/m.test(body)],
];
let bad = 0;
for (const [name, ok] of checks) {
  const soft = name.includes('疑似');
  console.log(`  [${ok ? '通过' : soft ? '提醒' : '失败'}] ${name}${!ok ? ' → ' + suspect.join(', ') : ''}`);
  if (!ok && !soft) bad++;
}
process.exit(bad ? 1 : 0);
