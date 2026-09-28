# 媒体嗅探下载器（Media Grabber）

一个 Edge / Chromium 扩展 + 一个功能等价的**用户脚本**：抓取网页里的 **mp3、m4a、mp4**，
以及 **m3u8（HLS）** 视频流，自动合并分片、必要时转成 MP4，保存到本机下载目录。

手机上的形态是：网页右下角出现一个按钮 → 点开 → 看到页面里所有媒体 → 点“下载”。

---

## 📱 手机上装哪个？先看这里

手机版 Edge 不能像桌面版那样加载任意扩展，所以有两条实测过的路：

| | **路 A：篡改猴 + 用户脚本**（✅ 推荐，已在真机跑通） | 路 B：Edge Canary + CRX |
| --- | --- | --- |
| 需要 | 稳定版 Edge 即可：菜单 →「扩展」→ 装**篡改猴** | 另装 Edge Canary，开 flags、进开发者选项、装 crx |
| 安装 | 打开一个网址，篡改猴弹安装页，点「安装」 | 步骤多，且部分版本没有侧载入口 |
| 功能 | mp3/mp4/m3u8 全支持，自动转 MP4 | 完全一致（同一套算法代码） |
| 实测 | **在真机上完成过完整下载**（见下） | 未在手机上实测过 |

**路 A 的三步**（配合电脑用 USB 线最省事，全程不用连 Wi-Fi）：

```bash
# 电脑上：启动一个只监听本机的小服务，并把端口反向映射给手机
npm run serve:userscript            # 启动 http://localhost:8899
adb reverse tcp:8899 tcp:8899       # 手机访问 localhost:8899 就通到电脑
```

1. 手机 Edge：菜单 →「扩展」→ 搜 **篡改猴 / Tampermonkey** → 获取并安装；
2. 手机 Edge 地址栏打开 `http://localhost:8899/media-grabber.user.js`；
3. 篡改猴弹出安装页 → 点「**安装**」。

> 装完就不需要电脑了。`adb reverse` 只是用来把这个脚本文件递给手机，
> 之所以走 USB 隧道而不是局域网，是为了不依赖手机和电脑在同一个 Wi-Fi 下。
> 也可以把 `userscript/media-grabber.user.js` 传到手机后用篡改猴的「工具 → 导入」来装。

**实机验证记录**：在 OPPO PL1 10（Android 16）+ Edge 151 稳定版 + 篡改猴 5.5.0 上，
打开一条 720p HLS 测试流，点悬浮按钮 → 列出媒体 → 下载 → 手机弹出系统保存确认 →
文件落到 `内部存储/Download/手机测试页 · 视频下载.mp4`（2,219,686 字节），
拉回电脑用 `ffprobe` 校验：**H.264 1280×720 + AAC 48kHz 立体声，时长 6.07 秒，完整解码无报错**。

### 用户脚本和扩展有什么差别

- 用户脚本用 `GM_xmlhttpRequest` 跨域抓分片，**不需要**扩展那样额外开一个抓取页；
- 用户脚本不能写子目录，文件直接落在「下载」目录（手机上也正合适）；
- 手机上每次保存会弹一次系统确认框，点一下就存；
- 其余能力（含 AES-128 解密、TS→MP4 转封装、多码率选择）与扩展完全相同——
  因为算法是**同一份源码**，由 `tools/build-userscript.mjs` 从 `extension/src/lib/` 拼进去的。

---

## ⚠️ 关于扩展 + 手机版 Edge 的限制

**微软 Edge 安卓稳定版不允许安装任意第三方扩展**，只能装商店里预批的那些。
安卓上也**没有**桌面版那种「加载已解压的扩展程序」。所以扩展这条路只有：

| 方案 | 需要什么 | 说明 |
| --- | --- | --- |
| **A. Edge Canary** | Play 商店装 *Microsoft Edge Canary*，开启开发者选项，用 `.crx` 安装 | 见下方步骤 |
| **B. 换一个支持扩展的安卓浏览器** | Kiwi / Lemur(狐猴) / Mises / Yandex | 见「其他安装方式」 |

> 实测记录：稳定版 Edge 151 的 `edge://flags` 里**没有**扩展安装开关，
> 「开发人员选项」里也**没有**「通过 crx 安装扩展」入口，只有一堆内部调试项。
> 也就是说稳定版这条路走不通，请用上面的用户脚本，或装 Canary。
> 扩展本体的自动化端到端测试跑在 **Windows 版 Edge 154**（`--load-extension` 加载）。
> 顺带一提：Chrome 156 已经**静默忽略** `--load-extension` 了，Edge 154 仍然支持。

