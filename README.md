# dsh-geogebra

[![CI](https://github.com/Z-415/dsh-geogebra/actions/workflows/ci.yml/badge.svg)](https://github.com/Z-415/dsh-geogebra/actions/workflows/ci.yml)

让 DSH 里的模型用**一条 GeoGebra 命令列表**画出真正的 GeoGebra 图形，落地成
**PNG 图片**或**能用 GeoGebra 打开继续编辑的 `.ggb` 构造文件**。

- 无窗口：无头 Edge，不弹浏览器
- 不抢鼠标键盘：全程没有一次模拟输入
- 不改变前台窗口：调用前后 `MainWindowTitle` 一致（实测通过）
- 导出的是**画布本体**：没有代数区、工具栏、输入栏、虚拟键盘
- 命令写错会**报错**（点名哪条被拒绝），不会给你一张空白图
- `out` 写 `.ggb` 就得到可编辑构造文件，同时自动附一张同名 `.png`

---

## 1. 装法与卸载

```powershell
# 方式 A：直接从 GitHub 装（推荐）
dsh plugin --profile desktop add github:Z-415/dsh-geogebra

# 方式 B：用 Release 里的离线包（github.com 访问不稳时走这条）
#   从 https://github.com/Z-415/dsh-geogebra/releases/latest 下载 dsh-geogebra-0.1.0.tgz
dsh plugin --profile desktop add file:<tgz 的绝对路径>

# 方式 C：本地开发，link 到某个目录（改代码不用重装）
dsh plugin --profile desktop add link:<本仓库的绝对路径>   # 例：link:D:\code\dsh-geogebra

# 装完必须完全重启 DSH Desktop（托盘右键 → 退出 → 重开），工具才会注册
```

```powershell
# 回滚
dsh plugin --profile desktop remove dsh-geogebra
```

`link:` 安装不往 profile 的 `cordis.patch.yml` 写东西，移除后删掉插件目录即可完全恢复；
回滚同样要重启一次 DSH 才生效。

**运行前置**：Windows + Microsoft Edge（无头模式用它渲染）+ 能访问 geogebra.org。
不需要装 GeoGebra 桌面版，也不需要 Python / Node 之外的任何依赖（本插件零 npm 依赖）。

**启动自证**：插件加载后会写 `<插件目录>/.boot-status.json`。
重启后模型看不到 `ggb_draw` 时先看这个文件：

| 文件里看到 | 含义 |
|---|---|
| `draw: "ok"` + `eval: "ok"` | 注册成功，看不到工具就是会话/模型侧的问题 |
| `draw: "FAILED: ..."` | 工具注册失败（schema 写坏了），失败原因就在后面 |
| 文件不存在 | 插件根本没加载 —— 查 `package.json` 的 `dsh.bundle.patch` 和 `cordis.patch.yml` 的包名 |

## 2. 用法

```
ggb_draw(
  commands: ["f(x)=x^3-3x", "T=Tangent(1,f)", "A=(1,-2)"],
  out:      "C:\\Users\\<你>\\Desktop\\图.ggb"     ← 想要能用 GeoGebra 打开的就写 .ggb
)
```

返回：

```
已生成 GeoGebra 图：C:\...\图.png（251.1 KB，1563x1093，耗时 1.9 秒）
可编辑构造文件：C:\...\图.ggb（4.3 KB，GeoGebra 里「打开」即可继续拖动/改参数）
读回的值（用它自查数学是否正确，再看图）：
- f(x)=x^3-3x → f(x) = x³ - 3x
- T=Tangent(1,f) → T: y = -2
- A=(1,-2) → (1, -2)
```

`.ggb` 是 GeoGebra 自己的构造文件（ZIP，内含 `geogebra.xml` + 视图设置），
里面存的是**对象定义**（函数、切线、点），不是像素：打开后可以拖动、改参数、继续作图。
本机 `.ggb` 已有文件关联（`HKCU\Software\Classes\.ggb` → `GeoGebra.Document` → GeoGebra Classic 的 exe），
双击即用 GeoGebra Classic 打开；也可以在 GeoGebra 里「文件 → 打开」，或直接把文件拖进窗口。

| 参数 | 默认 | 说明 |
|---|---|---|
| `commands` | 必填 | GeoGebra 命令数组，按顺序执行；被 `evalCommand` 拒绝的那条会被点名 |
| `out` | 必填 | PNG 绝对路径，父目录自动创建，必须以 `.png` 结尾 |
| `width` / `height` | 1000 / 700 | 画布 CSS 像素尺寸，限制 200–4000 |
| `dpi` | 150 | 输出分辨率 = `width × dpi/96` 像素；讲义插图 200–300 |
| `transparent` | false | 透明背景（白底在导出后还原成 alpha，抗锯齿灰边用反预乘保住） |
| `ggb` | 无 | `out` 是 `.png` 时，额外再存一份 `.ggb` 到这个路径（想要"图片 + 可编辑构造"两份时用） |
| `axes` / `grid` | true | 坐标轴 / 网格 |
| `timeoutMs` | 75000 | 等待上限，最低 30000 |

另有 `ggb_eval`：只执行命令、只回每条的结果值，不出图。画图前想先确认"切线是不是 y = -2"就用它。

## 3. 已知限制

1. **必须联网**。`deployggb.js` 与约 30MB 运行资源都从 geogebra.org 拉；断网时首次调用会直接报
   `deployggb.js 拉取失败` 而不是干等。
2. **首次 20–40 秒**，之后走 Edge 磁盘缓存（`%TEMP%\dsh-geogebra-edge-profile`）通常 2–4 秒。
3. **只出 2D 图形视图**。GeoGebra 3D 在无头模式下的表现没验证，本插件不支持。
4. **`.ggb` 只写不读**：能产出 `.ggb` 给你打开，但还不能把已有 `.ggb` 读进来继续加对象
   （要读的话走 `api.setBase64()`，已验证可行，只是工具面还没开放）。
5. **调用串行**。同一时刻只跑一个 Edge（两个共用配置目录会互相接管），并发调用自动排队。
6. **命令参数顺序按 GeoGebra 的规矩**：切线是 `Tangent(横坐标, 函数)`，写成 `Tangent(f,1)` 会被拒绝。
7. **输出尺寸是 width×height 的 CSS 像素再乘 dpi/96**，与图片里的坐标单位无关；`.ggb` 里的视图
   范围也跟着这次渲染的窗口走。

## 4. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `找不到 Microsoft Edge` | 改 `lib/render.mjs` 的 `EDGE_CANDIDATES` |
| `等待 GeoGebra 就绪超时` | 网络慢 / 首次下载没完成：重试一次或把 `timeoutMs` 提到 120000 |
| `连不上 Edge 的调试端口` | 上次的 Edge 没退干净占住了临时配置目录：重试；反复出现就删 `%TEMP%\dsh-geogebra-edge-profile` |
| `GeoGebra 拒绝了这些命令：...` | 命令语法/参数顺序错，按点名的那条改 |
| 图里只有坐标轴没有曲线 | 用 `ggb_eval` 看每条是否 ok；命令没定义出可见对象时也会这样 |
| `notes: 透明背景转换失败` | 截图不是 8bit 非隔行 RGB(A)，保留白底图（不影响使用） |
| Edge 的 stderr 里一堆 `QQBrowser user data path not found` / `task_manager fallback` | 系统里别的浏览器壳留下的噪音，与本插件无关 |

## 5. 设计要点（改代码前必读）

### 5.1 为什么不是任务书 §5.5 那条 `--dump-dom` + `--virtual-time-budget` 路线

任务书假设"页面里用 `getPNGBase64` 导出 base64，宿主 `--dump-dom` 抓回来"。**在本机实测这条路线是坏的**
（2026-10-24，Edge 无头，GeoGebra `5.4.920.0`）：

| 试过的 | 结果 |
|---|---|
| `api.getPNGBase64(cb, …, …)` | 抛 `Unable to parse base64 string.`（试了 4 种参数组合全抛） |
| `api.getScreenshotBase64(cb)` | 抛 `Class$S1671: Index: 22, Size: 7` |
| `canvas.toDataURL()` 直接读图形画布 | 能读到，但**读到的画布永远是空白的**（真实画面在别的合成层里） |
| `--screenshot` + 虚拟时间预算 | 代数区文字照常渲染，canvas 内容永远不提交 → 图里只有空坐标系 |

根因是 `--virtual-time-budget` 把真实帧生产饿死了：GeoGebra 的图形重绘靠帧回调推进，
虚拟时间快进时这些帧不产生，于是"命令执行成功、`getValueString` 正确、截图空白"。

### 5.2 现在的流程（`lib/cdp.mjs` + `lib/render.mjs`）

```
temp HTML（lib/template.mjs）
   └─ 无头 Edge：--headless=new --remote-debugging-port=0
                 --force-device-scale-factor=<dpi/96> --user-data-dir=<隔离目录>
        └─ CDP：读 DevToolsActivePort → 连 WebSocket → 轮询 window.__ggb.status
             ├─ ok  → 等两帧让画布上屏 → 取图形区矩形 → Page.captureScreenshot(clip)
             └─ err → 把页面里的错误原文回传
```

关键细节，别改回去：

- **像素比用启动参数 `--force-device-scale-factor`**，不要用 `Emulation.setDeviceMetricsOverride`：
  后者要求赶在 GeoGebra 初始化之前生效，跟页面加载抢跑，实测经常被丢掉（画布按 1x 渲染、dpi 白写）。
- **不要用 `--default-background-color=00000000`**：实测这个启动参数会让整页脚本不再执行
  （CDP 里 `Runtime.evaluate` 永远拿不到值），表现为"永远等不到就绪"。透明背景走
  `Emulation.setDefaultBackgroundColorOverride` + 导出后白底转 alpha（`lib/png.mjs`）。
- **`perspective:'G'` 是唯一真正关掉代数区的开关**。`showAlgebraView:false` 在 5.4.920 里被忽略，
  只用它会得到一个左边挂着代数区的 762×525 缩略图。
- **图形区靠 CDP 裁剪**（`Page.captureScreenshot` 的 `clip`），不要整页截图：整页会带进面板边框，
  而且 5.4 的布局会把 applet 缩放到 762×525 塞进窗口。
- **关闭时先 `Browser.close` 再等退出，最后才 `taskkill /T /F`**：只杀 browser 进程会把
  renderer/GPU 子进程留下，配置目录被占住，下一次启动就挂住。
- **`--user-data-dir` 必须隔离**：用户自己也开着 Edge，不隔离的话新进程会把 URL 交给已有实例后立刻退出，
  CDP 连不上、`DevToolsActivePort` 也不会重写（复用缓存目录时每次启动前要删掉这个文件）。
- **工具返回的字段必须与输出 schema 对齐**。输出 schema 是 `additionalProperties: false`，
  `execute()` 多返回一个字段就会被宿主整条拒收，报
  `tool "ggb_draw" returned invalid output: "value.dpi" is not a declared property` ——
  图其实已经生成成功，调用方却只看到一句 invalid output，极容易误判成"渲染坏了"。
  现在 `index.js` 出口用 `pick()` 按白名单收敛（`DRAW_OUTPUT_KEYS` / `EVAL_OUTPUT_KEYS`）：
  以后改 `lib/render.mjs` 多加了字段也不会把整条调用打挂。改完跑一次 `验证\smoke-plugin.mjs`
  能当场把这类错抓出来（它拿 stub 顶替 `@deepseek-ai/dsh-tools`，直接调 `execute()` 再逐个字段核对 schema）。
- **改完宿主代码后怎么让它生效**：`link:` 安装的插件在运行中的 DSH 里不会自动热重载
  （`dsh-hmr` 只管 patch/配置，不重新 import 插件模块）。不用重启整机也能重载单个插件：
  `plugin_manager` 对 `include:geogebra` 先 `enabled:false` 再 `enabled:true`。

### 5.3 `.ggb` 是怎么来的（别自己拼）

- 用 **`api.getBase64()`**：它返回的就是整份 `.ggb` 的 ZIP base64
  （实测 4362 字节，ZIP 条目：`geogebra.xml` / `geogebra_defaults2d.xml` / `geogebra_defaults3d.xml` /
  `geogebra_javascript.js`）。宿主只做三件事：解码、校验前两字节是 `PK`、落盘。
- **不要用 `getXML()` 自己拼 ZIP**：`geogebra.xml` 只是构造本体，还缺 defaults 等条目；
  自己拼容易做出"能解压但 GeoGebra 打不开"的文件。`getXML()` 适合做文本检查，不适合当交付物。
- 写盘前必须校验 ZIP 魔数（`0x50 0x4b`）：拿到的若不是构造文件就**宁可只留 PNG 并在 `notes` 里说明**，
  不要把一个坏文件塞给用户。
- 往返验证脚本：`验证\check-ggb.mjs <文件.ggb>` —— 解 ZIP 列条目、读 `geogebra.xml`、
  再把整份 base64 当 `ggbBase64` 参数重新载入 GeoGebra，读回 `f`/`T`/`A` 的值并出图。
  这是"这个文件真的能被 GeoGebra 打开"最直接的证据。

## 6. 测试与 CI

仓库自带两套测试，零 npm 依赖（用 Node 自带的 `node --test`）：

```powershell
node --test test/contract.test.mjs   # 契约测试：不联网、不起浏览器，几秒
node --test test/e2e.test.mjs        # 端到端：真起无头 Edge、真拉 GeoGebra，约 1–2 分钟
node --test test/                    # 两套都跑
```

| 套件 | 覆盖什么 | 需要 |
|---|---|---|
| `contract.test.mjs` | 清单契约（`dsh.bundle.patch` / 包名挂载）；两个工具都注册成功；**输出字段白名单与 schema 逐字段一致**；参数错误时字段不越界 | 只要 Node |
| `e2e.test.mjs` | 数学判据（切线 `y = -2`）；PNG 尺寸 = 宽高 × dpi/96；`.ggb` 是合法 ZIP 且含 `geogebra.xml`；错误命令报错且不留文件；`ggb_eval` 不出图 | Node + Edge + 联网 |

契约测试专治一类"装机后才发现"的 bug：宿主按 `additionalProperties: false` 校验输出，
`execute()` 多返回一个字段整条结果就被拒，图其实已经生成成功了。
（2026-10-24 就这么踩过一次：`"value.dpi" is not a declared property`。）

CI 在 `windows-latest` 上跑这两套（GitHub 的 Windows runner 自带 Microsoft Edge）：

```yaml
.github/workflows/ci.yml
  contract  契约测试
  e2e       端到端（依赖 contract 通过；先确认 Edge 存在、geogebra.org 可达）
```

## 7. 验证记录

下面的结果均来自本机实测（2026-10-24，Windows / Edge 无头 / GeoGebra 5.4.920.0）。
想自己复核：

```powershell
# 会话里让模型调用（或在装了本插件的 DSH 里直接说）
ggb_draw(commands: ["f(x)=x^3-3x", "T=Tangent(1,f)", "A=(1,-2)"],
         out: "<任意目录>\测试.ggb")
```

判据：读回的值里 `T` 必须是 `y = -2`；`.ggb` 双击用 GeoGebra 打开后，
`f`/`T`/`A` 三个对象都在、切线是水平线。

最近一次结果：

| 检查 | 结果 |
|---|---|
| 数学判据 `f(x)=x^3-3x` + `Tangent(1,f)` | 通过，读回 `T: y = -2`，图里切线为水平线 |
| 输出尺寸 = 请求尺寸 × dpi/96 | 通过（1000×700@150dpi → 1563×1093） |
| 错误命令 `Tangent(f,1)` | 通过：`ok:false` 并点名该命令，**不生成文件** |
| 连续 3 次调用 | 通过，插件专属 msedge 进程 0 → 0 |
| 调用前后前台窗口标题 | 通过，完全一致 |
| 透明背景 | 通过（88% 像素透明） |
| `ggb_eval` | 通过，只回结果不出图 |
| `.ggb` 产出（ZIP 魔数）+ 同名 .png | 通过：4364 字节 ZIP，PNG 同步生成 |
| `.ggb` 能被 GeoGebra 打开（往返） | 通过：重新载入后对象 `f, T, A` 齐全，值 `T: y = -2`，画面与原始一致 |
| `lab_verify_plugin` 验证舱 | 通过（LAB-OK，阻塞 0，34 项里唯一未过的是实验舱自身的 `boot-transport` 说明项） |
| 装机重启后真实工具调用 | 通过：`ggb_draw` 出图 1563×1093、`ggb_eval` 回 `T: y = -2`、错误命令报错且不落文件 |

> 装机后第一次真实调用踩到一个 bug：`renderToPng` 返回 `dpi` 但 schema 没声明，宿主拒收
> （图已生成，调用方只看到 invalid output）。已用 §5.2 的 `pick()` 白名单修掉。

## 8. 文件清单

```
dsh-geogebra/
├─ package.json              # 包声明（dsh.bundle.patch + engines.dsh + test 脚本）
├─ cordis.patch.yml          # 挂载声明（name 写包名）
├─ index.js                  # 宿主插件：注册 ggb_draw / ggb_eval + 启动自证
├─ lib/
│  ├─ render.mjs             # 渲染核心：命令 → 无头 Edge → PNG / .ggb 落盘
│  ├─ template.mjs           # HTML 模板（命令注入、关界面、暴露 window.__ggb）
│  ├─ cdp.mjs                # 极简 CDP 客户端（零依赖，Node 自带 WebSocket）
│  └─ png.mjs                # 极简 PNG 编解码（零依赖，透明背景用）
├─ test/
│  ├─ contract.test.mjs      # 契约测试：清单 / 注册 / 输出字段 vs schema
│  ├─ e2e.test.mjs           # 端到端：真起 Edge，验数学判据与 .ggb
│  └─ helpers.mjs            # 测试公用：复制插件 + dsh-tools stub + retry
├─ .github/workflows/ci.yml  # CI：windows-latest，contract → e2e
├─ LICENSE                   # MIT
└─ README.md
```

## 9. 许可

MIT，见 [LICENSE](LICENSE)。

GeoGebra 是 International GeoGebra Institute 的商标；本插件只是用浏览器加载官方 Web 版 applet
来执行命令，不打包、不分发 GeoGebra 的任何代码或资源。
