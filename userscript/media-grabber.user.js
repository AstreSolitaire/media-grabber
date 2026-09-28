// ==UserScript==
// @name         媒体嗅探下载器
// @namespace    local.media-grabber
// @version      1.0.0
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
// @icon         data:image/png;base64,[object Promise]
// @noframes     false
// ==/UserScript==

/* eslint-disable */
(function () {
'use strict';

// 面板样式：来自 extension/src/panel.css
const CSS = String.raw`/* 面板样式。同时用于网页内的 Shadow DOM 和扩展弹窗，
   所以变量定义在 .mg-root 上而不是 :root，避免依赖外层文档。 */

.mg-root {
  --mg-bg: #ffffff;
  --mg-fg: #1b1d21;
  --mg-muted: #6b7280;
  --mg-line: #e6e8ec;
  --mg-accent: #2563eb;
  --mg-accent-fg: #ffffff;
  --mg-soft: #f4f5f7;
  --mg-danger: #dc2626;
  --mg-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
  --mg-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: var(--mg-fg);
  box-sizing: border-box;
}

@media (prefers-color-scheme: dark) {
  .mg-root {
    --mg-bg: #1c1f24;
    --mg-fg: #e8eaed;
    --mg-muted: #9aa3af;
    --mg-line: #33383f;
    --mg-accent: #6ea8fe;
    --mg-accent-fg: #10213d;
    --mg-soft: #262a30;
    --mg-danger: #f87171;
    --mg-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
}

.mg-root *,
.mg-root *::before,
.mg-root *::after {
  box-sizing: border-box;
}

/* ---------------------------------------------------------------- 悬浮按钮 */

.mg-fab {
  position: fixed;
  right: 14px;
  bottom: 88px;
  z-index: 2147483000;
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: var(--mg-accent);
  color: var(--mg-accent-fg);
  box-shadow: var(--mg-shadow);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mg-fab:active {
  transform: scale(0.94);
}

.mg-root.mg-open .mg-fab {
  display: none;
}

.mg-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: #ef4444;
  color: #fff;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  font-weight: 600;
}

/* ---------------------------------------------------------------- 面板 */

.mg-panel {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 2147483001;
  width: min(420px, calc(100vw - 24px));
  max-height: min(72vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--mg-bg);
  color: var(--mg-fg);
  border: 1px solid var(--mg-line);
  border-radius: var(--mg-radius);
  box-shadow: var(--mg-shadow);
  overflow: hidden;
}

.mg-root.mg-embedded {
  width: 100%;
  height: 100%;
}

.mg-root.mg-embedded .mg-panel {
  position: static;
  width: 100%;
  height: 100%;
  max-height: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

@media (max-width: 560px) {
  .mg-panel {
    right: 0;
    left: 0;
    bottom: 0;
    width: 100%;
    max-height: 76vh;
    border-radius: 16px 16px 0 0;
  }
}

.mg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mg-line);
  background: var(--mg-bg);
}

.mg-title {
  font-weight: 600;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.mg-count {
  display: inline-block;
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 9px;
  background: var(--mg-soft);
  color: var(--mg-muted);
  font-size: 12px;
  font-weight: 500;
  text-align: center;
}

.mg-head-actions {
  display: flex;
  gap: 4px;
}

.mg-icon-btn {
  border: 1px solid var(--mg-line);
  background: var(--mg-bg);
  color: var(--mg-fg);
  border-radius: 8px;
  min-height: 32px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  touch-action: manipulation;
}

.mg-icon-btn:active {
  background: var(--mg-soft);
}

.mg-notice {
  padding: 8px 12px;
  font-size: 13px;
  background: var(--mg-soft);
  color: var(--mg-fg);
  border-bottom: 1px solid var(--mg-line);
}

/* ---------------------------------------------------------------- 下载任务 */

.mg-jobs:empty {
  display: none;
}

.mg-jobs {
  border-bottom: 1px solid var(--mg-line);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 40vh;
  overflow: auto;
}

.mg-job-top {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

.mg-job-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.mg-job-pct {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--mg-muted);
  white-space: nowrap;
}

.mg-job-cancel {
  min-height: 26px;
  padding: 2px 8px;
  font-size: 12px;
}

.mg-bar {
  height: 5px;
  border-radius: 3px;
  background: var(--mg-soft);
  overflow: hidden;
  margin: 6px 0 4px;
}

.mg-bar > i {
  display: block;
  height: 100%;
  width: 0;
  background: var(--mg-accent);
  transition: width 0.2s ease;
}

.mg-bar > i.mg-bar-indet {
  width: 35%;
  animation: mg-slide 1.1s ease-in-out infinite alternate;
}

@keyframes mg-slide {
  from {
    margin-left: 0;
  }
  to {
    margin-left: 65%;
  }
}

.mg-job-state {
  font-size: 12px;
  color: var(--mg-muted);
}

/* ---------------------------------------------------------------- 列表 */

.mg-list {
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  flex: 1;
  min-height: 0;
}

.mg-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mg-line);
}

.mg-item:last-child {
  border-bottom: none;
}

.mg-chip {
  flex: none;
  align-self: flex-start;
  margin-top: 1px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  background: var(--mg-soft);
  color: var(--mg-muted);
  white-space: nowrap;
}

.mg-chip-audio {
  background: rgba(16, 185, 129, 0.16);
  color: #0f9d70;
}

.mg-chip-video {
  background: rgba(59, 130, 246, 0.16);
  color: #2563eb;
}

.mg-chip-hls {
  background: rgba(245, 158, 11, 0.18);
  color: #b45309;
}

.mg-chip-image {
  background: rgba(168, 85, 247, 0.16);
  color: #7c3aed;
}

@media (prefers-color-scheme: dark) {
  .mg-chip-audio {
    color: #4ade80;
  }
  .mg-chip-video {
    color: #93c5fd;
  }
  .mg-chip-hls {
    color: #fcd34d;
  }
  .mg-chip-image {
    color: #d8b4fe;
  }
}

/* ---------------------------------------------------------------- 分页 */

.mg-tabs {
  display: flex;
  gap: 6px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--mg-line);
}

.mg-tab {
  border: none;
  background: transparent;
  color: var(--mg-muted);
  font: inherit;
  font-size: 13.5px;
  padding: 6px 10px 8px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  touch-action: manipulation;
}

.mg-tab.is-active {
  color: var(--mg-accent);
  border-bottom-color: var(--mg-accent);
  font-weight: 600;
}

.mg-tab-n {
  font-weight: 500;
  font-size: 12px;
  background: var(--mg-soft);
  color: var(--mg-muted);
  border-radius: 9px;
  padding: 1px 6px;
  min-width: 18px;
  text-align: center;
}

.mg-tab.is-active .mg-tab-n {
  background: rgba(37, 99, 235, 0.14);
  color: var(--mg-accent);
}

/* ---------------------------------------------------------------- 体积 */

.mg-size {
  font-weight: 600;
  color: var(--mg-fg);
}

.mg-size-est {
  font-weight: 500;
  color: var(--mg-muted);
}

.mg-size-unknown {
  font-weight: 500;
  color: var(--mg-muted);
  opacity: 0.8;
}

.mg-sep {
  margin: 0 4px;
  color: var(--mg-line);
}

.mg-item-main {
  flex: 1;
  min-width: 0;
}

.mg-name {
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mg-meta {
  font-size: 12px;
  color: var(--mg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mg-item-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.mg-btn {
  border: none;
  background: var(--mg-accent);
  color: var(--mg-accent-fg);
  border-radius: 8px;
  min-height: 36px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  touch-action: manipulation;
}

.mg-btn:active {
  opacity: 0.85;
}

.mg-btn-ghost {
  background: var(--mg-soft);
  color: var(--mg-fg);
}

.mg-btn-sm {
  min-height: 32px;
  padding: 4px 10px;
  font-size: 12.5px;
}

.mg-copy {
  min-height: 36px;
}

.mg-variants {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 8px;
}

.mg-variant-hint {
  font-size: 12.5px;
  color: var(--mg-muted);
}

.mg-empty {
  padding: 22px 16px;
  text-align: center;
  color: var(--mg-muted);
  font-size: 13px;
  line-height: 1.7;
}

/* ---------------------------------------------------------------- 底部 */

.mg-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--mg-line);
  background: var(--mg-bg);
  flex-wrap: wrap;
}

.mg-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--mg-fg);
  cursor: pointer;
  margin-right: auto;
}

.mg-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--mg-accent);
}

.mg-foot-btn {
  border: 1px solid var(--mg-line);
  background: var(--mg-bg);
  color: var(--mg-fg);
  border-radius: 8px;
  min-height: 32px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
}

.mg-foot-btn:active {
  background: var(--mg-soft);
}

/* ---------------------------------------------------------------- 图片网格 */

.mg-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  padding: 10px 12px;
  align-content: start;
}

.mg-thumb {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mg-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--mg-soft);
}

.mg-thumb img {
  width: 100%;
  height: 104px;
  object-fit: cover;
  display: block;
  cursor: zoom-in;
  background: repeating-conic-gradient(rgba(127, 127, 127, 0.18) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}

.mg-thumb-broken {
  min-height: 104px;
  align-items: center;
  justify-content: center;
}

.mg-thumb-fail {
  font-size: 12px;
  color: var(--mg-muted);
  padding: 34px 0;
}

.mg-thumb-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--mg-bg);
  font-size: 12px;
}

.mg-thumb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mg-muted);
}

.mg-thumb-info .mg-size {
  font-size: 12px;
  white-space: nowrap;
}

.mg-thumb-dl {
  flex: none;
  border: none;
  background: var(--mg-accent);
  color: var(--mg-accent-fg);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
  touch-action: manipulation;
}

/* ---------------------------------------------------------------- 全屏预览 */

.mg-viewer {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  background: rgba(12, 14, 18, 0.94);
  display: flex;
  flex-direction: column;
  color: #f3f4f6;
}

.mg-viewer[hidden] {
  display: none;
}

.mg-viewer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.5);
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.mg-viewer-left {
  flex: 1;
  min-width: 0;
}

.mg-viewer-title {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mg-viewer-meta {
  font-size: 12px;
  color: #b6bcc6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mg-viewer-bar .mg-icon-btn {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
  color: #f3f4f6;
}

.mg-viewer-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  overflow: auto;
}

.mg-viewer-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
}

.mg-viewer-media {
  width: 100%;
  max-height: 100%;
  border-radius: 6px;
  background: #000;
}

.mg-viewer-hint {
  max-width: 320px;
  text-align: center;
  font-size: 14px;
  line-height: 1.7;
  color: #cbd2dc;
}
`;

// ===== 来自 extension/src/ui.js（界面，共用同一份实现）=====
// 面板 UI。这个文件是普通脚本（不是 ES 模块），因为 content script 不能静态 import。
// 挂在 window.MGUI 上，网页内的面板和扩展弹窗共用同一套渲染逻辑与样式。

(function () {
  if (window.MGUI) return;

  const KIND_LABEL = { audio: '音频', video: '视频', hls: '流', dash: '流', image: '图片', other: '其他' };
  const KIND_CLASS = {
    audio: 'mg-chip-audio',
    video: 'mg-chip-video',
    hls: 'mg-chip-hls',
    dash: 'mg-chip-hls',
    image: 'mg-chip-image',
    other: 'mg-chip-other',
  };

  // 能在浏览器里直接播放的格式（m3u8 在 Chrome 内核里原生播不了）
  const PLAYABLE_VIDEO = /\.(mp4|m4v|webm|ogv|mov)$/i;
  const PLAYABLE_AUDIO = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba)$/i;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function formatBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '';
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  function shortText(s, max) {
    const str = String(s || '');
    if (str.length <= max) return str;
    const head = Math.ceil((max - 1) * 0.62);
    return str.slice(0, head) + '…' + str.slice(str.length - (max - 1 - head));
  }

  function copyText(text) {
    return new Promise((resolve) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => resolve(true),
          () => resolve(fallbackCopy(text))
        );
        return;
      }
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(path, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size || 22);
    svg.setAttribute('height', size || 22);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
    return svg;
  }

  function buildShell(opts) {
    const root = el('div', 'mg-root' + (opts.embedded ? ' mg-embedded' : ''));

    let fab = null;
    let badge = null;
    if (!opts.embedded) {
      fab = el('button', 'mg-fab');
      fab.type = 'button';
      fab.title = '媒体嗅探下载器';
      fab.appendChild(icon('M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2'));
      badge = el('span', 'mg-badge');
      badge.hidden = true;
      fab.appendChild(badge);
      root.appendChild(fab);
    }

    const panel = el('section', 'mg-panel');
    panel.hidden = !opts.embedded;

    const head = el('header', 'mg-head');
    const title = el('div', 'mg-title');
    title.appendChild(el('span', null, '发现的资源'));
    const count = el('span', 'mg-count', '0');
    title.appendChild(count);
    head.appendChild(title);

    const headActions = el('div', 'mg-head-actions');
    const refreshBtn = el('button', 'mg-icon-btn');
    refreshBtn.type = 'button';
    refreshBtn.textContent = '刷新';
    const openAllBtn = el('button', 'mg-icon-btn');
    openAllBtn.type = 'button';
    openAllBtn.textContent = '复制';
    const closeBtn = el('button', 'mg-icon-btn mg-close');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    headActions.append(refreshBtn, openAllBtn, closeBtn);
    head.appendChild(headActions);
    panel.appendChild(head);

    // 媒体 / 图片 分页。默认媒体，图片单独一页，免得缩略图把列表冲乱。
    const tabs = el('div', 'mg-tabs');
    const tabMedia = el('button', 'mg-tab is-active');
    tabMedia.type = 'button';
    tabMedia.append(el('span', null, '媒体'), el('b', 'mg-tab-n', '0'));
    const tabImage = el('button', 'mg-tab');
    tabImage.type = 'button';
    tabImage.append(el('span', null, '图片'), el('b', 'mg-tab-n', '0'));
    tabs.append(tabMedia, tabImage);
    panel.appendChild(tabs);

    const notice = el('div', 'mg-notice');
    notice.hidden = true;
    panel.appendChild(notice);

    const jobs = el('div', 'mg-jobs');
    panel.appendChild(jobs);

    const list = el('div', 'mg-list');
    panel.appendChild(list);

    const grid = el('div', 'mg-grid');
    grid.hidden = true;
    panel.appendChild(grid);

    const empty = el('div', 'mg-empty');
    empty.innerHTML = '还没有发现可下载的音频、视频或图片。<br>让页面把视频播放一下，或点“刷新”再试。';
    panel.appendChild(empty);

    const foot = el('footer', 'mg-foot');
    const remuxLabel = el('label', 'mg-check');
    const remux = el('input');
    remux.type = 'checkbox';
    remuxLabel.append(remux, el('span', null, 'm3u8 转成 MP4'));
    const showAllBtn = el('button', 'mg-foot-btn mg-show-all');
    showAllBtn.type = 'button';
    showAllBtn.hidden = true;
    const clearBtn = el('button', 'mg-foot-btn mg-clear');
    clearBtn.type = 'button';
    clearBtn.textContent = '清空';
    foot.append(remuxLabel, showAllBtn, clearBtn);
    panel.appendChild(foot);

    // 全屏预览
    const viewer = el('div', 'mg-viewer');
    viewer.hidden = true;
    const bar = el('div', 'mg-viewer-bar');
    const vTitle = el('div', 'mg-viewer-title');
    const vMeta = el('div', 'mg-viewer-meta');
    const vInfo = el('div', 'mg-viewer-left');
    vInfo.append(vTitle, vMeta);
    const vDl = el('button', 'mg-btn mg-btn-sm', '下载');
    vDl.type = 'button';
    const vClose = el('button', 'mg-icon-btn', '✕');
    vClose.type = 'button';
    bar.append(vInfo, vDl, vClose);
    const vBody = el('div', 'mg-viewer-body');
    const vHint = el('div', 'mg-viewer-hint');
    viewer.append(bar, vBody);
    root.append(panel, viewer);

    return {
      root, fab, panel, badge, count, notice, jobs, list, grid, empty, remux,
      showAllBtn, clearBtn, refreshBtn, openAllBtn, closeBtn,
      tabs, tabMedia, tabImage, viewer, vTitle, vMeta, vBody, vHint, vDl, vClose,
    };
  }

  /**
   * @param {Element} container 挂载点
   * @param {object} opts {embedded, onDownload(item, variantUrl), onProbe(item), onClear(), onRefresh(), onToggleRemux(v), onCancel(jobId), onOpen()}
   */
  function mount(container, opts) {
    const o = opts || {};
    const shell = buildShell(o);
    container.appendChild(shell.root);

    let items = [];
    let jobs = [];
    let showAll = false;
    let settingRemux = false;
    let expandedId = null;
    let probing = new Set();
    let view = 'media';
    let isOpen = !!o.embedded;
    let viewerItem = null;

    const visibleOf = (kind) => {
      if (kind === 'image') return items.filter((it) => it.kind === 'image');
      return items.filter((it) => it.kind !== 'image');
    };

    function currentList() {
      const list = visibleOf(view);
      return showAll ? list : list.filter((it) => !it.suspect);
    }

    /** HLS 条目自动探测一次，好把时长和预估体积补上（最多同时 3 个）。 */
    function autoProbe() {
      const pending = items.filter(
        (it) => it.kind === 'hls' && !it.info && !it.probeFailed && !probing.has(it.id)
      );
      for (const it of pending.slice(0, 3)) {
        probing.add(it.id);
        if (o.onProbe) o.onProbe(it);
      }
    }

    /** 体积未知的直链，让宿主去问一下（一次问几个，别一下发太多请求）。 */
    const sizeAsked = new Set();
    function askSizes() {
      if (!o.onNeedSize) return;
      const need = items.filter((it) => {
        if (it.kind === 'hls' || it.kind === 'dash') return false; // 流的体积靠探测估算
        if (sizeAsked.has(it.id)) return false;
        // 没拿到体积的要问；另外音视频元素可能只取了文件开头一段，
        // 资源时间线给的 transferSize 只是那一段，所以也要问一次真实大小。
        return !it.size || it.kind === 'video' || it.kind === 'audio';
      });
      for (const it of need.slice(0, 6)) {
        sizeAsked.add(it.id);
        o.onNeedSize(it);
      }
    }

    function render() {
      const mediaList = visibleOf('media');
      const imageList = visibleOf('image');
      const shown = currentList();
      const hiddenCount = visibleOf(view).length - shown.length;

      shell.count.textContent = String(shown.length);
      shell.tabMedia.querySelector('.mg-tab-n').textContent = String(mediaList.length);
      shell.tabImage.querySelector('.mg-tab-n').textContent = String(imageList.length);
      shell.tabMedia.classList.toggle('is-active', view === 'media');
      shell.tabImage.classList.toggle('is-active', view === 'image');
      if (shell.fab) shell.badge.textContent = String(mediaList.length + imageList.length);
      if (shell.badge) shell.badge.hidden = mediaList.length + imageList.length === 0;

      shell.empty.hidden = shown.length > 0 || jobs.length > 0;

      if (view === 'image') {
        shell.list.hidden = true;
        shell.grid.hidden = false;
        renderGrid(shown);
      } else {
        shell.grid.hidden = true;
        shell.list.hidden = false;
        shell.list.textContent = '';
        for (const it of shown) shell.list.appendChild(renderItem(it));
      }

      shell.showAllBtn.hidden = hiddenCount === 0;
      if (view === 'image') shell.showAllBtn.textContent = showAll ? '隐藏小图标' : `显示小图标 (${hiddenCount})`;
      else shell.showAllBtn.textContent = showAll ? '隐藏疑似分片' : `显示疑似分片 (${hiddenCount})`;

      askSizes();
    }

    /** 体积文字：直链用真实大小，流用探测出来的预估大小。 */
    function sizeOf(it) {
      const est = it.info && it.info.estimatedBytes;
      // 流媒体要显示「整个流大概多大」，而不是播放列表文件本身那几百字节
      if (it.kind === 'hls' || it.kind === 'dash') {
        return est > 0 ? { text: '约 ' + formatBytes(est), estimate: true } : null;
      }
      if (it.size > 0) return { text: formatBytes(it.size), estimate: false };
      if (est > 0) return { text: '约 ' + formatBytes(est), estimate: true };
      return null;
    }

    function renderItem(it) {
      const row = el('div', 'mg-item mg-kind-' + (it.kind || 'other'));
      const chip = el('span', 'mg-chip ' + (KIND_CLASS[it.kind] || KIND_CLASS.other), KIND_LABEL[it.kind] || '媒体');

      const main = el('div', 'mg-item-main');
      const name = el('div', 'mg-name', it.filename || it.url);
      name.title = it.url;

      const meta = el('div', 'mg-meta');
      meta.title = it.url; // 悬停能看到完整地址，测试也靠它定位条目
      const size = sizeOf(it);
      if (size) {
        const sizeEl = el('span', 'mg-size' + (size.estimate ? ' mg-size-est' : ''), size.text);
        sizeEl.title = size.estimate ? '按时长与码率估算，实际会有出入' : '文件大小';
        meta.appendChild(sizeEl);
        meta.appendChild(el('span', 'mg-sep', '·'));
      } else if (it.kind === 'hls' && !it.info) {
        meta.appendChild(el('span', 'mg-size mg-size-unknown', '统计中…'));
        meta.appendChild(el('span', 'mg-sep', '·'));
      }

      const dur = (it.info && it.info.duration) || 0;
      const bits = [it.host];
      if (dur > 0) bits.push(formatDuration(dur));
      if (it.info && it.info.isLive) bits.push('直播');
      if (it.info && it.info.encryption && it.info.encryption.method) bits.push(it.info.encryption.method + ' 加密');
      if (it.title) bits.push(shortText(it.title, 34));
      meta.appendChild(el('span', null, bits.join(' · ')));
      main.append(name, meta);

      const actions = el('div', 'mg-item-actions');
      if (it.kind === 'hls' || it.kind === 'dash') {
        const preview = el('button', 'mg-btn mg-btn-ghost mg-btn-sm', '预览');
        preview.type = 'button';
        preview.addEventListener('click', (e) => {
          e.stopPropagation();
          openViewer(it);
        });
        actions.appendChild(preview);
        const dl = el('button', 'mg-btn', '清晰度');
        dl.type = 'button';
        dl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expandedId !== it.id) {
            expandedId = it.id;
            render();
            if (o.onProbe && !it.info) o.onProbe(it);
            return;
          }
          expandedId = null;
          render();
        });
        actions.appendChild(dl);
      } else {
        const preview = el('button', 'mg-btn mg-btn-ghost mg-btn-sm', '预览');
        preview.type = 'button';
        preview.addEventListener('click', (e) => {
          e.stopPropagation();
          openViewer(it);
        });
        const dl = el('button', 'mg-btn', '下载');
        dl.type = 'button';
        dl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (o.onDownload) o.onDownload(it, null);
        });
        actions.append(preview, dl);
      }
      row.append(chip, main, actions);

      if (expandedId === it.id) {
        const holder = el('div', 'mg-variants');
        holder.dataset.role = 'variants';
        const vs = it.variants;
        if (!it.info) holder.appendChild(el('div', 'mg-variant-hint', '正在读取清晰度…'));
        else if (!vs || !vs.length) holder.appendChild(el('div', 'mg-variant-hint', '这条流没有多档清晰度，可直接下载。'));
        else {
          for (const v of vs) {
            if (v.iframe) continue;
            const label = v.label || '清晰度';
            const est = v.estimatedBytes > 0 ? ' · 约 ' + formatBytes(v.estimatedBytes) : '';
            const b = el('button', 'mg-btn mg-btn-sm', label + est);
            b.type = 'button';
            b.title = label + est;
            b.addEventListener('click', (e) => {
              e.stopPropagation();
              expandedId = null;
              if (o.onDownload) o.onDownload(it, v.url);
            });
            holder.appendChild(b);
          }
        }
        const bestText = vs && vs.length ? '最高码率直接下' : '下载';
        const bestEst = it.info && it.info.estimatedBytes > 0 ? `（约 ${formatBytes(it.info.estimatedBytes)}）` : '';
        const best = el('button', 'mg-btn mg-btn-sm' + (vs && vs.length ? ' mg-btn-ghost' : ''), bestText + (vs && vs.length ? '' : bestEst));
        best.type = 'button';
        best.addEventListener('click', (e) => {
          e.stopPropagation();
          expandedId = null;
          if (o.onDownload) o.onDownload(it, 'best');
        });
        const cancel = el('button', 'mg-btn mg-btn-sm mg-btn-ghost', '收起');
        cancel.type = 'button';
        cancel.addEventListener('click', (e) => {
          e.stopPropagation();
          expandedId = null;
          render();
        });
        holder.append(best, cancel);
        row.appendChild(holder);
      }
      return row;
    }

    function renderGrid(list) {
      shell.grid.textContent = '';
      for (const it of list) {
        const cell = el('div', 'mg-thumb');
        cell.title = it.url;
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = it.filename || '';
        img.src = it.url;
        img.addEventListener('click', () => openViewer(it));
        img.addEventListener('error', () => {
          cell.classList.add('mg-thumb-broken');
          img.remove();
          cell.appendChild(el('span', 'mg-thumb-fail', '无法显示'));
        });
        cell.appendChild(img);
        const info = el('div', 'mg-thumb-info');
        info.appendChild(el('span', 'mg-thumb-name', it.filename || it.url));
        const size = sizeOf(it);
        info.appendChild(el('span', 'mg-size', size ? size.text : '大小未知'));
        const dl = el('button', 'mg-thumb-dl', '下载');
        dl.type = 'button';
        dl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (o.onDownload) o.onDownload(it, null);
        });
        info.appendChild(dl);
        cell.appendChild(info);
        shell.grid.appendChild(cell);
      }
    }

    // ---------------------------------------------------------- 预览

    function clearViewerBody() {
      const v = shell.vBody;
      if (v._el) {
        try {
          v._el.pause();
        } catch {
          /* 忽略 */
        }
        try {
          v._el.removeAttribute('src');
          v._el.load && v._el.load();
        } catch {
          /* 忽略 */
        }
        v._el = null;
      }
      v.textContent = '';
    }

    function openViewer(it) {
      viewerItem = it;
      clearViewerBody();
      shell.vTitle.textContent = it.filename || it.url;
      shell.vTitle.title = it.url;

      const parts = [];
      const size = sizeOf(it);
      if (size) parts.push(size.text);
      if (it.info && it.info.duration) parts.push(formatDuration(it.info.duration));
      if (it.host) parts.push(it.host);
      shell.vMeta.textContent = parts.join(' · ');
      shell.viewer.hidden = false;

      const kindOf = (() => {
        if (it.kind === 'image') return 'image';
        if (it.kind === 'audio') return 'audio';
        if (it.kind === 'hls' || it.kind === 'dash') return 'stream';
        if (PLAYABLE_VIDEO.test(it.url) || it.kind === 'video') return 'video';
        if (PLAYABLE_AUDIO.test(it.url)) return 'audio';
        return 'other';
      })();

      if (kindOf === 'image') {
        const img = document.createElement('img');
        img.className = 'mg-viewer-img';
        img.src = it.url;
        img.alt = it.filename || '';
        img.addEventListener('error', () => showHint('这张图片加载不出来（可能需要登录或原页面已失效）。'));
        shell.vBody.appendChild(img);
        shell.vBody._el = img;
      } else if (kindOf === 'video' || kindOf === 'audio') {
        const media = document.createElement(kindOf === 'video' ? 'video' : 'audio');
        media.className = 'mg-viewer-media';
        media.controls = true;
        media.autoplay = true;
        media.playsInline = true;
        media.preload = 'metadata';
        media.src = it.url;
        media.addEventListener('error', () => {
          showHint('浏览器无法直接播放这个地址（可能是分片流或需要防盗链信息），可以先下载再播放。');
        });
        shell.vBody.appendChild(media);
        shell.vBody._el = media;
      } else if (kindOf === 'stream') {
        showHint('m3u8 这类流媒体不能直接预览，点右上角「下载」保存成 MP4 后播放。');
      } else {
        showHint('这个格式浏览器没法直接预览，可以直接下载。');
      }
    }

    function showHint(text) {
      shell.vBody.appendChild(el('div', 'mg-viewer-hint', text));
    }

    function closeViewer() {
      clearViewerBody();
      shell.viewer.hidden = true;
      viewerItem = null;
    }

    // ---------------------------------------------------------- 任务

    function renderJobs() {
      shell.jobs.textContent = '';
      for (const j of jobs) {
        const box = el('div', 'mg-job');
        const top = el('div', 'mg-job-top');
        top.appendChild(el('div', 'mg-job-name', shortText(j.filename || j.url || '下载中', 42)));
        const pct = j.total ? Math.min(100, Math.round((j.current / j.total) * 100)) : null;
        const right = el('div', 'mg-job-pct', pct != null ? pct + '%' : '');
        if (j.cancelable && o.onCancel) {
          const c = el('button', 'mg-icon-btn mg-job-cancel', '取消');
          c.type = 'button';
          c.addEventListener('click', () => o.onCancel(j.id));
          right.appendChild(c);
        }
        top.appendChild(right);
        box.appendChild(top);
        const bar = el('div', 'mg-bar');
        const fill = el('i');
        if (pct != null) fill.style.width = pct + '%';
        else fill.classList.add('mg-bar-indet');
        bar.appendChild(fill);
        box.appendChild(bar);
        box.appendChild(el('div', 'mg-job-state', j.message || ''));
        shell.jobs.appendChild(box);
      }
    }

    // ---------------------------------------------------------- 事件

    function open() {
      isOpen = true;
      shell.panel.hidden = false;
      shell.root.classList.add('mg-open');
      if (o.onOpen) o.onOpen();
      // 展开时顺手把流媒体的时长/预估体积补上
      autoProbe();
    }
    function close() {
      isOpen = false;
      shell.panel.hidden = true;
      shell.root.classList.remove('mg-open');
      closeViewer();
    }
    function toggle() {
      if (isOpen) close();
      else open();
    }

    if (shell.fab) shell.fab.addEventListener('click', toggle);
    shell.tabs.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.mg-tab') : null;
      if (!btn) return;
      view = btn === shell.tabImage ? 'image' : 'media';
      expandedId = null;
      render();
    });
    shell.closeBtn.addEventListener('click', close);
    shell.clearBtn.addEventListener('click', () => o.onClear && o.onClear());
    shell.refreshBtn.addEventListener('click', () => o.onRefresh && o.onRefresh());
    shell.openAllBtn.addEventListener('click', async () => {
      const text = currentList()
        .map((it) => it.url)
        .join('\n');
      if (!text) return;
      const ok = await copyText(text);
      shell.openAllBtn.textContent = ok ? '已复制' : '失败';
      setTimeout(() => {
        shell.openAllBtn.textContent = '复制';
      }, 1500);
    });
    shell.showAllBtn.addEventListener('click', () => {
      showAll = !showAll;
      render();
    });
    shell.remux.addEventListener('change', () => {
      if (settingRemux) return;
      o.onToggleRemux && o.onToggleRemux(shell.remux.checked);
    });
    shell.vClose.addEventListener('click', closeViewer);
    shell.vDl.addEventListener('click', () => {
      const it = viewerItem;
      if (!it) return;
      if (o.onDownload) o.onDownload(it, 'best');
      shell.vDl.textContent = '已开始';
      setTimeout(() => {
        shell.vDl.textContent = '下载';
      }, 1500);
    });
    shell.viewer.addEventListener('click', (e) => {
      if (e.target === shell.viewer) closeViewer();
    });
    try {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !shell.viewer.hidden) closeViewer();
      });
    } catch {
      /* 忽略 */
    }

    let noticeTimer = 0;
    function setNotice(text, ms) {
      clearTimeout(noticeTimer);
      if (!text) {
        shell.notice.hidden = true;
        return;
      }
      shell.notice.textContent = text;
      shell.notice.hidden = false;
      if (ms) {
        noticeTimer = setTimeout(() => {
          shell.notice.hidden = true;
        }, ms);
      }
    }

    render();

    return {
      setItems(next, opts2) {
        items = next || [];
        if (opts2 && opts2.keepExpanded === false) expandedId = null;
        for (const id of [...probing]) {
          if (!items.some((i) => i.id === id)) probing.delete(id);
        }
        render();
        if (isOpen) autoProbe();
      },
      /** 探测结果：info 里含时长、预估体积、多档清晰度 */
      setProbe(id, info, variants) {
        const it = items.find((x) => x.id === id);
        probing.delete(id);
        if (!it) return;
        if (info) {
          it.info = info;
          it.variants = variants !== undefined ? variants : info.variants;
          if (info.error) it.probeFailed = true;
        } else {
          it.probeFailed = true;
        }
        render();
        // 一次只探几个，完成后接续下一批
        if (isOpen) autoProbe();
      },
      setJobs(next) {
        jobs = next || [];
        renderJobs();
        render();
      },
      setNotice,
      setRemux(v) {
        settingRemux = true;
        shell.remux.checked = !!v;
        settingRemux = false;
      },
      open,
      close,
      toggle,
      openViewerFor(id) {
        const it = items.find((x) => x.id === id);
        if (it) openViewer(it);
      },
      isOpen: () => isOpen,
      isEmbedded: !!o.embedded,
    };
  }

  window.MGUI = { mount, formatBytes, formatDuration, el, icon, shortText, copyText };
})();