---

## 安装（扩展）

### A. 安卓 Edge Canary（用 crx）

1. 从 Play 商店安装 **Microsoft Edge Canary**（不是 Beta、不是稳定版）。
2. 地址栏输入 `edge://flags`，搜索 `Android Extension Search`，设为 **Enabled**，重启浏览器。
   （部分版本用 `edge://flags` 里的 “Android extensions” 开关，名称略有差异。）
3. 进入 **设置 → 关于 Microsoft Edge**，**连点版本号 5 次**，开启「开发者选项」。
4. **设置 → 开发者选项 → 通过 crx 安装扩展**，选择手机上的 `media-grabber.crx`。
5. 装好后在菜单里应能看到「扩展」入口，扩展名为「媒体嗅探下载器」。

把 `media-grabber.crx` 传到手机的方式：数据线 / 微信文件传输助手 / 网盘 / 局域网都行。

### B. 其他安卓浏览器

- **Kiwi Browser**：把 `media-grabber.zip` 传到手机 → `kiwi://extensions` → 打开开发者模式 →
  点 **`+`（从 .zip/.crx 安装）** → 选中 zip。最省事，但 Kiwi 项目已归档、内核偏旧。
- **Yandex Browser**：地址栏进 `chrome://extensions` → 打开开发者模式 → **加载已解压的扩展程序** →
  选手机里解压后的 `extension` 目录。
- **Lemur / Mises**：从 Chrome 应用商店 / Edge 加载项商店安装（需要先上架；自己用请走上面两种）。

### C. 桌面版 Edge（开发调试用）

1. 打开 `edge://extensions`；
2. 打开左下角「**开发人员模式**」；
3. 点「**加载解压缩的扩展**」，选择本仓库的 `extension/` 目录。

桌面版也可以直接装 `media-grabber.crx`（需先开启开发人员模式，若提示未受信任来源则用上一种方式）。

---

## 怎么用

### 手机 / 网页里的悬浮面板

1. 正常打开有音频或视频的网页，**让视频先播一下**（很多站点的 m3u8 地址藏在播放器脚本里，
   不播放就不会发出请求，也就抓不到）。
2. 页面右下角出现圆形按钮（带数字角标）。点它打开面板。
3. 列表里每条是：
   - **音频 / 视频** → 点「下载」直接保存；
   - **流（m3u8）** → 点「选择清晰度」，会列出 1080p / 720p 等档位；单码率的列表会直接给「下载」。
4. 面板顶部显示进度（分片 x/y、已下载大小、转封装中…）。完成后文件进入系统下载目录。

### 桌面版弹窗

点浏览器工具栏上的扩展图标，功能一样，另外可以设置保存子目录、分片并发数、是否带 Referer。

### 设置项

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| m3u8 转成 MP4 | 开 | 把 MPEG-TS 分片重封装成 MP4（不重新编码，画质无损） |
| 保存子目录 | `MediaGrabber` | 文件放在下载目录下的哪个子目录，留空则直接放下载目录 |
| 分片并发数 | 4 | 同时下载几个分片，网络差就调小 |
| 抓取时带上页面 Referer | 开 | 对付防盗链的 CDN |
| 抓完自动关闭抓取页 | 开 | 抓取用的后台标签页会自己关掉 |

---

## 能抓什么 / 抓不到什么

**能**：

- `.mp3` `.m4a` `.aac` `.flac` `.wav` `.ogg` `.opus` 等音频直链
- `.mp4` `.webm` `.mkv` `.mov` 等视频直链
- **HLS / m3u8**：多码率主列表、单码率列表、`EXT-X-MAP`（fMP4 分片）、`EXT-X-BYTERANGE`（单文件按字节切片）
- **AES-128 加密**的 HLS（密钥可从 URI 取到时；IV 显式给出或用分片序号推导都支持）
- 分片是 MPEG-TS / fMP4 / 裸 ADTS-AAC / MP3 的情况
- 直播流的当前窗口（会提示「只抓到当前窗口内的内容」）

**抓不到**（会给出明确提示，不会静默产出坏文件）：

