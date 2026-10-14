# fgui-rb —— FGUI 自动化拼 UI 工具链（Reuse-First）

> **让 AI 先「看懂项目已有的东西」，再动手拼 UI** ——
> 把 FairyGUI 拼装从「逐个对象 × 逐次工具调用」的视觉重建，
> 改造成「存量资产复用 + 差异驱动生成」的批量增量构建。

本项目源于为一位游戏 UI 开发者解决「手动拼 UI 占据大量工时」的真实痛点。
核心思路：**Reuse-First** —— 优先复用已有素材与组件，只对真正的差异做增量生成。

---

## 🔒 离线声明（重要）

**本工具全程本地处理：不联网、不上传素材、不调用任何外部模型或遥测。**

使用者的素材往往是不便外传的美术资产，任何出站请求都是**合规事故**。这不是口头承诺：

- 代码里**没有任何**网络 API 引用（`test/unit/net-guard.test.js` 扫描 `src/` 全量源码，命中即测试失败）；
- 单文件 HTML 产物零外部引用（无 CDN、无外链字体、无远程图片）；
- 每次 CLI 运行都会在 stderr 打印离线声明。

守卫本身也经过反向验证：给它一段含 `require('http')` / `fetch()` / `net.connect()` 的代码，它**必须**报警——
一个从不报警的守卫等于没有守卫。

---

## 快速上手

### 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.5** | 需要内置 `node:sqlite`（Node 22/24 均实测可用） |
| 模块系统 | **CommonJS** | `NODE_PATH` 对 ESM 的 `import` 无效、对 `require` 有效，这是零安装跑起来的前提 |
| 依赖 | `ag-psd` `sharp` `image-size` `pngjs` | 全部已在 `NODE_PATH` 指向的 `node_modules` 中 |

### 快速开始

```bash
git clone https://github.com/ImAg1n33/fgui-toolchain.git
cd fgui-toolchain
npm install          # 依赖：ag-psd / sharp / image-size / pngjs
npm run fixtures     # 生成合成黄金样本（切图 + 两份状态 PSD），无需任何真实素材
npm test             # 全量测试
npm run selftest     # 端到端：合成素材 → assets.db → design_ir → change_plan.json
```

> `selftest` 的产物在 `out/selftest/`：`change_plan.json`（人可读可改的差异计划）、
> `ir_overlay.*.html`（bbox 叠加核对页）、`contact_sheet.html`（素材速查页）。

<details>
<summary>开发环境实录（本仓库的 CI 形式，供对照）</summary>

```bash
cd /d/UItool && \
NODE_PATH="C:/Users/Lee/.workbuddy/binaries/node/workspace/node_modules" \
"C:/Program Files/nodejs/node.exe" bin/fgui-rb.js <命令> [参数]
```

开发机依赖安装在独立的 `NODE_PATH` workspace 而非项目内 `node_modules`，
这是当时 Windows 原生编译受限下的选择；开源后标准 `npm install` 即可，`NODE_PATH` 不是必需。
</details>

### 运行命令（本机实测形式）

`npm` 脚本已内置相同的环境变量要求，可直接 `npm test` / `npm run selftest`。

### 一键自检（不需要任何公司素材）

```bash
npm run fixtures     # 造合成黄金样本：25 张切图 + 2 份邮件弹窗 PSD
npm run selftest     # 跑通全链路，产出全套产物到 out/selftest/
npm test             # 197 个用例，含确定性（B9）与禁网（K1）验证
```

---

## 它做什么

```
切图目录 ──► R1 素材索引器 ──► assets.db + map.json + contact_sheet.html
                            │  三通道检索（Ch-1 同名 / Ch-2 形状 / Ch-3 pHash）
                            ▼
PSD ×N ────► R2 PSD 解析器 ──► design_ir.{A,B}.json + ir_overlay.{A,B}.html
                            │  绝对 bbox + 归一名 + pHash + 切片 + 合并标记
                            ▼
        R3 差异分析器 ────► change_plan.json ★ 人可读可改
                            + change_plan.md（人工修正清单）
```

