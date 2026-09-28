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

const VERSION = '1.0.0';

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

const LIB_FILES = ['util.js', 'detect.js', 'aes.js', 'hls.js', 'ts2mp4.js'];
const modules = [];
for (const f of LIB_FILES) {
  const code = await readFile(path.join(LIB, f), 'utf8');
  modules.push(`// ===== 来自 extension/src/lib/${f}（原样内联，勿手改；改请改源文件后重新构建）=====\n${inlineModule(code, f)}`);
}

const css = await readFile(path.join(ROOT, 'extension', 'src', 'panel.css'), 'utf8');
if (css.includes('`') || css.includes('${')) throw new Error('panel.css 里出现了反引号或 ${，需要换一种嵌入方式');

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

// 结构自检
const checks = [
  ['metadata 块', /\/\/ ==UserScript==[\s\S]*\/\/ ==\/UserScript==/.test(body)],
  ['GM_xmlhttpRequest 授权', /@grant\s+GM_xmlhttpRequest/.test(body)],
  ['@connect 通配', /@connect\s+\*/.test(body)],
  ['document-start', /@run-at\s+document-start/.test(body)],
  ['内联了 CSS', /const CSS = String\.raw`/.test(body)],
  ['内联了 HLS 下载', /async function downloadHls/.test(body)],
  ['内联了转封装', /async function remuxToMp4/.test(body)],
  ['内联了 AES 纯 JS 回落', /function aes128CbcDecrypt/.test(body)],
  ['没有残留 import', !/^\s*import\s/m.test(body)],
  ['没有残留 export', !/^\s*export\s/m.test(body)],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  [${ok ? '通过' : '失败'}] ${name}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