- **DRM 加密**：Widevine、`SAMPLE-AES`、`KEYFORMAT="com.apple..."` 这类商业 DRM，浏览器里无法解密
- **DASH（.mpd）**：暂未实现
- **H.265/HEVC 视频轨的转封装**：会提示跳过视频轨（可关闭「转成 MP4」以保存原始 `.ts` 后自行处理）
- 地址完全由 JS 拼出来、且不经过 fetch/XHR、也没有 DOM 属性的情况（极少见）

---

## 保存的文件名与位置

- 文件名优先用**网页标题**；如果原始文件名有意义（比如 `歌曲名.mp3`）会保留原样。
- 同一页面有多条同名媒体时，会自动加上目录名区分，例如 `HLS 测试页-ts.mp4`。
- 名字里对文件系统非法的字符会被替换成 `_`。
- 文件保存在 `<系统下载目录>/<保存子目录>/`。
  若你的浏览器不接受带子目录的文件名（个别安卓内核），扩展会**自动去掉子目录再存一次**，文件会直接落在下载目录。

---

## 为什么下载 m3u8 时会冒出一个标签页？

因为**跨域抓分片必须在扩展自己的页面里做**：

- 网页里的脚本受同源策略限制，拿不到 CDN 上的分片；
- 扩展后台（Service Worker）有跨域权限，但**不能创建 blob 地址**，没法把合并好的文件交给下载管理器；
- 扩展自己的页面两者都行。

所以扩展会打开一个标题为「媒体抓取中」的后台标签页来完成抓取、解密、转封装，抓完自动关闭
（可在设置里关掉自动关闭）。普通 mp3/mp4 直链不走这条路，直接交给浏览器下载管理器，不占内存。

---

## 权限与隐私

| 权限 | 用途 |
| --- | --- |
| `host_permissions: <all_urls>` | 在任意站点嗅探媒体、跨域抓取分片 |
| `downloads` | 把文件保存到下载目录 |
| `webRequest` | 读取响应头判断内容类型与大小 |
| `scripting` | 安装后给已经打开的标签页补注入嗅探脚本 |
| `storage` | 保存设置和当前标签页的媒体列表（仅本机） |

- 所有处理都在本机完成，**没有任何数据发往外部服务器**，不含统计与埋点。
- 列表按标签页隔离，切换/刷新页面即清空。
- 代码全部在本仓库，可自行审阅。

---

## 已知限制

- **内存**：转封装需要在内存里过一遍数据。超过 400 MB 会自动改为保存原始 `.ts`（避免手机内存不足），
  这个阈值可改 `saver.js` 里的 `sizeLimit`。
- **恢复能力较弱**：抓取过程中关掉那个「媒体抓取中」标签页会中断任务（可以重新点下载）。
- 分片极多或网络很差的站点，建议把并发数调到 2。
- HLS 里带 `EXT-X-DISCONTINUITY`（时间戳断点）的流，转封装后画面可能有跳变，会给出提示。
- HEVC(H.265) 视频轨不参与转封装。

---

## 开发与测试

```bash
npm run test          # 全套：静态校验 + 单元/集成测试 + 真实浏览器端到端
npm run test:fast     # 跳过浏览器（设 MG_SKIP_SMOKE=1）
npm run verify        # 只做静态校验
npm run build         # 生成 build/media-grabber.zip 与 .crx
```

测试分三层，都是可复现的：

1. **静态校验** `tools/verify.mjs`
   manifest 引用是否都存在、权限是否真被用到、所有 JS 语法、**消息类型收发是否对得上**
   （发往后台的消息必须有处理函数，反过来也一样）、`content_scripts` 顺序（`ui.js` 必须在 `content.js` 前）。

2. **单元与集成测试**（`node --test`）
   - AES：纯 JS 实现与 Node `crypto` 逐字节比对，含「无 PKCS#7 补位」的回落路径；
   - HLS 解析：属性串引号内逗号、`EXT-X-KEY`/`EXT-X-BYTERANGE`/`EXT-X-MAP`/直播标记、无 IV 时按序号推导；
   - **转封装**：用 ffmpeg 现场生成真实 HLS（TS 分片、1080p 裁剪、AES-128、fMP4、纯音频、字节范围），
     跑完整「下载 → 解密 → 转封装 → 落盘」，再用 `ffprobe` 校验编码/分辨率/时长/帧数，
     并用 `ffmpeg -i out.mp4 -f null -` **完整解码一遍**确认没有损坏或时间戳错乱。

