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