### 命令

| 命令 | 作用 | 关键产物 |
|---|---|---|
| `asset-index` | 递归扫描切图目录，抽特征 + 九宫格判定 | `assets.db` `map.json` `contact_sheet.html` |
| `asset-search` | 三通道检索 + 人工确认写缓存 | `slot-map.json`（二次运行零重算） |
| `psd-ir` | 解析 PSD → Design IR（支持多份一次解析） | `design_ir.<label>.json` `ir_overlay.<label>.html` |
| `diff-plan` | 两份 IR 的四级匹配 + 七类差异分类 | `change_plan.json` `change_plan.md` |
| `selftest` | 一键跑通全链路 | 全套 |
| `gen-xml` | **[P1 桩]** 诚实上报「未实现 + 缺什么」 | — |

### 退出码（脚本可据此判断能否进下一步）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 未预期异常 |
| 2 | 参数错误 / 功能未就绪 |
| 3 | lint 阻断，未写盘（P1） |
| **4** | **存在未确认 `INFERRED`，产物已生成但不可进下一步** |
| 5 | 写盘事务失败，已回滚（P1） |

---

## 三条不可违背的红线

### 1. 禁网（PRD K1）

素材是公司未公开美术资产。代码里禁用任何网络 API、遥测、外部模型调用。
`src/core/net-guard.js` 在测试期扫描源码，命中即失败。
同时断言 `src/` 中 **`Math.random()` 零引用**、**`Date.now()` 只出现在 `core/atomic.js`**（`.bak.<ts>` 文件名）。

### 2. 确定性输出（PRD B9）

同一输入连跑 3 次，全部产物**逐字节一致**。

| 污染源 | 对策 |
|---|---|
| 对象键序 | `writeJson()` 按键名字母序重建，不依赖插入序 |
| 浮点 | 全部 `round6()` = `Number(v.toFixed(6))` |
| 数组顺序 | 所有输出数组**显式排序**（layers 按 id、diffs 按 `(op, slot)`、warnings 按 `(code, layer)`） |
| 时间戳 | 产物内**零时间戳**；仅 `run_meta.json` 与 `.bak.<ts>` 文件名例外 |
| 绝对路径 | 一律 POSIX 相对化 |
| 随机数 | 完全不使用 |

`--now <iso>` 可注入时间戳，用于 `.bak` 文件名的可复现验证。

### 3. 中间产物人可读（PRD A10）

`design_ir.json` / `change_plan.json` / `map.json` 每个产物都带 `_comment` 与逐字段 `_fieldNote`；
**每条 diff 必带 `evidence`**，写清「为什么这么判」，让人能逐条复核或推翻。

```jsonc
{
  "op": "RESIZE", "slot": "mail_bg", "node": "L002", "matchLevel": "L1", "confidence": 0.9,
  "evidence": "L1 slice 名一致：两侧切片名均为 'mail_bg'，但尺寸有变化（480x320 -> 560x360）…；九宫格适用性判定为 CAN_9GRID（置信度 0.75，四角实心中部平坦），可安全使用常规九宫格拉伸"
}
```

---

## 关键业务规则

### K5 命名陷阱双保险

实际文件名形如 `矩形1`、`矩形11`、`图层249(1)` ——
**`矩形1` 是 `矩形11` 的前缀**，用 `startsWith` / `includes` 必然误匹配。

1. `NameNormalizer` **只允许全等匹配**（`normalizeName(a) === normalizeName(b)`），
   归一化后 `矩形1` !== `矩形11`，是**不同的检索主键**。代码里没有任何前缀/子串匹配。
2. 即便归一化后真同名（`矩形1.png` 与 `矩形1(1).png`），用 **±2px 尺寸校验**二次判别；
   仍歧义则**全部返回并标 `AMBIGUOUS`** 进确认队列，**绝不静默取第一个**。