3. **端到端冒烟测试** `test/smoke.mjs`（需要本机有 Edge）
   真的启动 Edge 加载扩展，打开一个会请求 m3u8 的测试页，然后：
   检查扩展是否被浏览器接受、Service Worker 是否启动、主世界嗅探脚本是否注入、
   面板是否列出条目（且**不把 .ts 分片当条目**）、文件名是否用了页面标题、
   点击下载后文件是否落盘、落盘文件能否被 `ffprobe` 解析且完整解码、后台与页面是否有异常。

> 为什么端到端测试用 Edge 而不是 Chrome：Chrome 156 已经**静默忽略** `--load-extension`
> （实测带不带纯 ASCII 路径都一样，也不报错），Edge 154 仍然支持。
> 测试服务器曾把 `.html` 的 MIME 漏掉导致 Chrome 把导航当下载，这类问题正是靠真机跑才暴露出来的。

测试过程中确实抓到过几个真 bug，都靠上面这层验证发现：
转封装时每帧间隔被多加了一个起始 PTS（时长整体偏大）、音频 chunk 偏移被多加了一整个视频的大小
（解码到音频就中断）、`ui.js` 里 `badge` 作用域错误导致面板挂不上、
以及「嗅探到的地址没有扩展名（`?format=m3u8`）漏抓」和「页面标题比媒体请求更早到达时文件名不生效」。

---

## 目录结构

```
extension/                 ← 扩展本体（加载这个目录）
  manifest.json
  src/
    inject.js              主世界嗅探：拦 fetch / XHR / 资源时间线 / DOM
    content.js             内容脚本：转发嗅探结果，挂载面板
    ui.js                  面板与弹窗共用的渲染逻辑（普通脚本，挂 window.MGUI）
    panel.css              面板样式（同时用于 Shadow DOM 与弹窗）
    background.js          后台：webRequest 嗅探、列表维护、下载编排
    saver.html / saver.js  抓取页：跨域抓分片、解密、转封装、落盘
    popup.html / popup.js  桌面版弹窗
    lib/
      util.js              URL/文件名/并发/重试等纯函数
      detect.js            媒体类型判定
      hls.js               m3u8 解析与分片下载
      aes.js               AES-128-CBC（WebCrypto 主路径 + 纯 JS 回落）
      ts2mp4.js            MPEG-TS / ADTS / MP3 → MP4 重封装
  icons/
userscript/
  parts/app.js            用户脚本外壳：GM 适配、嗅探、界面、下载编排
  media-grabber.user.js   ← 构建产物（手机装这个文件），103 KB，单文件
tools/                     verify.mjs 静态校验、build.mjs 打包扩展、
                           build-userscript.mjs 生成用户脚本、
                           serve-userscript.mjs 递给手机安装、
                           make-icons.mjs 生成图标
test/                      单元/集成测试、fixtures 生成、静态服务器、
                           smoke.mjs 扩展端到端、userscript-smoke.mjs 用户脚本端到端
build/                     扩展产物：media-grabber.zip / .crx / 签名密钥 / 扩展 ID
```

用户脚本是**构建出来的**，不要直接改 `userscript/media-grabber.user.js`：
改 `extension/src/lib/*.js` 或 `userscript/parts/app.js`，然后 `npm run build:userscript`。
构建脚本会做语法检查和结构自检（metadata、GM 授权、CSS 内联、无残留 import/export）。

---

## 打包与更新

```bash
npm run build
```

产物在 `build/`：

- `media-grabber.crx` — 签名过的 CRX3，安卓 Edge Canary 用；
- `media-grabber.zip` — Kiwi 等支持从 zip 安装的浏览器用；
- `media-grabber.pem` — **签名密钥，请保留**；
- `extension-id.txt` — 扩展 ID 与说明。

扩展 ID 由签名密钥决定。**更新扩展时请继续用同一把 `media-grabber.pem`**，
否则 ID 会变、安卓上要重新安装。打包脚本会自己校验 crx 结构与签名（用公钥验一遍），
签名不对会直接失败退出。

---

## 如果扩展这条路太麻烦

安卓上抓 m3u8/mp3 还有一条更省事的路：**Termux + yt-dlp**

```bash
pkg install python ffmpeg
pip install -U yt-dlp
cd /sdcard/Download
yt-dlp "网页地址"
```

yt-dlp 同样支持 m3u8、AES-128、多清晰度选择（`-F` 列格式、`-f` 选格式），
适合「批量下载」而不是「边看边抓」。两者定位不同，按需选用。
