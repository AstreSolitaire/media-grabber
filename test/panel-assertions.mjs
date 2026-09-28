// 面板功能的断言集合：体积显示、媒体/图片分页、缩略图、全屏预览。
// 单独放一个文件，免得把测试脚本本身撑得太长。扩展端与用户脚本端共用。

export async function runPanelAssertions({ page, check, sleep, waitFor, swSession }) {
  /** 面板要先展开才会去探测流媒体的体积（扩展端不会自动弹，需要用户点一下按钮）。 */
  const ensureOpen = () =>
    page.eval(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      var panel = sr.querySelector('.mg-panel');
      if (panel && panel.hidden) {
        var fab = sr.querySelector('.mg-fab');
        if (fab) fab.click();
      }
      return true;
    })()`);

  await ensureOpen();

  // 体积来源排查用：资源时间线里到底有没有 transferSize
  if (process.env.MG_DEBUG_SIZES === '1') {
    const perf = await page.eval(
      `JSON.stringify(performance.getEntriesByType('resource').map(function(e){ return { n: e.name.split('/').pop(), t: e.transferSize, b: e.encodedBodySize, i: e.initiatorType }; }))`
    );
    console.log('  [诊断] 资源时间线:', perf);
  }

  // ---------------------------------------------- 每个资源都要有文件大小
  const sizes = await waitFor(
    async () => {
      const v = await page.eval(`(function(){
        var host = document.querySelector('#mg-host');
        if (!host || !host.shadowRoot) return null;
        var rows = host.shadowRoot.querySelectorAll('.mg-item');
        if (!rows.length) return null;
        return JSON.stringify([].map.call(rows, function(r){
          var m = r.querySelector('.mg-meta');
          var s = r.querySelector('.mg-size');
          var n = r.querySelector('.mg-name');
          return {
            name: n ? n.textContent : '',
            size: s ? s.textContent : '',
            url: m ? (m.getAttribute('title') || '') : '',
            meta: m ? m.textContent : ''
          };
        }));
      })()`);
      const rows = JSON.parse(v || 'null');
      if (!rows) return null;
      // 受防盗链保护的那条是「优雅失败」的用例，本来就不该有体积
      const hls = rows.filter((r) => /\.m3u8$/i.test(r.url) && !r.url.includes('/protected/'));
      // 等 HLS 的自动探测出结果
      if (hls.some((r) => !r.size || r.size === '统计中…')) return null;
      return rows;
    },
    { timeout: 40000, label: '体积信息补齐' }
  ).catch(async (e) => {
    // 面板日志里能看到脚本自己的诊断输出（比如「GM 请求被拒，改用页面身份」）
    const NL = String.fromCharCode(10) + '      ';
    const logs = (page.events || [])
      .filter((ev) => ev.method === 'Runtime.consoleAPICalled')
      .map((ev) => (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
      .filter(Boolean);
    console.log('  面板日志:', logs.length ? NL + logs.slice(-8).join(NL) : '(无)');
    const rows2 = await page.eval(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      return JSON.stringify([].map.call(sr.querySelectorAll('.mg-item'), function(r){
        var n = r.querySelector('.mg-name'), s = r.querySelector('.mg-size'), m = r.querySelector('.mg-meta');
        return { name: n ? n.textContent : '', size: s ? s.textContent : '(无)', url: m ? (m.getAttribute('title')||'') : '' };
      }));
    })()`);
    console.log('  当前列表:', NL + JSON.parse(rows2 || '[]').map((r) => `${r.name} [${r.size}] ${r.url.split('/').slice(-2).join('/')}`).join(NL));
    // 体积没补齐时，把后台的报错打出来（扩展端的请求是在 Service Worker 里发的）
    if (swSession) {
      const NL = String.fromCharCode(10) + '            ';
      const errs = swSession.errors();
      console.log('  后台报错:', errs.length ? NL + errs.slice(0, 5).join(NL) : '(无)');
      const rows = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        return JSON.stringify([].map.call(sr.querySelectorAll('.mg-item'), function(r){
          return { n: (r.querySelector('.mg-name')||{}).textContent || '', m: (r.querySelector('.mg-meta')||{}).textContent || '' };
        }));
      })()`);
      console.log('  当前列表:', rows);
    }
    throw e;
  });

  // 受防盗链保护的那条在本测试装置里必然拿不到（CDP 注入的脚本没有 referrer 来源），
  // 它由「受保护时给出可操作提示」那条断言单独覆盖
  const sized = sizes.filter((r) => !r.url.includes('/protected/'));
  check(
    '每个资源下面都显示了文件大小',
    sized.every((r) => r.size && r.size.length > 0),
    sizes.map((r) => `${r.name}=${r.size}`).join(' | ')
  );

  const hlsEst = sizes.filter((r) => /\.m3u8$/i.test(r.url) && /约/.test(r.size));
  check(
    'HLS 显示的是「约 X」预估体积，而不是播放列表本身那几百字节',
    hlsEst.length >= 2 && hlsEst.every((r) => !/^约 \d+ B$/.test(r.size)),
    hlsEst.map((r) => `${r.name}→${r.size}`).join(' | ')
  );
  check(
    '条目里带了时长',
    sizes.some((r) => /\d+:\d\d/.test(r.meta)),
    sizes.find((r) => /\d+:\d\d/.test(r.meta))?.meta || '没有任何条目带时长'
  );
  check(
    '图片显示的是真实字节数（不是预估）',
    sizes.filter((r) => /\.(png|jpe?g|webp|gif)$/i.test(r.url)).every((r) => /^[\d.]+ [KM]?B$/.test(r.size)),
    sizes.filter((r) => /\.(png|jpe?g|webp|gif)$/i.test(r.url)).map((r) => `${r.name}=${r.size}`).join(' | ')
  );

  // ---------------------------------------------- 分页
  const tabs = JSON.parse(
    await page.eval(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      var n = sr.querySelectorAll('.mg-tab .mg-tab-n');
      return JSON.stringify({
        media: n[0] ? n[0].textContent : '',
        image: n[1] ? n[1].textContent : ''
      });
    })()`)
  );
  check('有「媒体 / 图片」分页，图片独立计数', Number(tabs.image) >= 2, JSON.stringify(tabs));

  // ---------------------------------------------- 图片网格
  await ensureOpen();
  const grid = await waitFor(
    async () => {
      await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelectorAll('.mg-tab')[1].click()`);
      const v = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        var grid = sr.querySelector('.mg-grid');
        var list = sr.querySelector('.mg-list');
        // 看实际渲染结果：hidden 属性会被 display:flex/grid 盖掉，只看属性会漏掉那类 bug
        var show = function (el) { return el && getComputedStyle(el).display !== 'none'; };
        if (!show(grid)) return null;
        if (show(list)) return { bothVisible: true };
        var cells = grid.querySelectorAll('.mg-thumb');
        var imgs = grid.querySelectorAll('.mg-thumb img');
        return JSON.stringify({
          bothVisible: false,
          cells: cells.length,
          imgs: imgs.length,
          firstSrc: imgs[0] ? imgs[0].getAttribute('src') : '',
          loading: imgs[0] ? imgs[0].getAttribute('loading') : '',
          names: [].map.call(grid.querySelectorAll('.mg-thumb-name'), function(x){ return x.textContent; }),
          sizes: [].map.call(grid.querySelectorAll('.mg-size'), function(x){ return x.textContent; }),
          showAll: (sr.querySelector('.mg-show-all') || {}).textContent || ''
        });
      })()`);
      const o = JSON.parse(v || 'null');
      if (o && o.bothVisible) return null; // 列表和网格同时可见说明切换没生效
      return o && o.cells >= 2 && o.imgs >= 2 ? o : null;
    },
    { timeout: 20000, label: '图片网格渲染' }
  );
  check('切到图片页后，媒体列表真的被隐藏了（不是两个都显示）', grid.bothVisible === false);
  check('图片页渲染出缩略图网格', grid.cells >= 2, `${grid.cells} 格：${grid.names.join(' | ')}`);
  check('缩略图是真实 img 元素且懒加载', grid.imgs >= 2 && /^https?:/.test(grid.firstSrc) && grid.loading === 'lazy', grid.firstSrc.slice(0, 70));
  check('缩略图上也标了大小', grid.sizes.some((x) => /B|KB|MB/.test(x)), grid.sizes.join(', '));
  check('极小的图标默认折叠并提供展开按钮', /显示小图标/.test(grid.showAll), grid.showAll);

  // ---------------------------------------------- 图片预览
  await ensureOpen();
  const viewer = await waitFor(
    async () => {
      await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelector('.mg-thumb img').click()`);
      const v = await page.eval(`(function(){
        var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
        if (!box || box.hidden) return null;
        var img = box.querySelector('.mg-viewer-img');
        return JSON.stringify({
          visible: true,
          hasImg: !!img,
          src: img ? img.getAttribute('src') : '',
          complete: img ? img.complete : false,
          naturalW: img ? img.naturalWidth : 0,
          title: (box.querySelector('.mg-viewer-title') || {}).textContent || '',
          meta: (box.querySelector('.mg-viewer-meta') || {}).textContent || '',
          hasDownload: !!box.querySelector('.mg-btn')
        });
      })()`);
      const o = JSON.parse(v || 'null');
      // 图片是异步加载的，等它真的有像素再算数，免得偶发
      if (o && o.hasImg && !(o.naturalW > 0)) return null;
      return o;
    },
    { timeout: 20000, label: '图片预览打开并加载完成' }
  );
  check('点缩略图打开全屏预览并显示图片', viewer.visible && viewer.hasImg && /^https?:/.test(viewer.src), viewer.src.slice(0, 70));
  check('预览里的图片真的加载出来了（有像素尺寸）', viewer.naturalW > 0 || viewer.complete, `naturalWidth=${viewer.naturalW}`);
  check('预览里显示文件名与大小', !!viewer.title && /B|KB|MB/.test(viewer.meta), `${viewer.title} / ${viewer.meta}`);
  check('预览里有下载按钮', viewer.hasDownload);

  await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer .mg-icon-btn').click()`);
  await sleep(400);
  const closed = await page.eval(
    `getComputedStyle(document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer')).display === 'none'`
  );
  check('预览可以关闭（真的不显示了）', closed === true);

  // ---------------------------------------------- 视频预览
  const videoViewer = await waitFor(
    async () => {
      const clicked = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        sr.querySelectorAll('.mg-tab')[0].click();
        var rows = sr.querySelectorAll('.mg-item');
        for (var i = 0; i < rows.length; i++) {
          var m = rows[i].querySelector('.mg-meta');
          if ((m.getAttribute('title') || '').indexOf('clip.mp4') >= 0) {
            var b = rows[i].querySelector('.mg-btn-ghost');
            if (b) { b.click(); return 'clicked'; }
          }
        }
        return 'not-found';
      })()`);
      if (clicked !== 'clicked') return null;
      await sleep(800);
      const v = await page.eval(`(function(){
        var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
        var media = box.querySelector('.mg-viewer-media');
        return JSON.stringify({
          hidden: box.hidden,
          tag: media ? media.tagName : '',
          src: media ? media.getAttribute('src') : '',
          controls: media ? media.controls : false,
          readyState: media ? media.readyState : -1
        });
      })()`);
      const o = JSON.parse(v || 'null');
      return o && !o.hidden && o.tag === 'VIDEO' ? o : null;
    },
    { timeout: 20000, label: '视频预览打开' }
  );
  const backToMedia = JSON.parse(
    await page.eval(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      var show = function (el) { return el && getComputedStyle(el).display !== 'none'; };
      return JSON.stringify({ grid: show(sr.querySelector('.mg-grid')), list: show(sr.querySelector('.mg-list')) });
    })()`)
  );
  check('切回媒体页后，图片网格真的被隐藏了', backToMedia.grid === false && backToMedia.list === true, JSON.stringify(backToMedia));

  check(
    'mp4 能用播放器直接预览',
    videoViewer.tag === 'VIDEO' && /clip\.mp4$/.test(videoViewer.src) && videoViewer.controls,
    JSON.stringify(videoViewer)
  );

  // ---------------------------------------------- 流媒体的预览说明
  const streamHint = await waitFor(
    async () => {
      await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        var box = sr.querySelector('.mg-viewer');
        if (!box.hidden) box.querySelector('.mg-icon-btn').click();
        sr.querySelectorAll('.mg-tab')[0].click();
        var rows = sr.querySelectorAll('.mg-item');
        for (var i = 0; i < rows.length; i++) {
          var m = rows[i].querySelector('.mg-meta');
          var b = rows[i].querySelector('.mg-btn-ghost');
          if (b && /\.m3u8$/i.test(m.getAttribute('title') || '')) { b.click(); return 'ok'; }
        }
        return 'not-found';
      })()`);
      await sleep(500);
      const txt = await page.eval(`(function(){
        var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
        if (box.hidden) return null;
        var h = box.querySelector('.mg-viewer-hint');
        return h ? h.textContent : '';
      })()`);
      return txt || null;
    },
    { timeout: 20000, label: '流媒体预览提示' }
  );
  check('m3u8 预览给出明确说明，而不是空白', /下载|无法|不能/.test(streamHint), streamHint.slice(0, 70));

  await page.eval(`(function(){
    var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
    if (!box.hidden) box.querySelector('.mg-icon-btn').click();
  })()`);

  // ---------------------------------------------- 点 × 要真的把面板关掉
  const closeResult = await (async () => {
    await ensureOpen();
    await sleep(300);
    const before = await page.eval(
      `getComputedStyle(document.querySelector('#mg-host').shadowRoot.querySelector('.mg-panel')).display`
    );
    await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelector('.mg-close').click()`);
    await sleep(400);
    const after = await page.eval(
      `getComputedStyle(document.querySelector('#mg-host').shadowRoot.querySelector('.mg-panel')).display`
    );
    return { before, after };
  })();
  check(
    '点 × 面板真的消失（hidden 不会被 display:flex 盖掉）',
    closeResult.before !== 'none' && closeResult.after === 'none',
    `点之前 display=${closeResult.before}，点之后 display=${closeResult.after}`
  );
}