3. API 层防御：`AssetStore.byNormName()` 的返回类型就是**数组**，
   强制每一个调用方处理歧义——若返回单值，调用方迟早会直接用，歧义就被静默吞掉了。

### Ch-1 精确同名通道（检索策略的地基）

画师在 `图层129` 上画，切出来也叫 `图层129.png` —— 预计覆盖 50~70%。
归一化规则：去 `(1)` 副本后缀、全半角、大小写、空格；繁简用可配置映射表
（`src/core/variants.js`，词典缺失时降级为不转换并在 `evidence` 标注）。

### 检索三通道与加权

`score = 0.5·Ch1 + 0.3·Ch2 + 0.2·Ch3`，Ch-1 命中**短路置顶**。
结果必带 `certainty` 显式标注「同名确定」还是「猜的」：

| certainty | 含义 | 是否需人工确认 |
|---|---|---|
| `exact_name` | Ch-1 唯一命中且尺寸校验通过 | 否 |
| `ambiguous` | 同名但多张都通过尺寸校验 | **是**（全部返回） |
| `guess` | 靠 Ch-2/Ch-3 猜的 | **是** |

### 九宫格适用性三档

| 档 | 判据（实测标定） | 建议 |
|---|---|---|
| `CAN_9GRID` | `cornerFill ≥ 0.7`（四角近方）+ 中部平坦 | 常规九宫格 |
| `SINGLE_AXIS_ONLY` | 横向长条 + `cornerFill ≈ 0.22`（圆头切角） | `scale9grid="r,0,w-2r,h"` |
| `NEVER` | 放射纹理（角向高频）/ 圆（`cornerFill ≤ 0.25`）/ 落在空白区 | **禁切** |

**取值哲学：不确定返 `NEVER`。** 成本不对称——`NEVER` 的后果是人工手切一次（10 秒），
误判 `CAN_9GRID` 的后果是线上圆头按钮被拉成椭圆（事故）。
阈值全部外置在 `fgui.config.json`，引擎师用真实素材回归后可直接调，**不必改代码**。

### 差异四级匹配 + 七类差异

| 级别 | 依据 |
|---|---|
| L1 | `slice.name` 完全一致（最强证据） |
| L2 | 图层名归一化后**全等**一致 |
| L3 | pHash + 尺寸 + 位置（名字被合并/改了就靠这个兜底） |
| L4 | 均不命中 → `INFERRED`，**默认 `skip` 而非猜测** |

`REUSE`（零新增节点）/ `MOVE`（优先 relation）/ `RESIZE`（**先过九宫格适用性**）/
`RESTYLE`（不生成新图，用运行时 color+alpha）/ `ADD`（重复结构→GList+Cell）/
`REMOVE`（默认 `visible=false` 或移 stash，**不直接删**）/ `INFERRED`。

### 合并图层标记

对应「第二份 PSD 只给新增素材分层，重复素材被合并」的业务事实。
被合并的组打 `merged: true` 并输出 `lost_info` 警告进人工确认队列。**漏报 = 后面必猜错。**

`merged` 组内节点的硬规则：
- 只允许 **L3** 匹配（**不走 L1/L2** —— 被合并的组里已经没有分层信息了）；
- 匹配置信度**强制封顶 0.5**（含 REMOVE：被合并藏起来的层看起来就像「被删了」）；
- 匹配失败一律 `L4 → INFERRED`，`defaultIfUnconfirmed = 'skip'`。

### 上游踩坑 → 代码硬约束