// ===== 来自 extension/src/lib/util.js（原样内联，勿手改；改请改源文件后重新构建）=====
// 通用工具：URL 处理、体积格式化、文件名推断、并发控制。
// 这个文件不依赖任何浏览器 API，可以在 Node 里直接跑测试。

function resolveUrl(base, ref) {
  if (!ref) return base;
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

/** 取 URL 的路径部分（忽略查询串），用于判断扩展名。 */
function urlPath(url) {
  try {
    return new URL(url).pathname || '';
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

function urlExt(url) {
  const p = urlPath(url);
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

function urlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 把 Content-Disposition 里的文件名抠出来。
 * 同时支持 filename*=UTF-8''%E4%B8%AD%E6%96%87.mp3 这种 RFC 5987 写法。
 */
function filenameFromDisposition(cd) {
  if (!cd) return '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  if (star) {
    let raw = star[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    const m = /^([\w-]+)'([\w-]*)'(.*)$/.exec(raw);
    if (m) {
      const charset = (m[1] || 'utf-8').toLowerCase();
      const rest = m[3];
      try {
        const bytes = Uint8Array.from(rest.split('').map((c) => c.charCodeAt(0)));
        if (charset === 'utf-8' || charset === 'utf8') {
          return decodeURIComponent(escape(String.fromCharCode(...bytes)));
        }
        return decodeURIComponent(rest);
      } catch {
        try {
          return decodeURIComponent(rest);
        } catch {
          return rest;
        }
      }
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
  if (plain) return (plain[1] || plain[2] || '').trim();
  return '';
}

const BAD_FS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清掉文件名里操作系统不接受的字符，并限制长度。 */
function sanitizeFilename(name, fallback = 'media') {
  let n = String(name || '').replace(BAD_FS, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!n) n = fallback;
  // 给扩展名留出空间，避免最后一位被截断
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    if (dot > 0 && n.length - dot <= 6) {
      n = n.slice(0, 120 - (n.length - dot)) + n.slice(dot);
    } else {
      n = n.slice(0, 120);
    }
  }
  return n;
}

/**
 * 由一个媒体 URL 推断保存用的文件名。
 * 显式给了 contentDisposition / 播放器标题时优先用它们。
 */
function guessFilename({ url, contentType = '', contentDisposition = '', hint = '' } = {}) {
  const ext = urlExt(url);
  const fromCd = sanitizeFilename(filenameFromDisposition(contentDisposition), '');
  if (fromCd) return fromCd;

  let base = '';
  if (hint) {
    base = sanitizeFilename(hint, '');
  }
  if (!base) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      base = sanitizeFilename(decodeURIComponent(seg), 'media');
    } catch {
      base = 'media';
    }
  }
  // 去掉查询串造成的伪扩展名，例如 xxx.mp4?token=...
  base = base.replace(/\.(m3u8|mpd)$/i, '');
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
    const guess = extFromContentType(contentType) || (ext ? '.' + ext : '');
    if (guess) base += guess;
  }
  return base || 'media';
}

function extFromContentType(ct = '') {
  const t = String(ct).toLowerCase().split(';')[0].trim();
  switch (t) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/aac':
      return '.m4a';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/opus':
      return '.opus';
    case 'audio/flac':
    case 'audio/x-flac':
      return '.flac';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'video/mp4':
      return '.mp4';
    case 'video/webm':
      return '.webm';
    case 'video/x-matroska':
      return '.mkv';
    case 'video/mp2t':
      return '.ts';
    case 'application/vnd.apple.mpegurl':
    case 'application/x-mpegurl':
    case 'audio/mpegurl':
    case 'audio/x-mpegurl':
      return '.m3u8';
    default:
      return '';
  }
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/**
 * 按时长和声明码率估算体积。
 * HLS 的 BANDWIDTH 是站点自己声明的峰值码率，算出来通常比真实值略大一点，
 * 所以界面上要标「约」。
 */
function estimateBytes(durationSec, bandwidthBps) {
  const d = Number(durationSec);
  const b = Number(bandwidthBps);
  if (!Number.isFinite(d) || !Number.isFinite(b) || d <= 0 || b <= 0) return 0;
  return Math.round((d * b) / 8);
}

/**
 * 从响应头里取整个文件的总字节数。
 * 优先看 Content-Range（发过 Range 请求时才有），退回 Content-Length。
 * @param {(name:string)=>string|null} getHeader
 */
function totalBytesFromHeaders(getHeader) {
  try {
    const cr = getHeader('content-range');
    if (cr) {
      const m = /\/\s*(\d+)\s*$/.exec(String(cr));
      if (m) return Number(m[1]) || 0;
    }
    const cl = Number(getHeader('content-length'));
    return Number.isFinite(cl) && cl > 0 ? cl : 0;
  } catch {
    return 0;
  }
}

/** 取扩展名（含点），拿不到就返回空串。 */
function extOf(url) {
  try {
    const m = /\.([a-zA-Z0-9]{1,5})$/.exec(new URL(url).pathname);
    return m ? '.' + m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 上一级目录名，用来区分同一页面上的多条同名资源。 */
function parentName(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    const dir = decodeURIComponent(parts[parts.length - 2]);
    return /^[A-Za-z0-9_-]{1,20}$/.test(dir) ? dir : '';
  } catch {
    return '';
  }
}

/** index.m3u8 / image / 1 这类名字没信息量，遇到就拿页面标题替换。 */
function isGenericName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return /^(index|master|playlist|media|video|audio|stream|main|out|hls|dash|file|movie|\d+|segment|master_?playlist|image|img|photo|pic|picture|thumb|thumbnail|avatar|banner|cover|logo|icon|untitled|download|original|large|medium|small|\d+x)$/i.test(
    base
  );
}

/**
 * 用页面标题拼一个像样的文件名。
 * 同目录多条同名时补上级目录名，还不够就补序号。
 * @param {string} title 页面标题
 * @param {string} ext 扩展名（含点）
 * @param {string} url 资源地址，用来取上级目录
 * @param {Iterable<string>} taken 已经占用的文件名
 */
function composeNameFromTitle(title, ext, url, taken = []) {
  const base = sanitizeFilename(String(title || '').replace(/\.[a-z0-9]{2,5}$/i, ''), 'media');
  if (!base) return '';
  const used = new Set(taken);
  let candidate = base + ext;
  if (used.has(candidate)) {
    const dir = parentName(url);
    if (dir && !base.endsWith('-' + dir)) candidate = `${base}-${dir}${ext}`;
    let n = 2;
    while (used.has(candidate) && n < 50) {
      candidate = `${base}${dir ? '-' + dir : ''}-${n}${ext}`;
      n++;
    }
  }
  return candidate;
}

/** 短 URL，便于在手机上阅读。 */
function shortUrl(url, max = 64) {
  const s = String(url || '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 3) * 0.6);
  const tail = max - 3 - head;
  return s.slice(0, head) + '...' + s.slice(s.length - tail);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带并发上限的按序流水线。
 * tasks 里每个元素是一个返回 Promise 的函数；结果按原始下标顺序交给 onResult。
 * 内存里最多只保留 windowSize 个已完成但还没交给 onResult 的结果。
 */
async function orderedPool(items, worker, { concurrency = 4, windowSize = 0, onResult } = {}) {
  const n = items.length;
  const win = Math.max(concurrency, windowSize || concurrency);
  const done = new Map();
  let nextToEmit = 0;
  let nextToStart = 0;
  let firstError = null;

  const flush = async () => {
    while (done.has(nextToEmit)) {
      const v = done.get(nextToEmit);
      done.delete(nextToEmit);
      nextToEmit++;
      if (onResult) await onResult(v, nextToEmit - 1);
    }
  };

  const runOne = async (idx) => {
    const v = await worker(items[idx], idx);
    done.set(idx, v);
  };

  const runners = [];
  const totalRunners = Math.min(concurrency, n);
  for (let r = 0; r < totalRunners; r++) {
    runners.push(
      (async () => {
        while (true) {
          if (firstError) return;
          // 等待窗口腾出位置，避免乱序完成的结果堆在内存里
          while (nextToStart - nextToEmit >= win && !firstError) await sleep(15);
          if (firstError) return;
          const idx = nextToStart++;
          if (idx >= n) return;
          try {
            await runOne(idx);
          } catch (e) {
            if (!firstError) firstError = e;
            return;
          }
          await flush();
        }
      })()
    );
  }

  await Promise.all(runners);
  await flush();
  if (firstError) throw firstError;
  return nextToEmit;
}

/** 简单的指数退避重试。 */
async function retry(fn, { retries = 3, baseDelay = 400, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      if (onRetry) onRetry(e, i + 1);
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function concatUint8(chunks, total) {
  let len = total;
  if (len == null) {
    len = 0;
    for (const c of chunks) len += c.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ===== 来自 extension/src/lib/detect.js（原样内联，勿手改；改请改源文件后重新构建）=====
// 判断一个 URL / Content-Type 属于哪类媒体。纯函数，便于单测。


const AUDIO_EXT = new Set(['mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'ape', 'amr', 'weba', 'mp2', 'aiff', 'caf']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'avi', 'ts', 'm4s', '3gp', 'mpg', 'mpeg', 'ogv', 'wmv', 'f4v']);
const PLAYLIST_EXT = new Set(['m3u8', 'm3u']);
const DASH_EXT = new Set(['mpd']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff']);

// 这些扩展名基本不可能是媒体，直接不看（图片单独判断，见 worthSniffing）
const NEVER_EXT = new Set(['js', 'mjs', 'css', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'map', 'json', 'html', 'htm', 'xml', 'txt', 'wasm', 'pdf']);

const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl',
]);

/**
 * @returns {{kind:'hls'|'dash'|'audio'|'video'|'image'|'playlist'|'unknown', ext:string, why:string}}
 */
function classify({ url = '', contentType = '', contentDisposition = '' } = {}) {
  const ct = String(contentType).toLowerCase().split(';')[0].trim();
  const ext = urlExt(url);
  const path = urlPath(url).toLowerCase();

  // 1) Content-Type 最可靠
  if (HLS_TYPES.has(ct)) return { kind: 'hls', ext: '.m3u8', why: 'content-type' };
  if (ct === 'application/dash+xml') return { kind: 'dash', ext: '.mpd', why: 'content-type' };
  if (ct.startsWith('image/')) return { kind: 'image', ext: '', why: 'content-type' };
  if (ct.startsWith('audio/')) {
    if (ct === 'audio/mpegurl' || ct === 'audio/x-mpegurl') return { kind: 'hls', ext: '.m3u8', why: 'content-type' };
    return { kind: 'audio', ext: '', why: 'content-type' };
  }
  if (ct.startsWith('video/')) {
    if (ct === 'video/mp2t') return { kind: 'video', ext: '.ts', why: 'content-type' };
    return { kind: 'video', ext: '', why: 'content-type' };
  }

  // 2) 扩展名
  if (PLAYLIST_EXT.has(ext)) return { kind: 'hls', ext: '.m3u8', why: 'ext' };
  if (DASH_EXT.has(ext)) return { kind: 'dash', ext: '.mpd', why: 'ext' };
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext: '.' + ext, why: 'ext' };
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', ext: '.' + ext, why: 'ext' };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', ext: '.' + ext, why: 'ext' };

  // 3) 地址里带 m3u8 字样的（?format=m3u8、/hls/m3u8/xxx 之类）基本可以认定是播放列表
  if (/m3u8/i.test(String(url))) return { kind: 'hls', ext: '.m3u8', why: 'url-keyword' };

  // 4) 没有扩展名时看路径里有没有关键词
  if (/(^|[/_.-])(hls|master|index|playlist)([/_.-]|$)/.test(path) && ct === '') {
    return { kind: 'unknown', ext: '', why: 'weak-hls-hint' };
  }
  if (ct === 'application/octet-stream' || ct === '') {
    if (contentDisposition && /\.(mp4|mp3|m4a|flv|mkv|webm|ts|jpg|png|webp)\b/i.test(contentDisposition)) {
      const e = /\.([a-z0-9]{2,5})\b/i.exec(contentDisposition);
      const kind = IMAGE_EXT.has(e[1].toLowerCase()) ? 'image' : VIDEO_EXT.has(e[1].toLowerCase()) ? 'video' : 'audio';
      return { kind, ext: '.' + e[1].toLowerCase(), why: 'disposition' };
    }
  }
  return { kind: 'unknown', ext: '', why: '' };
}

function isMediaKind(kind) {
  return kind === 'audio' || kind === 'video' || kind === 'hls' || kind === 'dash';
}

function isImageKind(kind) {
  return kind === 'image';
}

/**
 * 判断一个 URL 值不值得记下来。避免把脚本、字体、埋点都塞进列表。
 * 图片默认也收，但要求是「图片请求」本身，CSS/脚本里引用到的不算。
 */
function worthSniffing(url, { requestType = '', images = true } = {}) {
  if (!url) return false;
  const u = String(url);
  if (u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('filesystem:')) return false;
  if (!/^https?:/i.test(u)) return false;
  const ext = urlExt(u);
  if (NEVER_EXT.has(ext)) return false;
  if (IMAGE_EXT.has(ext)) {
    if (!images) return false;
    // 只有真正作为图片/资源加载的才算，避免把 a[href] 里的图标地址当图片
    return requestType === 'image' || requestType === 'xmlhttprequest' || requestType === 'other' || requestType === '';
  }
  if (requestType === 'media' || requestType === 'object' || requestType === 'xmlhttprequest' || requestType === 'other' || requestType === '') {
    return true;
  }
  // 经 fetch/XHR 拿到的图片或媒体，requestType 会是 image
  if (requestType === 'image') return true;
  return false;
}

/** Content-Type 是不是图片，用于只有响应头没有扩展名的场景。 */
function isImageContentType(contentType) {
  return String(contentType).toLowerCase().split(';')[0].trim().startsWith('image/');
}

/** 小于这个体积的图片多半是图标、分隔线、埋点像素，默认折叠起来。 */
const TINY_IMAGE_BYTES = 2048;


/**
 * 合并同一条媒体的多次观测结果。后来拿到的响应头/长度能补全早先只有 URL 的记录。
 */
function mergeHit(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'size' && !v) continue;
    out[k] = v;
  }
  // 分类结果以信息量更高的为准
  if (next.contentType && !prev.contentType) out.classified = next.classified;
  if (!out.classified && next.classified) out.classified = next.classified;
  if (prev.classified && next.classified) {
    const rank = (c) => (c.kind === 'hls' || c.kind === 'dash' ? 3 : c.kind === 'audio' || c.kind === 'video' ? 2 : 0);
    out.classified = rank(next.classified) > rank(prev.classified) ? next.classified : prev.classified;
  }
  return out;
}

// ===== 来自 extension/src/lib/aes.js（原样内联，勿手改；改请改源文件后重新构建）=====
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
function aes128CbcDecrypt(ct, key, iv) {
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
async function decryptAes128(ct, key, iv, cryptoImpl = globalThis.crypto) {
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
function sequenceToIv(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

/** 解析 #EXT-X-KEY 里的 IV=0x... */
function parseHexIv(s) {
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

// ===== 来自 extension/src/lib/hls.js（原样内联，勿手改；改请改源文件后重新构建）=====
// HLS(m3u8) 播放列表解析与分片下载。不依赖浏览器 API，Node 里可直接测试。


/**
 * 解析 #EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a,b" 这类属性串。
 * 需要正确处理引号里的逗号，所以不能简单 split(',')。
 */
function parseAttributes(str) {
  const out = {};
  let i = 0;
  const s = String(str || '');
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    const eq = s.indexOf('=', i);
    if (eq === -1) break;
    const key = s.slice(i, eq).trim();
    i = eq + 1;
    let val = '';
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end === -1) {
        val = s.slice(i + 1);
        i = s.length;
      } else {
        val = s.slice(i + 1, end);
        i = end + 1;
      }
    } else {
      let end = s.indexOf(',', i);
      if (end === -1) end = s.length;
      val = s.slice(i, end).trim();
      i = end;
    }
    if (key) out[key] = val;
  }
  return out;
}

function pickBestVariant(variants) {
  const usable = variants.filter((v) => !v.iframe && v.url);
  if (!usable.length) return variants.find((v) => v.url) || null;
  const score = (v) => {
    let s = v.bandwidth || v.averageBandwidth || 0;
    if (v.resolution) {
      const m = /^(\d+)x(\d+)$/.exec(v.resolution);
      if (m) s = Math.max(s, Number(m[1]) * Number(m[2]));
    }
    return s;
  };
  return usable.slice().sort((a, b) => score(b) - score(a))[0];
}

function pickLowestVariant(variants) {
  const usable = variants.filter((v) => !v.iframe && v.url);
  if (!usable.length) return variants.find((v) => v.url) || null;
  const score = (v) => v.bandwidth || v.averageBandwidth || 0;
  return usable.slice().sort((a, b) => score(a) - score(b))[0];
}

/** 给清晰度起个手机上看得懂的名字。 */
function variantLabel(v, index) {
  const parts = [];
  const m = /^(\d+)x(\d+)$/.exec(v.resolution || '');
  if (m) parts.push(`${m[2]}p`);
  else if (v.bandwidth) parts.push(`${Math.round(v.bandwidth / 1000)}kbps`);
  if (m && v.bandwidth) parts.push(`${(v.bandwidth / 1000000).toFixed(1)}Mbps`);
  if (v.frameRate) parts.push(`${Math.round(v.frameRate)}fps`);
  const codec = (v.codecs || '').toLowerCase();
  if (codec.includes('hvc1') || codec.includes('hev1')) parts.push('H.265');
  else if (codec.includes('av01')) parts.push('AV1');
  else if (codec.includes('avc1')) parts.push('H.264');
  if (codec.includes('mp4a')) parts.push('AAC');
  if (!parts.length) parts.push(v.name || `清晰度 ${index + 1}`);
  else if (v.name) parts.unshift(v.name);
  return parts.join(' · ');
}

/**
 * 解析播放列表文本。
 * @returns {{type:'master'|'media'|'unknown', variants:Array, renditions:Array, segments:Array,
 *            map:object|null, targetDuration:number, isLive:boolean, duration:number,
 *            hasDiscontinuity:boolean, encryption:object|null}}
 */
function parsePlaylist(text, baseUrl = '') {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  const renditions = [];
  const segments = [];
  let map = null;
  let pendingVariant = null;
  let currentKey = null;
  let targetDuration = 0;
  let mediaSequence = 0;
  let isMaster = false;
  let hasEndList = false;
  let hasDiscontinuity = false;
  let duration = 0;
  let prevByteRangeEnd = -1;
  let prevByteRangeUri = null;
  let segIndex = 0;
  let pendingDuration = 0;
  let pendingByteRange = null;
  let pendingDiscontinuity = false;
  const methods = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = /^#([A-Za-z0-9-]+)(?::(.*))?$/.exec(line);
      if (!m) continue;
      const tag = m[1].toUpperCase();
      const body = m[2] == null ? '' : m[2];

      if (tag === 'EXT-X-STREAM-INF') {
        isMaster = true;
        const a = parseAttributes(body);
        pendingVariant = {
          url: '',
          bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : 0,
          averageBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : 0,
          resolution: a.RESOLUTION || '',
          codecs: a.CODECS || '',
          frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : 0,
          name: a.NAME || '',
          audioGroup: a.AUDIO || '',
          iframe: false,
        };
      } else if (tag === 'EXT-X-I-FRAME-STREAM-INF') {
        isMaster = true;
        const a = parseAttributes(body);
        if (a.URI) {
          variants.push({
            url: resolveUrl(baseUrl, a.URI),
            bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : 0,
            averageBandwidth: 0,
            resolution: a.RESOLUTION || '',
            codecs: a.CODECS || '',
            frameRate: 0,
            name: '仅关键帧',
            audioGroup: '',
            iframe: true,
          });
        }
      } else if (tag === 'EXT-X-MEDIA') {
        const a = parseAttributes(body);
        renditions.push({
          type: a.TYPE || '',
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
          channels: a.CHANNELS || '',
          url: a.URI ? resolveUrl(baseUrl, a.URI) : '',
        });
      } else if (tag === 'EXTINF') {
        pendingDuration = parseFloat(String(body).split(',')[0]) || 0;
      } else if (tag === 'EXT-X-BYTERANGE') {
        const [len, off] = String(body).split('@');
        pendingByteRange = { length: Number(len), offset: off === undefined ? null : Number(off) };
      } else if (tag === 'EXT-X-KEY') {
        const a = parseAttributes(body);
        if (!a.METHOD || a.METHOD.toUpperCase() === 'NONE') {
          currentKey = null;
        } else {
          currentKey = {
            method: a.METHOD.toUpperCase(),
            uri: a.URI ? resolveUrl(baseUrl, a.URI) : '',
            iv: parseHexIv(a.IV),
            keyFormat: a.KEYFORMAT || 'identity',
            keyFormatVersions: a.KEYFORMATVERSIONS || '',
          };
          methods.add(currentKey.method);
        }
      } else if (tag === 'EXT-X-MAP') {
        const a = parseAttributes(body);
        let br = null;
        if (a.BYTERANGE) {
          const [l, o] = String(a.BYTERANGE).split('@');
          br = { length: Number(l), offset: o === undefined ? 0 : Number(o) };
        }
        map = { url: resolveUrl(baseUrl, a.URI), byteRange: br };
      } else if (tag === 'EXT-X-TARGETDURATION') {
        targetDuration = Number(body) || 0;
      } else if (tag === 'EXT-X-MEDIA-SEQUENCE') {
        mediaSequence = Number(body) || 0;
      } else if (tag === 'EXT-X-DISCONTINUITY') {
        pendingDiscontinuity = true;
        hasDiscontinuity = true;
      } else if (tag === 'EXT-X-ENDLIST') {
        hasEndList = true;
      }
      continue;
    }

    // 非 # 开头 => URI 行
    if (pendingVariant) {
      pendingVariant.url = resolveUrl(baseUrl, line);
      variants.push(pendingVariant);
      pendingVariant = null;
      continue;
    }

    const uri = resolveUrl(baseUrl, line);
    let byteRange = pendingByteRange;
    if (byteRange && byteRange.offset == null) {
      if (prevByteRangeUri === uri && prevByteRangeEnd >= 0) {
        byteRange = { length: byteRange.length, offset: prevByteRangeEnd };
      } else {
        byteRange = { length: byteRange.length, offset: 0 };
      }
    }
    // 个别播放列表会漏写 EXTINF，缺了就按 TARGETDURATION 估一个
    const segDuration = pendingDuration || targetDuration;
    segments.push({
      index: segIndex,
      url: uri,
      duration: segDuration,
      byteRange,
      key: currentKey,
      discontinuity: pendingDiscontinuity,
      seq: mediaSequence + segIndex,
      map,
    });
    duration += segDuration;
    if (byteRange) {
      prevByteRangeUri = uri;
      prevByteRangeEnd = byteRange.offset + byteRange.length;
    }
    pendingDuration = 0;
    pendingByteRange = null;
    pendingDiscontinuity = false;
    segIndex++;
  }

  const type = isMaster || variants.length ? 'master' : segments.length ? 'media' : 'unknown';
  const encryption = methods.size
    ? { methods: [...methods], method: methods.has('AES-128') ? 'AES-128' : [...methods][0] }
    : null;

  return {
    type,
    variants,
    renditions,
    segments,
    map,
    targetDuration,
    isLive: type === 'media' && !hasEndList,
    duration,
    hasDiscontinuity,
    encryption,
    mediaSequence,
  };
}

function makeFetcher({ fetchImpl, referrer, credentials, extraHeaders, retries }) {
  return async function get(url, { range = null, signal = null, timeoutMs = 0 } = {}) {
    const headers = { ...(extraHeaders || {}) };
    if (range) headers['Range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const init = { method: 'GET', headers, credentials: credentials || 'include', redirect: 'follow' };
    if (referrer) {
      init.referrer = referrer;
      init.referrerPolicy = 'unsafe-url';
    }
    let timer = 0;
    let ctl = signal;
    if (!ctl && timeoutMs > 0 && typeof AbortController === 'function') {
      ctl = new AbortController();
      timer = setTimeout(() => {
        try {
          ctl.abort();
        } catch {
          /* 忽略 */
        }
      }, timeoutMs);
    }
    if (ctl) init.signal = ctl.signal;
    try {
      const res = await fetchImpl(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''} - ${url}`.trim());
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function totalLengthOf(res) {
  const h = res.headers;
  if (!h || typeof h.get !== 'function') return 0;
  return totalBytesFromHeaders((n) => h.get(n));
}

async function readBody(res, range) {
  const buf = new Uint8Array(await res.arrayBuffer());
  // 有些服务器忽略 Range 直接返回整段，这里补一次裁剪
  if (range && res.status === 200 && buf.length >= range.offset + range.length) {
    return buf.subarray(range.offset, range.offset + range.length);
  }
  return buf;
}

/** 取某个媒体播放列表的总时长（只读列表，不下分片）。 */
async function playlistDuration(get, url, retries) {
  const text = await retry(async () => (await get(url, { timeoutMs: 8000 })).text(), { retries });
  const parsed = parsePlaylist(text, url);
  if (parsed.type !== 'media') return 0;
  return parsed.duration || parsed.segments.length * parsed.targetDuration;
}

/**
 * 只读播放列表，不下分片。用于在界面上给用户列清晰度，并算出「大概多大」。
 * 体积是估算值：多码率用每档自己声明的 BANDWIDTH × 时长；
 * 单码率列表取第一个分片的真实大小按比例放大。
 */
async function probeHls(options) {
  const {
    url,
    fetchImpl = globalThis.fetch,
    referrer = '',
    credentials = 'include',
    headers = {},
    retries = 2,
    withSizes = true,
    maxVariantsToMeasure = 8,
  } = options || {};
  const get = makeFetcher({ fetchImpl, referrer, credentials, extraHeaders: headers, retries });
  const text = await retry(async () => (await get(url, { timeoutMs: 15000 })).text(), { retries });
  let info = parsePlaylist(text, url);
  const result = {
    url,
    type: info.type,
    isLive: info.isLive,
    duration: info.duration,
    segmentCount: info.segments.length,
    segmentDuration: info.targetDuration,
    hasDiscontinuity: info.hasDiscontinuity,
    encryption: info.encryption,
    renditions: info.renditions,
    variants: [],
    estimatedBytes: 0,
    container: '',
  };

  if (info.type === 'master') {
    const usable = info.variants.filter((v) => !v.iframe);
    result.variants = info.variants.map((v, i) => ({
      index: i,
      url: v.url,
      bandwidth: v.bandwidth || v.averageBandwidth,
      resolution: v.resolution,
      codecs: v.codecs,
      frameRate: v.frameRate,
      iframe: v.iframe,
      label: variantLabel(v, i),
      durationSec: 0,
      estimatedBytes: 0,
    }));

    // 逐档读一次列表拿时长，好把「大概多大」算出来。档位太多就只算前几档。
    if (withSizes && result.variants.length) {
      const todo = result.variants.filter((v) => !v.iframe).slice(0, maxVariantsToMeasure);
      await orderedPool(
        todo,
        async (v) => {
          try {
            v.durationSec = await playlistDuration(get, v.url, 1);
          } catch {
            v.durationSec = 0;
          }
          v.estimatedBytes = estimateBytes(v.durationSec, v.bandwidth);
          return v;
        },
        { concurrency: 4, windowSize: 4, onResult: () => {} }
      );
      const measured = result.variants.filter((v) => v.durationSec > 0);
      if (measured.length) {
        result.duration = measured[0].durationSec;
        result.isLive = false;
      }
    }

    const audioOnly =
      result.variants.length > 0 &&
      result.variants.every((v) => !v.resolution && /mp4a|aac|opus/i.test(v.codecs) && !/avc1|hvc1|hev1|av01|vp0?9/i.test(v.codecs));
    result.audioOnly = audioOnly;
    const best = result.variants.filter((v) => !v.iframe && v.estimatedBytes).sort((a, b) => b.estimatedBytes - a.estimatedBytes)[0];
    result.estimatedBytes = best ? best.estimatedBytes : 0;
  } else {
    result.audioOnly = false;
    result.segmentsAreFmp4 = !!info.map;
    if (withSizes && info.segments.length) {
      // 单码率列表没有声明码率，取第一个分片的真实大小按时间比例估算
      const first = info.segments[0];
      const segDur = first.duration || info.targetDuration || 0;
      try {
        const res = await get(first.url, { range: { offset: 0, length: 1 }, timeoutMs: 8000 });
        const total = totalLengthOf(res);
        try {
          if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
        } catch {
          /* 忽略 */
        }
        if (total > 0 && segDur > 0 && result.duration > 0) {
          result.estimatedBytes = Math.round((total / segDur) * result.duration);
          result.firstSegmentBytes = total;
        }
      } catch {
        /* 拿不到就算了，界面上只显示时长 */
      }
    }
  }
  return result;
}

/**
 * 下载一条 HLS 流。分片按顺序、并发抓取，边下边通过 onData 交给调用方。
 * @param {object} options
 * @param {string} options.url 播放列表地址（master 或 media 都行）
 * @param {Function} options.onData (Uint8Array, meta) => void|Promise 按顺序吐数据
 * @param {Function} [options.selectVariant] 拿到 variants 后决定用哪个
 */
async function downloadHls(options) {
  const {
    url,
    fetchImpl = globalThis.fetch,
    referrer = '',
    credentials = 'include',
    headers: extraHeaders = {},
    concurrency = 4,
    retries = 3,
    signal = null,
    selectVariant = null,
    onData,
    onProgress = null,
    cryptoImpl = globalThis.crypto,
    maxSegments = 200000,
    maxBytes = 0,
  } = options || {};

  if (typeof onData !== 'function') throw new Error('downloadHls 需要 onData 回调');
  const get = makeFetcher({ fetchImpl, referrer, credentials, extraHeaders, retries });

  let playlistUrl = url;
  let text = await retry(async () => (await get(playlistUrl)).text(), { retries });
  let info = parsePlaylist(text, playlistUrl);
  let chosenVariant = null;

  if (info.type === 'master') {
    const usable = info.variants.filter((v) => v.url && !v.iframe);
    if (!usable.length) throw new Error('主播放列表里没有可用的清晰度');
    chosenVariant = selectVariant ? await selectVariant(usable, info) : pickBestVariant(usable);
    if (!chosenVariant || !chosenVariant.url) throw new Error('没有选择清晰度');
    playlistUrl = chosenVariant.url;
    text = await retry(async () => (await get(playlistUrl)).text(), { retries });
    const inner = parsePlaylist(text, playlistUrl);
    if (inner.type === 'master') throw new Error('播放列表嵌套了多层 master，暂不支持');
    info = inner;
  }

  if (info.type !== 'media') throw new Error('这不是一个有效的 m3u8 播放列表');
  const segments = info.segments;
  if (!segments.length) throw new Error('播放列表里没有分片');

  if (segments.length > maxSegments) {
    throw new Error(`分片数量过多（${segments.length}），可能是直播流或异常列表，已停止`);
  }

  const unsupported = new Set();
  for (const seg of segments) {
    if (!seg.key) continue;
    if (seg.key.keyFormat && seg.key.keyFormat !== 'identity') {
      throw new Error(`该流使用 ${seg.key.keyFormat} 加密（DRM），浏览器无法解密`);
    }
    if (seg.key.method !== 'AES-128') unsupported.add(seg.key.method);
  }
  if (unsupported.size) {
    throw new Error(`暂不支持的加密方式：${[...unsupported].join(', ')}`);
  }

  const keyCache = new Map();
  async function getKey(key) {
    if (keyCache.has(key.uri)) return keyCache.get(key.uri);
    const p = retry(
      async () => {
        const res = await get(key.uri);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length !== 16) throw new Error(`密钥长度异常：${bytes.length} 字节`);
        return bytes;
      },
      { retries }
    );
    keyCache.set(key.uri, p);
    return p;
  }

  let received = 0;
  let done = 0;
  let aborted = false;

  const emit = async (bytes, meta) => {
    received += bytes.length;
    if (maxBytes && received > maxBytes) {
      aborted = true;
      throw new Error(`已超过设定的大小上限（${maxBytes} 字节）`);
    }
    await onData(bytes, meta);
  };

  if (info.map && info.map.url) {
    const bytes = await retry(async () => readBody(await get(info.map.url, { range: info.map.byteRange }), info.map.byteRange), { retries });
    await emit(bytes, { kind: 'init', index: -1, url: info.map.url, discontinuity: false });
  }

  try {
    await orderedPool(
      segments,
      async (seg) => {
        return retry(
          async () => {
            const res = await get(seg.url, { range: seg.byteRange, signal });
            let bytes = await readBody(res, seg.byteRange);
            if (seg.key && seg.key.method === 'AES-128') {
              const kb = await getKey(seg.key);
              const iv = seg.key.iv || sequenceToIv(seg.seq);
              bytes = await decryptAes128(bytes, kb, iv, cryptoImpl);
            }
            return bytes;
          },
          { retries }
        );
      },
      {
        concurrency,
        windowSize: concurrency + 2,
        onResult: async (bytes, idx) => {
          const seg = segments[idx];
          await emit(bytes, {
            kind: 'segment',
            index: idx,
            url: seg.url,
            discontinuity: seg.discontinuity,
          });
          done++;
          if (onProgress && (done % 3 === 0 || done === segments.length)) {
            await onProgress({
              done,
              total: segments.length,
              received,
              duration: info.duration,
              playlistUrl,
              isLive: info.isLive,
            });
          }
        },
      }
    );
  } catch (e) {
    if (aborted) throw e;
    throw new Error(`下载分片失败（已成功 ${done}/${segments.length}）：${e.message || e}`);
  }

  return {
    received,
    count: done,
    total: segments.length,
    duration: info.duration,
    isLive: info.isLive,
    hasDiscontinuity: info.hasDiscontinuity,
    hasMap: !!info.map,
    playlistUrl,
    variant: chosenVariant,
    encryption: info.encryption,
  };
}

// ===== 来自 extension/src/lib/ts2mp4.js（原样内联，勿手改；改请改源文件后重新构建）=====
// 把 MPEG-TS / ADTS-AAC / MP3 等流式容器重新封装成 MP4，让手机播放器能直接播。
// 只换容器不重编码，画质无损，速度取决于内存带宽。
// 不依赖浏览器 API，可在 Node 里直接测试。


const PKT = 188;
const VIDEO_STREAM_TYPES = new Set([0x1b, 0x24]); // H.264 / H.265
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11]); // MPEG1/2 音频、AAC(ADTS)、AAC(LATM)

/** 判断一段数据的容器类型。 */
function probeContainer(bytes, offset = 0) {
  const b = bytes;
  if (b.length - offset < 16) return 'unknown';

  // MPEG-TS：连续三个包同步字
  const scanEnd = Math.min(offset + PKT * 2, b.length - 2 * PKT);
  for (let i = offset; i < scanEnd; i++) {
    if (b[i] === 0x47 && b[i + PKT] === 0x47 && b[i + 2 * PKT] === 0x47) return 'ts';
  }
  // ID3 开头的文件很常见，先跳过标签
  if (b[offset] === 0x49 && b[offset + 1] === 0x44 && b[offset + 2] === 0x33) {
    const size = ((b[offset + 6] & 0x7f) << 21) | ((b[offset + 7] & 0x7f) << 14) | ((b[offset + 8] & 0x7f) << 7) | (b[offset + 9] & 0x7f);
    const off = offset + 10 + size;
    return off < b.length - 15 ? probeContainer(b, off) : 'unknown';
  }
  if (b[offset + 4] === 0x66 && b[offset + 5] === 0x74 && b[offset + 6] === 0x79 && b[offset + 7] === 0x70) return 'fmp4';
  if (b[offset] === 0xff && (b[offset + 1] & 0xf6) === 0xf0) return 'adts';
  if (b[offset] === 0xff && (b[offset + 1] & 0xe0) === 0xe0 && ((b[offset + 1] >> 1) & 0x03) !== 0) return 'mp3';
  return 'unknown';
}

// ---------------------------------------------------------------- 字节写入器

class Writer {
  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length || 64;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v) {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  u24(v) {
    this.ensure(3);
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  u32(v) {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  u64(v) {
    const n = BigInt(v);
    this.u32(Number((n >> 32n) & 0xffffffffn));
    this.u32(Number(n & 0xffffffffn));
  }
  ascii(s) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
  }
  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  zeros(n) {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
  }
  patchU32(off, v) {
    this.buf[off] = (v >>> 24) & 0xff;
    this.buf[off + 1] = (v >>> 16) & 0xff;
    this.buf[off + 2] = (v >>> 8) & 0xff;
    this.buf[off + 3] = v & 0xff;
  }
  patchU64(off, v) {
    const n = BigInt(v);
    this.patchU32(off, Number((n >> 32n) & 0xffffffffn));
    this.patchU32(off + 4, Number(n & 0xffffffffn));
  }
  out() {
    return this.buf.subarray(0, this.len);
  }
}

function beginBox(w, type) {
  w.u32(0);
  const off = w.len - 4;
  w.ascii(type);
  return off;
}

function endBox(w, off) {
  w.patchU32(off, w.len - off);
}

function fullBox(w, type, version = 0, flags = 0) {
  const off = beginBox(w, type);
  w.u8(version);
  w.u24(flags);
  return off;
}

const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function writeMatrix(w) {
  for (const v of UNITY_MATRIX) w.u32(v);
}

// ---------------------------------------------------------------- 位读取（SPS / slice header）

class BitReader {
  constructor(data, bitPos = 0) {
    this.d = data;
    this.p = bitPos;
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.d[this.p >> 3];
      if (byte === undefined) return v >>> 0;
      v = (v << 1) | ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v >>> 0;
  }
  ue() {
    let zeros = 0;
    while (this.p >> 3 < this.d.length && this.u(1) === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return ((1 << zeros) - 1 + this.u(zeros)) >>> 0;
  }
  se() {
    const k = this.ue();
    const v = Math.ceil(k / 2);
    return k % 2 === 0 ? -v : v;
  }
}

/** 从 SPS 里取宽高；失败返回 {width:0,height:0}。 */
function parseSpsDimensions(sps) {
  try {
    const r = new BitReader(sps, 8);
    const profileIdc = r.u(8);
    r.u(8);
    r.u(8);
    r.ue();
    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.u(1);
      r.ue();
      r.ue();
      r.u(1);
      if (r.u(1)) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (r.u(1)) {
            let last = 8;
            let next = 8;
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) {
              if (next !== 0) next = (last + r.se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue();
    r.u(1);
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1);
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (r.u(1)) {
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }
    const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    const width = widthMbs * 16 - (cropLeft + cropRight) * subWidthC;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * subHeightC;
    if (width > 0 && width < 16384 && height > 0 && height < 16384) return { width, height };
  } catch {
    /* 拿不到就算了，不影响主流程 */
  }
  return { width: 0, height: 0 };
}

// ---------------------------------------------------------------- TS 解复用

function findSyncOffset(data, from = 0) {
  const limit = Math.min(data.length - 2 * PKT, from + PKT * 8);
  for (let i = from; i < Math.max(limit, from + 1); i++) {
    if (i + 2 * PKT < data.length && data[i] === 0x47 && data[i + PKT] === 0x47 && data[i + 2 * PKT] === 0x47) return i;
  }
  for (let i = from; i < Math.max(limit, from + 1); i++) {
    if (i + PKT < data.length && data[i] === 0x47 && data[i + PKT] === 0x47) return i;
  }
  return -1;
}

function readPts(b, o) {
  const hi = (b[o] & 0x0e) >> 1;
  const mid = ((b[o + 1] << 8) | b[o + 2]) >> 1;
  const lo = ((b[o + 3] << 8) | b[o + 4]) >> 1;
  return hi * 0x40000000 + mid * 0x8000 + lo;
}

function* eachPacket(data, syncOffset) {
  let off = syncOffset;
  while (off + PKT <= data.length) {
    if (data[off] !== 0x47) {
      const re = findSyncOffset(data, off + 1);
      if (re < 0) return;
      off = re;
      continue;
    }
    const b1 = data[off + 1];
    const pusi = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | data[off + 2];
    const b3 = data[off + 3];
    const afc = (b3 >> 4) & 0x03;
    let p = off + 4;
    if (afc & 2) {
      if (p >= off + PKT) {
        off += PKT;
        continue;
      }
      p += 1 + data[p];
      if (p > off + PKT) {
        off += PKT;
        continue;
      }
    }
    if (afc !== 0 && afc !== 2) {
      yield { pid, pusi, payload: data.subarray(p, off + PKT) };
    }
    off += PKT;
  }
}

/** 收集 PSI 段（支持跨包）。 */
function pushPsi(payload, pusi, state) {
  let p = payload;
  if (pusi) {
    if (p.length < 1) return null;
    state.buf = new Uint8Array(0);
    p = p.subarray(1 + Math.min(p[0], p.length - 1));
  }
  const buf = state.buf.length ? concatUint8([state.buf, p]) : p;
  if (buf.length < 3) {
    state.buf = buf;
    return null;
  }
  const total = 3 + (((buf[1] & 0x0f) << 8) | buf[2]);
  if (buf.length < total) {
    state.buf = buf;
    return null;
  }
  state.buf = new Uint8Array(0);
  return buf.subarray(0, total);
}

function parsePat(section) {
  const pids = [];
  const end = section.length - 4;
  for (let i = 8; i + 4 <= end; i += 4) {
    const programNumber = (section[i] << 8) | section[i + 1];
    const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
    if (programNumber !== 0) pids.push(pid);
  }
  return pids;
}

function parsePmt(section) {
  const streams = [];
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
  let p = 12 + programInfoLength;
  const end = section.length - 4;
  while (p + 5 <= end) {
    const streamType = section[p];
    const pid = ((section[p + 1] & 0x1f) << 8) | section[p + 2];
    const esInfoLength = ((section[p + 3] & 0x0f) << 8) | section[p + 4];
    streams.push({ streamType, pid });
    p += 5 + esInfoLength;
  }
  return streams;
}

function findStreams(data, syncOffset) {
  const psiState = new Map();
  const pmtPids = new Set();
  const streams = [];

  for (const pk of eachPacket(data, syncOffset)) {
    const pid = pk.pid;
    if (pid === 0x1fff) continue;
    if (!psiState.has(pid)) psiState.set(pid, { buf: new Uint8Array(0) });
    const section = pushPsi(pk.payload, pk.pusi, psiState.get(pid));
    if (!section) continue;
    if (pid === 0 && section[0] === 0x00) {
      for (const p of parsePat(section)) pmtPids.add(p);
    } else if (pmtPids.has(pid) && section[0] === 0x02) {
      for (const s of parsePmt(section)) {
        if (!streams.some((x) => x.pid === s.pid)) streams.push(s);
      }
      if (streams.length) break;
    }
  }
  return { streams };
}

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];
const MP3_BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000, 0], 2: [22050, 24000, 16000, 0], 0: [11025, 12000, 8000, 0] };

// ---------------------------------------------------------------- ES 拆解

/** 按起始码切 NAL，去掉尾部填充零。返回的是原数组的视图，不复制。 */
function splitAnnexB(data) {
  const out = [];
  let i = 0;
  let start = -1;
  const push = (from, to) => {
    let e = to;
    while (e > from && data[e - 1] === 0) e--;
    if (e > from) out.push(data.subarray(from, e));
  };
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        if (start >= 0) push(start, i);
        i += 3;
        start = i;
        continue;
      }
      if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
        if (start >= 0) push(start, i);
        i += 4;
        start = i;
        continue;
      }
    }
    i++;
  }
  if (start >= 0 && start < data.length) push(start, data.length);
  return out;
}

const NAL_AUD = 9;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_SEI = 6;

function isVcl(type) {
  return type >= 1 && type <= 5;
}

/** 读 slice header 的第一个 ue(v)：0 表示这是新图像的第一片。 */
function firstMbInSlice(nal) {
  try {
    return new BitReader(nal, 8).ue();
  } catch {
    return 0;
  }
}

/**
 * 把 H.264 的 PES 单元拼成访问单元（一帧一个样本）。
 * 关键点：不能按 PES 边界切，因为一帧可能跨多个 PES；只有 first_mb_in_slice==0 才是新帧。
 * 返回的 nals 都是原 TS 缓冲区的视图，不额外复制。
 */
function buildAvcSamples(pesUnits) {
  const samples = [];
  let cur = null;
  let sps = null;
  let pps = null;

  const flush = () => {
    if (cur && cur.nals.length) samples.push(cur);
    cur = null;
  };
  const start = (pes) => {
    flush();
    cur = { nals: [], pts: pes.pts, dts: pes.dts };
  };

  for (const pes of pesUnits) {
    const data = pes.chunks.length === 1 ? pes.chunks[0] : concatUint8(pes.chunks);
    for (const nal of splitAnnexB(data)) {
      const type = nal[0] & 0x1f;
      if (type === NAL_SPS) {
        if (!sps) sps = nal;
        if (cur && cur.nals.some((n) => isVcl(n[0] & 0x1f))) start(pes);
        else if (!cur) start(pes);
      } else if (type === NAL_PPS) {
        if (!pps) pps = nal;
        if (!cur) start(pes);
      } else if (type === NAL_AUD) {
        start(pes);
      } else if (isVcl(type)) {
        if (!cur) start(pes);
        else if (firstMbInSlice(nal) === 0 && cur.nals.some((n) => isVcl(n[0] & 0x1f))) start(pes);
      } else if (type === NAL_SEI) {
        if (!cur) start(pes);
      } else if (!cur) {
        start(pes);
      }
      if (!cur) start(pes);
      cur.nals.push(nal);
    }
  }
  flush();
  return { samples, sps, pps };
}

function buildAvcC(sps, pps) {
  const w = new Writer(64);
  w.u8(1);
  w.u8(sps[1]);
  w.u8(sps[2]);
  w.u8(sps[3]);
  w.u8(0xff);
  w.u8(0xe1);
  w.u16(sps.length);
  w.bytes(sps);
  w.u8(1);
  w.u16(pps.length);
  w.bytes(pps);
  return w.out();
}

/** 解析 ADTS 帧序列（纯 .aac 也走这里）。 */
function parseAdts(data) {
  const frames = [];
  let sampleRate = 0;
  let channels = 0;
  let profile = 1;
  let pos = 0;
  let skipped = 0;
  while (pos + 7 <= data.length) {
    if (data[pos] !== 0xff || (data[pos + 1] & 0xf6) !== 0xf0) {
      pos++;
      skipped++;
      continue;
    }
    const p = (data[pos + 2] >> 6) & 0x03;
    const sfIndex = (data[pos + 2] >> 2) & 0x0f;
    const chan = ((data[pos + 2] & 1) << 2) | ((data[pos + 3] >> 6) & 0x03);
    const frameLength = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | ((data[pos + 5] >> 5) & 0x07);
    const headerLen = data[pos + 1] & 1 ? 7 : 9;
    if (frameLength <= headerLen || pos + frameLength > data.length) {
      pos++;
      skipped++;
      continue;
    }
    if (!sampleRate && ADTS_SAMPLE_RATES[sfIndex]) {
      sampleRate = ADTS_SAMPLE_RATES[sfIndex];
      channels = chan;
      profile = p;
    }
    frames.push(data.subarray(pos + headerLen, pos + frameLength));
    pos += frameLength;
  }
  return { frames, sampleRate: sampleRate || 44100, channels: channels || 2, profile, skipped };
}

/** 解析 MPEG 音频帧序列（mp3）。 */
function parseMp3(data) {
  const frames = [];
  let sampleRate = 0;
  let channels = 0;
  let samplesPerFrame = 1152;
  let version = 3;
  let pos = 0;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff || (data[pos + 1] & 0xe0) !== 0xe0) {
      pos++;
      continue;
    }
    const v = (data[pos + 1] >> 3) & 0x03;
    const layer = (data[pos + 1] >> 1) & 0x03;
    const bitrateIndex = (data[pos + 2] >> 4) & 0x0f;
    const srIndex = (data[pos + 2] >> 2) & 0x03;
    const padding = (data[pos + 2] >> 1) & 0x01;
    const chanMode = (data[pos + 3] >> 6) & 0x03;
    const sr = (MP3_SAMPLE_RATES[v] || MP3_SAMPLE_RATES[3])[srIndex];
    const bitrate = (v === 3 ? MP3_BITRATE_V1_L3 : MP3_BITRATE_V2_L3)[bitrateIndex];
    if (layer !== 1 || !sr || !bitrate) {
      pos++;
      continue;
    }
    const spf = v === 3 ? 1152 : 576;
    const frameLen = Math.floor((spf / 8) * bitrate * 1000 / sr) + padding;
    if (frameLen <= 4 || pos + frameLen > data.length) {
      pos++;
      continue;
    }
    if (!sampleRate) {
      sampleRate = sr;
      channels = chanMode === 3 ? 1 : 2;
      samplesPerFrame = spf;
      version = v;
    }
    frames.push(data.subarray(pos, pos + frameLen));
    pos += frameLen;
  }
  return { frames, sampleRate: sampleRate || 44100, channels: channels || 2, samplesPerFrame, version };
}

// ---------------------------------------------------------------- MP4 盒子

function DESC(tag, payload) {
  const w = new Writer(payload.length + 6);
  w.u8(tag);
  if (payload.length >= 128) {
    const bytes = [];
    let n = payload.length;
    while (n > 0) {
      bytes.unshift(n & 0x7f);
      n >>= 7;
    }
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
    for (const b of bytes) w.u8(b);
  } else {
    w.u8(payload.length);
  }
  w.bytes(payload);
  return w.out();
}

function buildEsds(objectTypeIndication, asc, bitrate) {
  const dcd = new Writer(24);
  dcd.u8(objectTypeIndication);
  dcd.u8(0x15);
  dcd.u24(0);
  dcd.u32(bitrate);
  dcd.u32(bitrate);
  if (asc) dcd.bytes(DESC(0x05, asc));
  const esPayload = new Writer(24);
  esPayload.u16(0);
  esPayload.u8(0);
  esPayload.bytes(DESC(0x04, dcd.out()));
  esPayload.bytes(DESC(0x06, new Uint8Array([0x02])));
  const w = new Writer(64);
  w.u8(0);
  w.u24(0);
  w.bytes(DESC(0x03, esPayload.out()));
  return w.out();
}

function writeStts(w, deltas) {
  const runs = [];
  for (const d of deltas) {
    const last = runs[runs.length - 1];
    if (last && last.delta === d) last.count++;
    else runs.push({ count: 1, delta: d });
  }
  const off = fullBox(w, 'stts');
  w.u32(runs.length);
  for (const r of runs) {
    w.u32(r.count);
    w.u32(r.delta);
  }
  endBox(w, off);
}

function offMinMax(arr) {
  let min = arr.length ? arr[0] : 0;
  let max = min;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

function writeCtts(w, offsets) {
  const { min, max } = offMinMax(offsets);
  if (min === 0 && max === 0) return;
  const shift = Math.min(0, min);
  const runs = [];
  for (const o of offsets) {
    const v = o - shift;
    const last = runs[runs.length - 1];
    if (last && last.offset === v) last.count++;
    else runs.push({ count: 1, offset: v });
  }
  const off = fullBox(w, 'ctts', 0);
  w.u32(runs.length);
  for (const r of runs) {
    w.u32(r.count);
    w.u32(r.offset);
  }
  endBox(w, off);
}

function writeStsz(w, sizes) {
  const off = fullBox(w, 'stsz');
  w.u32(0);
  w.u32(sizes.length);
  for (const s of sizes) w.u32(s);
  endBox(w, off);
}

/** 一个样本一个 chunk，stsc 只有一条记录。返回 stco 数据区在 Writer 里的偏移，稍后回填。 */
function writeStblTables(w, { sizes, deltas, ctsOffsets, syncIndices, chunkOffsets }) {
  const off = fullBox(w, 'stts');
  {
    const runs = [];
    for (const d of deltas) {
      const last = runs[runs.length - 1];
      if (last && last.delta === d) last.count++;
      else runs.push({ count: 1, delta: d });
    }
    w.u32(runs.length);
    for (const r of runs) {
      w.u32(r.count);
      w.u32(r.delta);
    }
  }
  endBox(w, off);

  if (ctsOffsets) writeCtts(w, ctsOffsets);

  if (syncIndices && syncIndices.length && syncIndices.length < sizes.length) {
    const o = fullBox(w, 'stss');
    w.u32(syncIndices.length);
    for (const i of syncIndices) w.u32(i + 1);
    endBox(w, o);
  }

  const stscOff = fullBox(w, 'stsc');
  w.u32(1);
  w.u32(1);
  w.u32(1);
  w.u32(1);
  endBox(w, stscOff);

  writeStsz(w, sizes);

  let useCo64 = false;
  for (const o of chunkOffsets) {
    if (o > 0xffffffff) {
      useCo64 = true;
      break;
    }
  }
  const stcoOff = fullBox(w, useCo64 ? 'co64' : 'stco');
  w.u32(chunkOffsets.length);
  const entriesOff = w.len;
  for (const o of chunkOffsets) {
    if (useCo64) w.u64(o);
    else w.u32(o);
  }
  endBox(w, stcoOff);
  return { entriesOff, useCo64 };
}

function writeStsdVideo(w, { avcC, width, height }) {
  const off = fullBox(w, 'stsd');
  w.u32(1);
  const entryOff = beginBox(w, 'avc1');
  w.zeros(6);
  w.u16(1);
  w.u16(0);
  w.u16(0);
  w.u32(0);
  w.u32(0);
  w.u32(0);
  w.u16(width);
  w.u16(height);
  w.u32(0x00480000);
  w.u32(0x00480000);
  w.u32(0);
  w.u16(1);
  w.zeros(32);
  w.u16(0x0018);
  w.u16(0xffff);
  const avcCOff = beginBox(w, 'avcC');
  w.bytes(avcC);
  endBox(w, avcCOff);
  endBox(w, entryOff);
  endBox(w, off);
}

function writeStsdAudio(w, track) {
  const off = fullBox(w, 'stsd');
  w.u32(1);
  const entryOff = beginBox(w, 'mp4a');
  w.zeros(6);
  w.u16(1);
  w.u16(0);
  w.u16(0);
  w.u32(0);
  w.u16(track.channels);
  w.u16(16);
  w.u16(0);
  w.u16(0);
  w.u32(track.sampleRate << 16);
  const esdsOff = beginBox(w, 'esds');
  w.bytes(track.esds);
  endBox(w, esdsOff);
  endBox(w, entryOff);
  endBox(w, off);
}

function writeTrack(w, track, { trackId, movieTimescale, fixups }) {
  const trakOff = beginBox(w, 'trak');

  const tkhdOff = fullBox(w, 'tkhd', 0, 0x000007);
  w.u32(0);
  w.u32(0);
  w.u32(trackId);
  w.u32(0);
  w.u32(Math.round((track.duration / track.timescale) * movieTimescale));
  w.u32(0);
  w.u32(0);
  w.u16(0);
  w.u16(0);
  w.u16(track.kind === 'audio' ? 0x0100 : 0);
  w.u16(0);
  writeMatrix(w);
  w.u32(track.kind === 'video' ? track.width * 65536 : 0);
  w.u32(track.kind === 'video' ? track.height * 65536 : 0);
  endBox(w, tkhdOff);

  const mdiaOff = beginBox(w, 'mdia');
  const mdhdOff = fullBox(w, 'mdhd');
  w.u32(0);
  w.u32(0);
  w.u32(track.timescale);
  w.u32(track.duration);
  w.u16(0x55c4);
  w.u16(0);
  endBox(w, mdhdOff);

  const hdlrOff = fullBox(w, 'hdlr');
  w.u32(0);
  w.ascii(track.kind === 'video' ? 'vide' : 'soun');
  w.u32(0);
  w.u32(0);
  w.u32(0);
  w.bytes(new TextEncoder().encode(track.kind === 'video' ? 'VideoHandler' : 'SoundHandler'));
  w.u8(0);
  endBox(w, hdlrOff);

  const minfOff = beginBox(w, 'minf');
  if (track.kind === 'video') {
    const vmhdOff = fullBox(w, 'vmhd', 0, 1);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    endBox(w, vmhdOff);
  } else {
    const smhdOff = fullBox(w, 'smhd');
    w.u16(0);
    w.u16(0);
    endBox(w, smhdOff);
  }
  const dinfOff = beginBox(w, 'dinf');
  const drefOff = fullBox(w, 'dref');
  w.u32(1);
  const urlOff = fullBox(w, 'url ', 0, 1);
  endBox(w, urlOff);
  endBox(w, drefOff);
  endBox(w, dinfOff);

  const stblOff = beginBox(w, 'stbl');
  if (track.kind === 'video') writeStsdVideo(w, track);
  else writeStsdAudio(w, track);
  const info = writeStblTables(w, {
    sizes: track.sizes,
    deltas: track.deltas,
    ctsOffsets: track.ctsOffsets,
    syncIndices: track.syncIndices,
    chunkOffsets: track.chunkOffsets,
  });
  endBox(w, stblOff);
  endBox(w, minfOff);
  endBox(w, mdiaOff);
  endBox(w, trakOff);

  fixups.push({ track, entriesOff: info.entriesOff, useCo64: info.useCo64 });
}

// ---------------------------------------------------------------- 样本模型

function avcSampleSize(sample) {
  let size = 0;
  for (const nal of sample.nals) size += 4 + nal.length;
  return size;
}

function writeAvcSample(out, pos, sample) {
  let p = pos;
  for (const nal of sample.nals) {
    const n = nal.length;
    out[p] = (n >>> 24) & 0xff;
    out[p + 1] = (n >>> 16) & 0xff;
    out[p + 2] = (n >>> 8) & 0xff;
    out[p + 3] = n & 0xff;
    p += 4;
    out.set(nal, p);
    p += n;
  }
  return p;
}

/** 统一成 {kind, sizes, deltas, ctsOffsets, syncIndices, samples:[{nals}|{data}]} */
function finalizeTrack(t) {
  const sizes = [];
  const kept = [];
  const deltas = [];
  const ctsOffsets = t.ctsOffsets ? [] : null;
  const syncIndices = [];
  let allSync = true;

  for (let i = 0; i < t.samples.length; i++) {
    const s = t.samples[i];
    const size = s.nals ? avcSampleSize(s) : s.data.length;
    if (!size) continue;
    kept.push(s);
    sizes.push(size);
    deltas.push(t.deltas[i]);
    if (ctsOffsets) ctsOffsets.push(t.ctsOffsets[i]);
    if (s.nals) {
      let isSync = false;
      for (const nal of s.nals) {
        if ((nal[0] & 0x1f) === 5) isSync = true;
      }
      if (isSync) syncIndices.push(kept.length - 1);
      else allSync = false;
    }
  }

  const duration = deltas.reduce((a, b) => a + b, 0);
  return {
    ...t,
    samples: kept,
    sizes,
    deltas,
    ctsOffsets,
    syncIndices: !ctsOffsets ? null : allSync ? null : syncIndices.length ? syncIndices : [0],
    duration: t.fixedDuration != null ? t.fixedDuration : duration,
  };
}

// ---------------------------------------------------------------- 对外入口

/**
 * 把 TS / ADTS / MP3 字节流重新封装成 MP4。
 * @returns {Promise<{data:Uint8Array, ext:string, mime:string, videoCodec:string, audioCodec:string,
 *                    width:number, height:number, duration:number, warnings:string[]}>}
 */
async function remuxToMp4(data, opts = {}) {
  const warnings = [];
  const container = probeContainer(data);
  let tracks;

  if (container === 'ts') {
    tracks = await demuxTsToTracks(data, warnings);
  } else if (container === 'adts') {
    tracks = [buildAdtsTrack(data, warnings)].filter(Boolean);
  } else if (container === 'mp3') {
    tracks = [buildMp3TrackFromEs(data, warnings)].filter(Boolean);
  } else if (container === 'fmp4') {
    return {
      data,
      ext: '.mp4',
      mime: 'video/mp4',
      videoCodec: '',
      audioCodec: '',
      width: 0,
      height: 0,
      duration: 0,
      warnings: ['输入本身已是 fMP4，已直接拼接'],
    };
  } else {
    throw new Error('无法识别的容器：' + container);
  }

  const list = tracks.filter((t) => t && t.samples.length).map(finalizeTrack);
  if (!list.length) throw new Error('没有解析出任何可用的音视频样本');

  // mdat 排布：先视频后音频。chunkOffsets 必须是“轨内相对偏移”，
  // 跨轨的累加放在回填那一步统一做，否则第二轨会被多加一次前面所有轨的大小。
  for (const t of list) {
    t.chunkOffsets = new Array(t.samples.length);
    let local = 0;
    for (let i = 0; i < t.samples.length; i++) {
      t.chunkOffsets[i] = local;
      local += t.sizes[i];
    }
    t.totalBytes = local;
  }
  let mdatPayloadLength = 0;
  for (const t of list) mdatPayloadLength += t.totalBytes;

  const ftyp = new Writer(32);
  {
    const off = beginBox(ftyp, 'ftyp');
    ftyp.ascii('isom');
    ftyp.u32(512);
    ftyp.ascii('isom');
    ftyp.ascii('iso2');
    if (list.some((t) => t.kind === 'video')) ftyp.ascii('avc1');
    ftyp.ascii('mp41');
    endBox(ftyp, off);
  }
  const ftypBytes = ftyp.out();

  const movieTimescale = 1000;
  let maxDurationMs = 0;
  for (const t of list) maxDurationMs = Math.max(maxDurationMs, (t.duration / t.timescale) * 1000);

  const moov = new Writer(4096);
  const fixups = [];
  {
    const moovOff = beginBox(moov, 'moov');
    const mvhdOff = fullBox(moov, 'mvhd');
    moov.u32(0);
    moov.u32(0);
    moov.u32(movieTimescale);
    moov.u32(Math.round(maxDurationMs));
    moov.u32(0x00010000);
    moov.u16(0x0100);
    moov.u16(0);
    moov.u32(0);
    moov.u32(0);
    writeMatrix(moov);
    moov.zeros(24);
    moov.u32(list.length + 1);
    endBox(moov, mvhdOff);

    let trackId = 1;
    for (const t of list) {
      writeTrack(moov, t, { trackId: trackId++, movieTimescale, fixups });
    }
    endBox(moov, moovOff);
  }
  const moovLen = moov.len;
  const mdatDataOffset = ftypBytes.length + moovLen + 8;

  // 回填 stco/co64
  let base = mdatDataOffset;
  for (const t of list) {
    const fix = fixups.find((f) => f.track === t);
    if (fix) {
      for (let i = 0; i < t.chunkOffsets.length; i++) {
        const abs = base + t.chunkOffsets[i];
        if (fix.useCo64) moov.patchU64(fix.entriesOff + i * 8, abs);
        else moov.patchU32(fix.entriesOff + i * 4, abs);
      }
    }
    base += t.totalBytes;
  }

  const total = mdatDataOffset + mdatPayloadLength;
  const out = new Uint8Array(total);
  out.set(ftypBytes, 0);
  out.set(moov.out(), ftypBytes.length);
  const mdatOff = ftypBytes.length + moovLen;
  const mdatSize = mdatPayloadLength + 8;
  out[mdatOff] = (mdatSize >>> 24) & 0xff;
  out[mdatOff + 1] = (mdatSize >>> 16) & 0xff;
  out[mdatOff + 2] = (mdatSize >>> 8) & 0xff;
  out[mdatOff + 3] = mdatSize & 0xff;
  out[mdatOff + 4] = 0x6d;
  out[mdatOff + 5] = 0x64;
  out[mdatOff + 6] = 0x61;
  out[mdatOff + 7] = 0x74;

  let writePos = mdatDataOffset;
  for (const t of list) {
    for (const s of t.samples) {
      if (s.nals) writePos = writeAvcSample(out, writePos, s);
      else {
        out.set(s.data, writePos);
        writePos += s.data.length;
      }
    }
  }

  const video = list.find((t) => t.kind === 'video');
  const audio = list.find((t) => t.kind === 'audio');
  return {
    data: out,
    ext: video ? '.mp4' : '.m4a',
    mime: video ? 'video/mp4' : 'audio/mp4',
    videoCodec: video ? video.codec : '',
    audioCodec: audio ? audio.codec : '',
    width: video ? video.width : 0,
    height: video ? video.height : 0,
    duration: Math.max(...list.map((t) => t.duration / t.timescale)),
    warnings,
  };
}

async function demuxTsToTracks(data, warnings) {
  const syncOffset = findSyncOffset(data);
  if (syncOffset < 0) throw new Error('找不到 TS 同步头');
  const { streams } = findStreams(data, syncOffset);
  if (!streams.length) throw new Error('TS 里没有找到节目信息表（PMT）');

  const videoStream = streams.find((s) => VIDEO_STREAM_TYPES.has(s.streamType));
  const audioStream = streams.find((s) => AUDIO_STREAM_TYPES.has(s.streamType));
  if (!videoStream && !audioStream) throw new Error('TS 里没有找到可用的音视频流');

  const esPids = new Set();
  if (videoStream) esPids.add(videoStream.pid);
  if (audioStream) esPids.add(audioStream.pid);

  const pesMap = new Map();
  for (const pid of esPids) pesMap.set(pid, []);
  const pending = new Map();

  const flush = (pid) => {
    const p = pending.get(pid);
    pending.delete(pid);
    if (p && p.chunks.length) pesMap.get(pid).push(p);
  };

  let count = 0;
  for (const pk of eachPacket(data, syncOffset)) {
    const pid = pk.pid;
    if (!esPids.has(pid)) continue;
    if ((count++ & 16383) === 0) {
      // 让出主线程，避免手机上长时间无响应
      await new Promise((r) => setTimeout(r, 0));
    }
    if (pk.pusi) {
      flush(pid);
      const payload = pk.payload;
      let pts = null;
      let dts = null;
      let startAt = 0;
      if (payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const flags2 = payload[7];
        const hdrLen = payload[8];
        if (flags2 & 0x80) {
          pts = readPts(payload, 9);
          dts = flags2 & 0x40 ? readPts(payload, 14) : pts;
        }
        startAt = Math.min(9 + hdrLen, payload.length);
      }
      pending.set(pid, { pts, dts, chunks: [payload.subarray(startAt)] });
    } else if (pending.has(pid)) {
      pending.get(pid).chunks.push(pk.payload);
    }
  }
  for (const pid of esPids) flush(pid);

  const tracks = [];

  if (videoStream) {
    const pesUnits = pesMap.get(videoStream.pid) || [];
    if (videoStream.streamType === 0x24) {
      warnings.push('检测到 H.265/HEVC 视频轨，暂不支持转封装，已跳过视频轨');
    } else {
      const { samples, sps, pps } = buildAvcSamples(pesUnits);
      if (samples.length && sps && pps) {
        const track = buildVideoTrack(samples, sps, pps, warnings);
        if (track) tracks.push(track);
      } else if (samples.length) {
        warnings.push('没找到 SPS/PPS，无法生成 avcC，已跳过视频轨');
      }
    }
  }

  if (audioStream) {
    const pesUnits = pesMap.get(audioStream.pid) || [];
    let es;
    if (pesUnits.length === 1) es = pesUnits[0].chunks[0];
    else {
      const chunks = [];
      for (const p of pesUnits) for (const c of p.chunks) chunks.push(c);
      es = concatUint8(chunks);
    }
    if (audioStream.streamType === 0x0f) {
      const { frames, sampleRate, channels, profile } = parseAdts(es);
      if (frames.length) tracks.push(buildAacTrack(frames, sampleRate, channels, profile));
      else warnings.push('音频轨没有解出 AAC 帧');
    } else if (audioStream.streamType === 0x03 || audioStream.streamType === 0x04) {
      const { frames, sampleRate, channels, samplesPerFrame, version } = parseMp3(es);
      if (frames.length) tracks.push(buildMp3Track(frames, sampleRate, channels, samplesPerFrame, version));
      else warnings.push('音频轨没有解出 MP3 帧');
    } else {
      warnings.push(`不支持的音频流类型 0x${audioStream.streamType.toString(16)}`);
    }
  }

  return tracks;
}

function buildVideoTrack(samples, sps, pps, warnings) {
  const { width, height } = parseSpsDimensions(sps);
  if (!width) warnings.push('未能从 SPS 解析出分辨率，tkhd 里按 0 写入（一般不影响播放）');

  const dtsList = [];
  const ptsList = [];
  let fallback = 3000;

  for (const s of samples) {
    let dts = s.dts != null ? s.dts : s.pts != null ? s.pts : null;
    let pts = s.pts != null ? s.pts : dts;
    if (dts == null) {
      dts = dtsList.length ? dtsList[dtsList.length - 1] + fallback : 0;
      pts = dts;
    }
    if (dtsList.length) {
      const prev = dtsList[dtsList.length - 1];
      let delta = dts - prev;
      // 时间戳回绕或断点会造出离谱的间隔，按上一帧的间隔兜底
      if (delta <= 0 || delta > 900000) {
        const prevDelta = dtsList.length > 1 ? dtsList[dtsList.length - 1] - dtsList[dtsList.length - 2] : fallback;
        delta = prevDelta > 0 && prevDelta <= 900000 ? prevDelta : fallback;
        dts = prev + delta;
      }
      fallback = delta;
    }
    if (pts < dts) pts = dts;
    dtsList.push(dts);
    ptsList.push(pts);
  }

  // 先整体平移到 0，再算相邻间隔。两件事必须在两个循环里做，
  // 否则 dtsList[i+1] 还没平移、dtsList[i] 已经平移，每帧间隔会平白多出一个起始 PTS。
  const t0 = dtsList[0];
  for (let i = 0; i < dtsList.length; i++) {
    dtsList[i] -= t0;
    ptsList[i] -= t0;
  }
  const deltas = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    deltas[i] = i + 1 < samples.length ? dtsList[i + 1] - dtsList[i] : i > 0 ? dtsList[i] - dtsList[i - 1] : fallback;
  }
  const ctsOffsets = new Array(samples.length);
  let minCts = 0;
  for (let i = 0; i < samples.length; i++) {
    ctsOffsets[i] = ptsList[i] - dtsList[i];
    if (ctsOffsets[i] < minCts) minCts = ctsOffsets[i];
  }
  if (minCts < 0) for (let i = 0; i < ctsOffsets.length; i++) ctsOffsets[i] -= minCts;

  return {
    kind: 'video',
    codec: 'avc1',
    timescale: 90000,
    width,
    height,
    avcC: buildAvcC(sps, pps),
    samples: samples.map((s) => ({ nals: s.nals })),
    deltas,
    ctsOffsets,
  };
}

function buildAacTrack(frames, sampleRate, channels, profile) {
  const aot = Math.min(Math.max(profile + 1, 1), 4);
  const sfIndex = Math.max(0, ADTS_SAMPLE_RATES.indexOf(sampleRate));
  const asc = new Uint8Array(2);
  asc[0] = ((aot & 0x1f) << 3) | ((sfIndex >> 1) & 0x07);
  asc[1] = ((sfIndex & 1) << 7) | ((channels & 0x0f) << 3);
  return {
    kind: 'audio',
    codec: 'aac',
    timescale: sampleRate,
    channels,
    sampleRate,
    esds: buildEsds(0x40, asc, 128000),
    samples: frames.map((f) => ({ data: f })),
    deltas: new Array(frames.length).fill(1024),
    ctsOffsets: null,
    fixedDuration: frames.length * 1024,
  };
}

function buildMp3Track(frames, sampleRate, channels, samplesPerFrame, version) {
  return {
    kind: 'audio',
    codec: 'mp3',
    timescale: sampleRate,
    channels,
    sampleRate,
    esds: buildEsds(version === 3 ? 0x6b : 0x69, null, 128000),
    samples: frames.map((f) => ({ data: f })),
    deltas: new Array(frames.length).fill(samplesPerFrame),
    ctsOffsets: null,
    fixedDuration: frames.length * samplesPerFrame,
  };
}

function buildAdtsTrack(data, warnings) {
  const { frames, sampleRate, channels, profile, skipped } = parseAdts(data);
  if (!frames.length) {
    warnings.push('没有解出 AAC 帧');
    return null;
  }
  if (skipped > frames.length) warnings.push('ADTS 流里有较多无法识别的字节，已跳过');
  return buildAacTrack(frames, sampleRate, channels, profile);
}

function buildMp3TrackFromEs(data, warnings) {
  const { frames, sampleRate, channels, samplesPerFrame, version } = parseMp3(data);
  if (!frames.length) {
    warnings.push('没有解出 MP3 帧');
    return null;
  }
  return buildMp3Track(frames, sampleRate, channels, samplesPerFrame, version);
}


// ===== 用户脚本外壳 =====
// ============================================================================
// 用户脚本外壳：GM 适配层 + 嗅探 + 下载编排
//
// 界面（ui.js + panel.css）和算法（lib/*.js）都由 tools/build-userscript.mjs
// 从扩展源码原样内联进来，这里只写用户脚本特有的部分：
//   - GM_xmlhttpRequest / GM_download 适配
//   - 主世界钩子的安装（unsafeWindow）
//   - 列表维护与下载编排（不需要额外的抓取页，GM 请求本身就跨域）
// ============================================================================

const IS_TOP = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------- 设置

const SETTINGS_KEY = 'mg-settings';
const DEFAULT_SETTINGS = { remux: true, concurrency: 4, remuxLimitMB: 400 };

function loadSettings() {
  try {
    const raw = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS_KEY, '') : localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(next) {
  const text = JSON.stringify(next);
  try {
    if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, text);
    else localStorage.setItem(SETTINGS_KEY, text);
  } catch {
    /* 忽略 */
  }
}

let settings = loadSettings();

// ---------------------------------------------------------------- GM 适配层

/** 用 GM_xmlhttpRequest 取数据。它是用户脚本能跨域抓分片的关键。 */
function gmRequest(url, { method = 'GET', headers = {}, timeout = 120000, responseType = 'arraybuffer' } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('用户脚本管理器没有提供 GM_xmlhttpRequest'));
      return;
    }
    GM_xmlhttpRequest({
      method,
      url,
      headers,
      timeout,
      responseType,
      anonymous: false, // 带上目标站点的 Cookie
      onload: (r) => resolve(r),
      onerror: () => reject(new Error('网络请求失败：' + url)),
      ontimeout: () => reject(new Error('网络请求超时：' + url)),
      onabort: () => reject(new Error('请求已取消')),
    });
  });
}

/** 解析 GM_xmlhttpRequest 返回的响应头字符串，做成 fetch 那样的 get()。 */
function headersFromRaw(raw) {
  const map = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { get: (name) => map.get(String(name).toLowerCase()) || null };
}

/**
 * 伪装成 fetch 的样子，好让 hls.js 里已经测过的下载逻辑直接复用。
 * 统一按 arraybuffer 取，需要文本时用 TextDecoder 解，避免发两次请求。
 */
async function gmFetch(url, init = {}) {
  const r = await gmRequest(url, { method: init.method || 'GET', headers: { ...(init.headers || {}) } });
  const buf = r.response instanceof ArrayBuffer ? new Uint8Array(r.response) : new Uint8Array(0);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText || '',
    url: r.finalUrl || url,
    headers: headersFromRaw(r.responseHeaders),
    text: async () => new TextDecoder('utf-8').decode(buf),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/** 保存成文件。blob + <a download> 在安卓上会落到「下载」目录。 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* 忽略 */
    }
  }, 120000);
  return filename;
}

/** 直链优先走 GM_download（能指定文件名，且不用把整个文件读进内存）。 */
function gmDownload(url, name) {
  return new Promise((resolve, reject) => {
    if (typeof GM_download !== 'function') {
      reject(new Error('没有 GM_download'));
      return;
    }
    GM_download({
      url,
      name,
      saveAs: false,
      onload: () => resolve(name),
      onerror: (e) => reject(new Error((e && (e.error || e.details)) || '下载失败')),
      ontimeout: () => reject(new Error('下载超时')),
    });
  });
}

// ---------------------------------------------------------------- 列表

/** url -> item */
const items = new Map();
const jobs = [];

function itemId(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'cmft', 'dash', 'vtt', 'key']);
const KNOWN_EXT = /^(mp3|mp4|m4a|m4b|aac|flac|wav|ogg|oga|opus|weba|webm|mkv|mov|avi|flv|m3u8|m3u|mpd|jpg|jpeg|jfif|png|gif|webp|avif|bmp|svg|ico|heic|heif|tif|tiff)$/;

function pageTitle() {
  try {
    return document.title || '';
  } catch {
    return '';
  }
}

function nameForItem(url, contentType, contentDisposition) {
  let name = guessFilename({ url, contentType, contentDisposition });
  if (pageTitle() && isGenericName(name)) {
    const ext = name.slice(name.lastIndexOf('.'));
    const taken = [...items.values()].map((v) => v.filename);
    const candidate = composeNameFromTitle(pageTitle(), ext, url, taken);
    if (candidate) name = candidate;
  }
  return name;
}

let segmentCount = 0;

function addHit(raw) {
  const url = raw.url;
  if (!url || !/^https?:/i.test(url)) return false;

  const ext = (() => {
    try {
      const m = /\.([a-zA-Z0-9]{1,5})$/.exec(new URL(url).pathname);
      return m ? m[1].toLowerCase() : '';
    } catch {
      return '';
    }
  })();

  const classified = classify({ url, contentType: raw.contentType || '', contentDisposition: raw.contentDisposition || '' });

  // 分片不单独入列，只统计数量，免得列表被几百个 .ts 淹没
  if (SEGMENT_EXT.has(ext) && classified.kind !== 'hls') {
    segmentCount++;
    return false;
  }
  if (!isMediaKind(classified.kind) && !isImageKind(classified.kind)) {
    if (!KNOWN_EXT.test(ext)) return false;
  }

  const id = itemId(url);
  const prev = items.get(id);
  if (prev) {
    // 同一条资源会被多次上报（fetch 钩子、资源时间线、DOM 扫描），
    // 后到的信息往往更全（体积、Content-Type），要合并进去而不是直接丢掉。
    let changed = false;
    const size = Number(raw.size) || 0;
    if (!prev.size && size > 0) {
      prev.size = size;
      changed = true;
    }
    if (!prev.contentType && raw.contentType) {
      prev.contentType = raw.contentType;
      changed = true;
    }
    if ((prev.kind === 'other' || !prev.kind) && classified.kind !== 'unknown' && classified.kind !== 'other') {
      prev.kind = classified.kind;
      changed = true;
    }
    if (changed && prev.kind === 'image' && prev.size > 0 && prev.size < TINY_IMAGE_BYTES) prev.suspect = true;
    return changed;
  }

  const item = {
    id,
    url,
    kind: classified.kind,
    ext: classified.ext || '',
    contentType: raw.contentType || '',
    size: Number(raw.size) || 0,
    filename: nameForItem(url, raw.contentType, raw.contentDisposition),
    host: hostOf(url),
    title: pageTitle(),
    via: raw.via || '',
  };
  // 几百字节的图片基本是图标或埋点像素，默认折叠
  if (item.kind === 'image' && item.size > 0 && item.size < TINY_IMAGE_BYTES) item.suspect = true;
  items.set(id, item);
  return true;
}

// ---------------------------------------------------------------- 界面

let ui = null;

function ensureUi() {
  if (!IS_TOP || ui) return;
  try {
    const host = document.createElement('div');
    host.id = 'mg-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    (document.documentElement || document.body).appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    ui = window.MGUI.mount(shadow, {
      onDownload: (item, variantUrl) => {
        if (item.kind === 'hls') downloadHlsItem(item, variantUrl);
        else downloadDirect(item);
      },
      onProbe: (item) => probeItem(item),
      onNeedSize: (item) => probeSize(item),
      onClear: () => {
        items.clear();
        segmentCount = 0;
        ui.setItems([...items.values()]);
        ui.setNotice('已清空。', 1500);
      },
      onRefresh: () => {
        scanDom(document);
        ui.setItems([...items.values()]);
        ui.setNotice('已重新扫描页面。若仍为空，请先播放一下视频。', 3000);
      },
      onToggleRemux: (v) => {
        settings = { ...settings, remux: v };
        saveSettings(settings);
        ui.setNotice('设置已保存：m3u8 转 MP4 ' + (v ? '开' : '关'), 2000);
      },
    });
    ui.setRemux(settings.remux);
    ui.setItems([...items.values()]);
  } catch (e) {
    console.warn('[媒体嗅探下载器] 界面挂载失败', e);
  }
}

function syncUi() {
  if (!ui) return;
  ui.setItems([...items.values()]);
  ui.setJobs(jobs);
}

// ---------------------------------------------------------------- 下载

function newJob(item, filename) {
  const job = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    url: item.url,
    filename: filename || item.filename,
    current: 0,
    total: 0,
    message: '准备中…',
    cancelable: false,
  };
  jobs.unshift(job);
  if (jobs.length > 4) jobs.pop();
  syncUi();
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  syncUi();
}

/** 直链：优先交给 GM_download，失败再自己抓。 */
async function downloadDirect(item) {
  const job = newJob(item, item.filename);
  updateJob(job, { message: '已交给下载管理器…' });
  try {
    await gmDownload(item.url, item.filename);
    updateJob(job, { message: '完成', current: 1, total: 1 });
    return;
  } catch (e) {
    updateJob(job, { message: '改由脚本自己抓取…' });
  }
  try {
    const r = await gmRequest(item.url, { responseType: 'arraybuffer', timeout: 300000 });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(r.response || new ArrayBuffer(0));
    if (!buf.length) throw new Error('没有取到数据');
    updateJob(job, { message: `正在保存 ${formatBytes(buf.length)}…`, current: 1, total: 1 });
    saveBlob(new Blob([buf], { type: item.contentType || 'application/octet-stream' }), item.filename);
    updateJob(job, { message: '完成：' + item.filename });
  } catch (e) {
    updateJob(job, { message: '失败：' + (e.message || e) });
  }
}

/** HLS：抓分片 → 需要时转封装 → 保存。 */
async function downloadHlsItem(item, variantUrl) {
  const job = newJob(item, item.filename);
  const limit = (settings.remuxLimitMB || 400) * 1024 * 1024;
  const parts = [];
  let remuxParts = null;
  let container = 'unknown';
  let needsRemux = false;
  let decided = false;
  let received = 0;
  let done = 0;
  let total = 0;
  const warnings = [];

  const baseName = () =>
    sanitizeFilename(String(item.filename || item.title || 'media').replace(/\.[a-z0-9]{2,5}$/i, ''), 'media') || 'media';

  const onData = async (bytes) => {
    if (!decided) {
      decided = true;
      container = probeContainer(bytes);
      needsRemux = settings.remux !== false && container === 'ts';
      updateJob(job, { message: needsRemux ? '抓取中（稍后转成 MP4）…' : '抓取中…' });
    }
    received += bytes.length;
    if (needsRemux) {
      if (!remuxParts) remuxParts = [];
      remuxParts.push(bytes);
      if (received > limit) {
        warnings.push(`超过 ${settings.remuxLimitMB}MB，改为保存原始 .ts`);
        parts.push(new Blob(remuxParts, { type: 'video/mp2t' }));
        remuxParts = null;
        needsRemux = false;
        container = 'ts';
      }
    } else {
      parts.push(new Blob([bytes]));
    }
    updateJob(job, { current: done, total, message: `分片 ${done}/${total} · ${formatBytes(received)}` });
  };

  try {
    const res = await downloadHls({
      url: variantUrl && variantUrl !== 'best' ? variantUrl : item.url,
      fetchImpl: gmFetch,
      concurrency: Math.min(Math.max(Number(settings.concurrency) || 4, 1), 8),
      retries: 3,
      onData,
      cryptoImpl: (typeof unsafeWindow !== 'undefined' && unsafeWindow.crypto) || crypto,
      onProgress: async (p) => {
        done = p.done;
        total = p.total;
        updateJob(job, { current: done, total, message: `分片 ${done}/${total} · ${formatBytes(p.received)}` });
      },
    });
    if (res.isLive) warnings.push('直播流，只抓到当前窗口');
    if (res.hasDiscontinuity) warnings.push('存在时间戳断点');

    let blob;
    let ext;
    if (needsRemux && remuxParts && remuxParts.length) {
      updateJob(job, { message: `转封装成 MP4…（共 ${formatBytes(received)}）`, current: 1, total: 1 });
      const out = await remuxToMp4(concatUint8(remuxParts));
      warnings.push(...out.warnings);
      blob = new Blob([out.data], { type: out.mime });
      ext = out.ext;
    } else {
      ext = container === 'fmp4' ? '.mp4' : container === 'adts' ? '.aac' : container === 'mp3' ? '.mp3' : '.ts';
      blob = new Blob(parts, {
        type: ext === '.mp4' ? 'video/mp4' : ext === '.aac' ? 'audio/aac' : ext === '.mp3' ? 'audio/mpeg' : 'video/mp2t',
      });
      if (container === 'ts') warnings.push('已保存为 .ts（未转 MP4）');
    }
    if (!blob.size) throw new Error('没有抓到任何数据');
    const filename = baseName() + ext;
    updateJob(job, { filename, message: `正在保存 ${formatBytes(blob.size)}…` });
    saveBlob(blob, filename);
    updateJob(job, { message: '完成：' + filename + (warnings.length ? '（' + warnings.join('；') + '）' : '') });
    if (ui) ui.setNotice('已开始保存：' + filename, 5000);
  } catch (e) {
    updateJob(job, { message: '失败：' + (e.message || e) });
    if (ui) ui.setNotice('下载失败：' + (e.message || e), 6000);
  }
}

const sizeProbed = new Set();

/**
 * 问一下文件的真实大小。
 * 先用 HEAD（不下载任何内容，最安全）；HEAD 被拒时，只对图片补一次 1 字节的
 * Range 请求——音视频可能有几百兆，不能冒服务器无视 Range 的风险。
 */
async function probeSize(item) {
  if (!item || sizeProbed.has(item.id)) return;
  if (item.kind === 'hls' || item.kind === 'dash') return;
  sizeProbed.add(item.id);

  const apply = (total) => {
    if (!(total > 0)) return false;
    // 资源时间线里的 transferSize 可能只是文件开头一段，这里以实际长度为准
    item.size = total;
    if (item.kind === 'image' && total < TINY_IMAGE_BYTES) item.suspect = true;
    syncUi();
    return true;
  };

  try {
    const r = await gmRequest(item.url, { method: 'HEAD', timeout: 15000 });
    if (r.status >= 200 && r.status < 400) {
      const total = totalBytesFromHeaders((n) => headersFromRaw(r.responseHeaders).get(n));
      if (apply(total)) return;
    }
  } catch {
    /* HEAD 不行就走下面 */
  }

  if (item.kind !== 'image') return;
  try {
    const r = await gmRequest(item.url, { headers: { Range: 'bytes=0-0' }, timeout: 15000 });
    apply(totalBytesFromHeaders((n) => headersFromRaw(r.responseHeaders).get(n)));
  } catch {
    /* 问不到就显示未知 */
  }
}

async function probeItem(item) {
  try {
    const info = await probeHls({ url: item.url, fetchImpl: gmFetch, retries: 1 });
    if (ui) ui.setProbe(item.id, info, info.type === 'master' ? info.variants : []);
  } catch (e) {
    if (ui) ui.setProbe(item.id, { error: String((e && e.message) || e) }, null);
    if (ui) ui.setNotice('读取清晰度失败：' + (e.message || e), 4000);
  }
}

// ---------------------------------------------------------------- 嗅探

const pending = new Map();

function report(payload) {
  if (IS_TOP) {
    queueHit(payload);
  } else {
    try {
      window.top.postMessage({ __mg: '__mg_sniff__', ...payload }, '*');
    } catch {
      /* 忽略 */
    }
  }
}

function queueHit(payload) {
  const url = payload && payload.url;
  if (!url || typeof url !== 'string') return;
  let abs = url;
  try {
    abs = new URL(url, location.href).href;
  } catch {
    return;
  }
  if (!/^https?:/i.test(abs)) return;
  const queued = pending.get(abs);
  if (queued) {
    // 同一条资源会被多个钩子上报（fetch 先到、资源时间线后到且带体积），
    // 这里必须合并而不是丢弃，否则体积信息就丢了。
    if (!queued.size && payload.size) queued.size = payload.size;
    if (!queued.contentType && payload.contentType) queued.contentType = payload.contentType;
    return;
  }
  pending.set(abs, { ...payload, url: abs });
  if (pending.size > 400) flushPending();
  if (!queueHit.timer) queueHit.timer = setTimeout(flushPending, 400);
}

function flushPending() {
  clearTimeout(queueHit.timer);
  queueHit.timer = 0;
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  const hadNone = items.size === 0;
  let changed = false;
  for (const raw of batch) {
    if (/\/seg\d+\.(ts|m4s)$/i.test(raw.url)) continue;
    if (addHit(raw)) changed = true;
  }
  if (changed) {
    ensureUi();
    syncUi();
    if (ui && hadNone && items.size) ui.open();
  }
}

function installHooks() {
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  try {
    const origFetch = W.fetch;
    if (typeof origFetch === 'function') {
      W.fetch = function (input, init) {
        try {
          let url = '';
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') url = input.url;
          if (url) report({ url, via: 'fetch', method: (init && init.method) || 'GET' });
        } catch {
          /* 忽略 */
        }
        return origFetch.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  try {
    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try {
          if (typeof url === 'string') report({ url, via: 'xhr', method });
        } catch {
          /* 忽略 */
        }
        return origOpen.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  try {
    const PO = W.PerformanceObserver;
    if (typeof PO === 'function') {
      const po = new PO((list) => {
        try {
          for (const e of list.getEntries()) {
            if (e && e.name) report({ url: e.name, via: 'perf', size: e.transferSize || e.encodedBodySize || 0 });
          }
        } catch {
          /* 忽略 */
        }
      });
      po.observe({ type: 'resource', buffered: true });
    }
  } catch {
    /* 忽略 */
  }
}

const IMAGE_NAME_RE = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|svg|ico|heic|heif)(\?|$)/i;
const MEDIA_NAME_RE = /\.(mp3|mp4|m4a|m4v|m3u8|webm|flac|wav|ogg|opus|mkv|mov|avi|ts)(\?|$)/i;
const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-actualsrc', 'data-echo'];

function pickFromSrcset(value) {
  if (!value) return '';
  const parts = String(value).split(',');
  for (let i = parts.length - 1; i >= 0; i--) {
    const url = parts[i].trim().split(/\s+/)[0];
    if (url) return url;
  }
  return '';
}

function scanDom(root) {
  try {
    const nodes = root.querySelectorAll ? root.querySelectorAll('video, audio, source') : [];
    for (const n of nodes) {
      const src = n.getAttribute && n.getAttribute('src');
      if (src) report({ url: src, via: 'dom' });
      const poster = n.getAttribute && n.getAttribute('poster');
      if (poster) report({ url: poster, via: 'dom-poster' });
    }

    let budget = 120;
    const imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    for (const img of imgs) {
      if (budget-- <= 0) break;
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (src) report({ url: src, via: 'dom-img' });
      else {
        let lazy = '';
        for (const attr of LAZY_ATTRS) {
          const v = img.getAttribute && img.getAttribute(attr);
          if (v) {
            lazy = v;
            break;
          }
        }
        if (!lazy) lazy = pickFromSrcset(img.getAttribute && img.getAttribute('srcset'));
        if (lazy && IMAGE_NAME_RE.test(lazy)) report({ url: lazy, via: 'dom-img-lazy' });
      }
    }

    const links = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    for (const a of links) {
      const href = a.getAttribute('href');
      if (href && (MEDIA_NAME_RE.test(href) || IMAGE_NAME_RE.test(href))) report({ url: href, via: 'dom-link' });
    }
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- 启动

installHooks();

if (IS_TOP) {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__mg !== '__mg_sniff__') return;
    queueHit(d);
  });
}

try {
  scanDom(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scanDom(document), { once: true });
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    let scheduled = false;
    const mo = new MutationObserver((records) => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        for (const r of records) {
          for (const n of r.addedNodes || []) if (n.nodeType === 1) scanDom(n);
        }
      }, 400);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
} catch {
  /* 忽略 */
}


})();
