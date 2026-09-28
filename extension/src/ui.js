// 面板 UI。这个文件是普通脚本（不是 ES 模块），因为 content script 不能静态 import。
// 挂在 window.MGUI 上，网页内的面板和扩展弹窗共用同一套渲染逻辑与样式。

(function () {
  if (window.MGUI) return;

  const KIND_LABEL = { audio: '音频', video: '视频', hls: '流', dash: '流', other: '其他' };
  const KIND_CLASS = { audio: 'mg-chip-audio', video: 'mg-chip-video', hls: 'mg-chip-hls', dash: 'mg-chip-hls', other: 'mg-chip-other' };

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
    panel.hidden = !!opts.embedded ? false : true;

    const head = el('header', 'mg-head');
    const title = el('div', 'mg-title');
    title.appendChild(el('span', null, '发现的媒体'));
    const count = el('span', 'mg-count', '0');
    title.appendChild(count);
    head.appendChild(title);

    const headActions = el('div', 'mg-head-actions');
    const refreshBtn = el('button', 'mg-icon-btn');
    refreshBtn.type = 'button';
    refreshBtn.textContent = '刷新';
    const openAllBtn = el('button', 'mg-icon-btn');
    openAllBtn.type = 'button';
    openAllBtn.textContent = '复制全部';
    const closeBtn = el('button', 'mg-icon-btn mg-close');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    headActions.append(refreshBtn, openAllBtn, closeBtn);
    head.appendChild(headActions);
    panel.appendChild(head);

    const notice = el('div', 'mg-notice');
    notice.hidden = true;
    panel.appendChild(notice);

    const jobs = el('div', 'mg-jobs');
    panel.appendChild(jobs);

    const list = el('div', 'mg-list');
    panel.appendChild(list);

    const empty = el('div', 'mg-empty');
    empty.innerHTML = '还没有发现可下载的音频或视频。<br>让页面把视频播放一下，或点“刷新”再试。';
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

    root.appendChild(panel);
    return { root, fab, panel, badge, count, notice, jobs, list, empty, remux, showAllBtn, clearBtn, refreshBtn, openAllBtn, closeBtn };
  }

  /**
   * @param {Element} container 挂载点
   * @param {object} opts {embedded, onDownload(item, variantUrl), onProbe(item), onClear(), onRefresh(), onToggleRemux(v)}
   */
  function mount(container, opts) {
    const o = opts || {};
    const shell = buildShell(o);
    container.appendChild(shell.root);

    let items = [];
    let jobs = [];
    let showAll = false;
    let settingRemux = false;
    let probing = null;
    let expandedId = null;
    let isOpen = !!o.embedded;

    function visibleItems() {
      return showAll ? items : items.filter((it) => !it.suspect);
    }

    function render() {
      const vis = visibleItems();
      const suspects = items.length - vis.length;
      shell.count.textContent = String(vis.length);
      if (shell.fab) shell.badge.textContent = String(vis.length);
      if (shell.badge) shell.badge.hidden = vis.length === 0;
      shell.list.textContent = '';
      shell.empty.hidden = vis.length > 0 || jobs.length > 0;

      for (const it of vis) {
        shell.list.appendChild(renderItem(it));
      }
      shell.showAllBtn.hidden = suspects === 0;
      shell.showAllBtn.textContent = showAll ? '隐藏疑似分片' : `显示疑似分片 (${suspects})`;
    }

    function renderItem(it) {
      const row = el('div', 'mg-item mg-kind-' + (it.kind || 'other'));
      const chip = el('span', 'mg-chip ' + (KIND_CLASS[it.kind] || KIND_CLASS.other), KIND_LABEL[it.kind] || '媒体');
      if (it.container) chip.textContent = it.container;

      const main = el('div', 'mg-item-main');
      const name = el('div', 'mg-name', it.filename || it.url);
      name.title = it.url;
      const metaBits = [];
      if (it.host) metaBits.push(it.host);
      if (it.size > 0) metaBits.push(formatBytes(it.size));
      if (it.duration > 0) metaBits.push(formatDuration(it.duration));
      if (it.live) metaBits.push('直播');
      if (it.encrypted) metaBits.push('加密');
      if (it.title) metaBits.push(shortText(it.title, 40));
      const meta = el('div', 'mg-meta', metaBits.join(' · '));
      meta.title = it.url;
      main.append(name, meta);

      const actions = el('div', 'mg-item-actions');
      const dl = el('button', 'mg-btn', it.kind === 'hls' ? '选择清晰度' : '下载');
      dl.type = 'button';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.kind === 'hls' && o.onProbe && expandedId !== it.id) {
          expandedId = it.id;
          probing = it.id;
          renderVariants(row, it, null);
          o.onProbe(it);
          return;
        }
        if (o.onDownload) o.onDownload(it, null);
      });
      const copy = el('button', 'mg-icon-btn mg-copy');
      copy.type = 'button';
      copy.textContent = '复制';
      copy.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copyText(it.url);
        copy.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => {
          copy.textContent = '复制';
        }, 1500);
      });
      actions.append(dl, copy);
      row.append(chip, main, actions);

      if (expandedId === it.id) {
        const holder = el('div', 'mg-variants');
        holder.dataset.role = 'variants';
        row.appendChild(holder);
        if (it.variants) renderVariants(row, it, it.variants);
        else renderVariants(row, it, 'loading');
      }
      return row;
    }

    function renderVariants(row, it, variants) {
      const holder = row.querySelector('[data-role="variants"]');
      if (!holder) return;
      holder.textContent = '';
      if (variants === 'loading') {
        holder.appendChild(el('div', 'mg-variant-hint', '正在读取清晰度…'));
      }
      if (!variants || variants.length === 0) {
        // 单码率列表或读取失败，直接走最高码率；按钮必须照常给出来
        if (variants !== 'loading') {
          holder.appendChild(el('div', 'mg-variant-hint', '这条流没有多档清晰度，可直接下载。'));
        }
      } else {
        for (const v of variants) {
          if (v.iframe) continue;
          const b = el('button', 'mg-btn mg-btn-sm', v.label || '清晰度');
          b.type = 'button';
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            expandedId = null;
            if (o.onDownload) o.onDownload(it, v.url);
          });
          holder.appendChild(b);
        }
      }
      const best = el('button', 'mg-btn mg-btn-sm' + (variants && variants.length ? ' mg-btn-ghost' : ''), variants && variants.length ? '最高码率直接下' : '下载');
      best.type = 'button';
      best.addEventListener('click', (e) => {
        e.stopPropagation();
        expandedId = null;
        if (o.onDownload) o.onDownload(it, 'best');
      });
      const cancel = el('button', 'mg-btn mg-btn-sm mg-btn-ghost', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        expandedId = null;
        render();
      });
      holder.append(best, cancel);
    }

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

    function open() {
      isOpen = true;
      shell.panel.hidden = false;
      shell.root.classList.add('mg-open');
      if (o.onOpen) o.onOpen();
    }
    function close() {
      isOpen = false;
      shell.panel.hidden = true;
      shell.root.classList.remove('mg-open');
    }
    function toggle() {
      if (isOpen) close();
      else open();
    }

    if (shell.fab) shell.fab.addEventListener('click', toggle);
    shell.closeBtn.addEventListener('click', close);
    shell.clearBtn.addEventListener('click', () => o.onClear && o.onClear());
    shell.refreshBtn.addEventListener('click', () => o.onRefresh && o.onRefresh());
    shell.openAllBtn.addEventListener('click', async () => {
      const text = visibleItems()
        .map((it) => it.url)
        .join('\n');
      if (!text) return;
      const ok = await copyText(text);
      shell.openAllBtn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => {
        shell.openAllBtn.textContent = '复制全部';
      }, 1500);
    });
    shell.showAllBtn.addEventListener('click', () => {
      showAll = !showAll;
      render();
    });
    shell.remux.addEventListener('change', () => {
      if (settingRemux) return;
      o.onToggleRemux && o.onToggleRemux(shell.remux.checked);
      setNotice('设置已保存。已开始的任务不受影响。', 2500);
    });

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
        if (probing && !items.some((i) => i.id === probing)) probing = null;
        render();
      },
      setVariants(id, variants) {
        const it = items.find((x) => x.id === id);
        if (it) it.variants = variants;
        if (expandedId === id) render();
        if (!variants || !variants.length) {
          setNotice('没能读到清晰度列表（可能地址已失效），可以直接按最高码率下载。', 4000);
        }
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
      isOpen: () => isOpen,
      isEmbedded: !!o.embedded,
    };
  }

  window.MGUI = { mount, formatBytes, formatDuration, el, icon, shortText, copyText };
})();