| 坑 | 约束 |
|---|---|
| `#RRGGBBAA` 运行时只取后 6 位 → 纯蓝 | 颜色只用 **6 位 + `alpha="0.x"`** 属性；`RESTYLE` 的 evidence 里主动提示此坑 |
| `ui://` 包 id 非 8 位会吃掉 itemId 首字符 | P1 `constants.js` 已定死 `pkgIdLength: 8` |
| `OpenDocument` 静默失败 / 被 unity 裁剪 | **不使用**；P1 探测脚本如实上报但不作为主链路前置 |
| `screenshot` truthy 但不可调用 | **不使用**；改 OS 级截屏 |
| 编辑器开着时手写 `package.xml` 被内存态覆盖 | P1 写盘序列强制「先关编辑器」 |
| `extention` 拼写 | 常量名与字符串均为 `extention`（不加 s），代码注释警示 |

---

## QA 独立验证（第二轮）

QA 工程师用**不复用我任何测试与 fixture** 的 9 个独立脚本做了对抗性验证
（`qa/` 目录下 9 个独立脚本，全部可重复执行），判定 IS_PASS: NO。修复后：

```bash
npm test        # 249 个自测用例（含 50 条新增回归）
npm run qa      # 10 个 QA 独立验证脚本 —— 把「第二双眼睛」固化为可重复执行
```

自测 **249/249 全绿**；QA 脚本从 **8 fail → 4 fail**（剩余 4 项为九宫格阈值，
需真实素材标定，见实现报告 §12.7）。

修复的两个 P0 静默错误（都不报错、结果错，且都落在「人工核对手段」上）：

| Bug | 根因 | 现状 |
|---|---|---|
| **嵌套组 bbox 静默错误** | `deriveGroupBox` 注释写着递归，实现里没有递归；子组被整体跳过 | 已修 + **独立编写的对账算法**（旧测试用的是同一把尺子量自己） |
| **合成图全黑** | `ag-psd` 的 writer 不会自动合成图层，不给 `psd.imageData` 就是全黑图 | 已修 + 读端 `validateComposite` 防御（底图退化时**显式警告而非静默给错**） |

---

## 实现上踩过的坑（都已固化为测试）

| # | 坑 | 处理 |
|---|---|---|
| 1 | `ag-psd` 需要原生 `canvas`，本机装不上 | 自实现 `CanvasShim`（最小 2D context 垫片）+ `useImageData:true`，**零原生依赖** |
| 2 | `ag-psd` 组图层 bbox **恒为 0** | `IrBuilder.deriveGroupBox()`：组 bbox 一律由子层递归并集推导，IR 里用 `bboxSource: 'derived'` 标记来源 |
| 3 | `NODE_PATH` 对 ESM `import` 无效 | 全项目 CommonJS |
| 4 | `image-size@2` 的 CJS 导出是对象，直接调用会抛 `sizeOf is not a function` | `resolveImageSize()` 兼容 v1（直接导出函数）与 v2（`.default` / `.imageSize`） |
| 5 | `sharp.toBuffer()` **只有 Promise 版** | 解码 API 为 async；下游特征计算保持**同步纯函数**（I/O 收敛在一处，便于单测与确定性） |
| 6 | 切片挂在 `psd.imageResources.slices`，**不是** `psd.slices` | 挂错位置读写都不生效；`slice-extract.js` 已按正确位置读取 |
| 7 | 纯文本图层不带像素时 bbox 退化成零尺寸 | fixture 造文本图层时同时给 `imageData`（与 Photoshop 实际行为一致） |
| 8 | 纯色素材 pHash 退化（两个不同尺寸的纯色块汉明距离仅 10） | L3 加**面积比 + 形状比相对门槛**兜住误配 |
| 9 | 形状比用「相减」会在极端值下误杀（60 vs 70 只差 10 却超阈值） | 改用**相对比值**（70/60 = 1.17），同一根横条缩放能正常匹配 |
| 10 | 基准态与目标态的图层 id 会重复（都是 `L001/L002/…`） | 两侧**各自建表**；`node` 与 `baseNode` 成对输出。仅用一张表会让所有配对变成「自己比自己」→ 全部误判 REUSE |
| 11 | `normalizedVariance` 用 `std/mean` 时全零数组会得 1.0 | 改用 `std/RMS`（Cauchy-Schwarz 保证 ≤1，全常数稳定返回 0） |
| 12 | `--root` 一名两用（项目根 vs 切图目录）导致路径拼成 `<assets>/<assets>` | 严格分离为 `--root` / `--assets` / `--out` |
| 13 | 测试内猴补 `process.stdout.write` 会吞掉 node:test 自己的报告 | e2e 改用**子进程**调用 CLI，顺带验证了 bin 入口与退出码 |
| 14 | **配置守卫自证循环**：断言的是「配置文件 ⊕ 内置默认」的合并结果，删键也断言永真 | 守卫改读**原始配置**、比对键集合；再加一条「守卫自检」证明它会红 |
| 15 | **`--now` 是空壳 flag**（`--help` 承诺了但无消费者） | 接通到 `run_meta.generatedAt` 与 `.bak` 文件名；非法值直接报错 |
| 16 | `atomic ↔ fs-json` 循环依赖（表现为 `ensureDir is not a function`） | `atomic.js` 本地实现 `ensureDir`，不反向依赖 |
| 17 | **自己造数据自己验证 = 自证循环** | 关键对账改用独立算法；`qa/` 独立脚本接进 `npm run qa` |

---

## 目录结构

```
D:\UItool\
├─ package.json / .gitignore / fgui.config.json
├─ bin/fgui-rb.js              CLI 入口
├─ src/
│  ├─ cli/                     命令注册表 + 6 个子命令
│  ├─ core/                    确定性内核（logger/errors/config/fs-json/atomic/
│  │                            normalize/hash/determinism/net-guard/variants）
│  ├─ imaging/                 decoder / features / phash / grid9
│  ├─ assets/                  store / indexer / search / channel1-3 / map-cache /
│  │                            suggest-name / contact-sheet
│  ├─ psd/                     canvas-shim / reader / ir-builder / merged-detect /
│  │                            text-extract / slice-extract
│  ├─ diff/                    matcher / classifier / structure-advisor / planner
│  └─ report/                  html-shell / ir-overlay
├─ test/
│  ├─ fixtures/                make-assets.js / make-psd.js（★ 破解无素材死结）
│  ├─ unit/                    9 个单测文件
│  ├─ e2e/                     p0-pipeline.test.js / run-cli.js
│  └─ bench/                   search-bench.js（不进 CI）
└─ docs/                       PRD / ARCHITECTURE / IMPLEMENTATION-REPORT
```

---

## 本轮范围

**P0（R1 + R2 + R3）已完成并全链路自测。**
P1（R4 XML 生成 + R5 现场验证包）本轮**不实现**——
本机无 FairyGUI / Unity / C# 环境，写出的 XML 没有任何办法验证。
`gen-xml` 命令会诚实上报未实现，并列出被小 Q 阻塞的 6 个问题（Q1~Q6）。

完整实测记录（确定性 md5 证据、与架构文档的偏差、哪些验收项因缺真实素材
暂无法验证）见仓库内 `qa/`、`qa-round2/`、`qa-p1a/` 三个独立验证目录——
每个脚本都可重复执行，结论以代码与脚本为准。

---

## License 与致谢

- 本项目以 [MIT](LICENSE) 许可证开源。
- 方案起点是对上游开源项目 [fgui-agent-bridge](https://github.com/2042player/fgui-agent-bridge)（MIT）的二次开发实践，
  `docs/*.baseline` 为该上游源码的参考副本（MIT，版权归原作者）。
- [FairyGUI](https://www.fairygui.com/) 及其编辑器的公开插件 API 是本工具链的操作对象；
  本项目与 FairyGUI 官方无关联。
- 本仓库文档中的切图、PSD 与界面样本**全部为程序合成**（`npm run fixtures` 可重建），
  不包含任何真实项目美术资产。
