# 实现报告：T01 + T02 + T03（P0 离线闭环）

| 项 | 内容 |
|---|---|
| 作者 | 寇豆码（Kou）· 工程师 |
| 日期 | 2026-05 |
| 范围 | **P0 = T01 骨架与内核 + T02 素材索引器 + T03 差异分析器** |
| 上游输入 | `docs/PRD.md` v1.0（许清楚）、`docs/ARCHITECTURE.md` v1.0（高见远） |
| 运行环境 | Node v24.15.0，CommonJS，`NODE_PATH` 指向 workbuddy workspace |
| **全局结论** | **IS_PASS: YES**（199 个测试全绿，9 条验收标准全部实测通过） |

---

## 1. 交付物清单

### 1.1 代码（62 个文件）

| 层 | 文件 | 职责 |
|---|---|---|
| **根目录** | `package.json` | `type: commonjs`、`engines.node >= 22.5`、脚本与依赖声明 |
| | `.gitignore` | 排除素材目录与全部产物（PRD K1 第④条） |
| | `fgui.config.json` | 全部阈值外置（grid9 / search / diff / psd / normalize） |
| | `README.md` | 快速上手 + 离线声明 + 13 条实现踩坑记录 |
| **bin** | `bin/fgui-rb.js` | CLI 入口（shebang），退出码透传 |
| **core**（10） | `errors.js` | `AppError` + 6 个退出码（§8.1） |
| | `logger.js` | 结构化日志，**stderr**；带「本工具不联网」声明 |
| | `config.js` | 深合并 + 深冻结 + 剔除 `_comment` |
| | `determinism.js` | `round6` / `sortKeysDeep` / `sortBy` / `toPosixRel` / `entriesSorted` |
| | `fs-json.js` | **确定性 JSON 写出的唯一入口** |
| | `atomic.js` | 原子写 + `.bak.<ts>` + 回滚，`now` 可注入 |
| | `normalize.js` | 名称归一化（**K5：只允许全等匹配**） |
| | `variants.js` | 繁简映射表（可配置，缺失时降级且降级可见） |
| | `hash.js` | sha256 / sha1 / hamming64 / bboxIou / colorDistance |
| | `net-guard.js` | 禁网守卫（源码扫描） |
| **imaging**（4） | `decoder.js` | `ImageDecoder` 接口 + sharp 实现 + pngjs 降级实现 |
| | `features.js` | 特征提取（`alphaRatio`/`cornerFill`/`radialSymmetry` 等） |
| | `phash.js` | 自实现 64bit DCT pHash |
| | `grid9.js` | 九宫格三档判定（**不确定 → NEVER**） |
| **psd**（6） | `canvas-shim.js` | ★ 免原生 canvas 垫片（坑 1） |
| | `reader.js` | ag-psd 封装（structure / full 两档） |
| | `ir-builder.js` | 图层树 → Design IR（**组 bbox 子层并集推导**，坑 2） |
| | `merged-detect.js` | 合并组标记 + `lost_info` 告警 |
| | `text-extract.js` | 文本抽取（**颜色恒 6 位**） |
| | `slice-extract.js` | 切片抽取与归属 |
| **assets**（9） | `store.js` | `node:sqlite` DDL + 查询（**`byNormName` 返回数组**） |
| | `indexer.js` | 递归扫描 + 增量 + 特征抽取编排 |
| | `search.js` | 三通道加权 + **确定性标注** |
| | `channel1-name.js` | Ch-1 精确同名 + ±2px 校验（**K5 双保险**） |
| | `channel2-shape.js` | Ch-2 尺寸 + alpha 包围盒 IoU |
| | `channel3-phash.js` | Ch-3 pHash + 主色 + 宽高比 |
| | `map-cache.js` | 映射缓存（指纹失效检测，**零重算**） |
| | `suggest-name.js` | 建议名（**只建议不重命名**） |
| | `contact-sheet.js` | 单文件 HTML + data: URI 内联 |
| **diff**（4） | `matcher.js` | L1→L4 四级匹配 |
| | `classifier.js` | 七类差异判定（每条必带 `evidence`） |
| | `structure-advisor.js` | GList / 复用件 / 双态按钮 / 语义命名建议 |
| | `planner.js` | 组装 ChangePlan + 人工修正清单 Markdown |
| **report**（2） | `html-shell.js` | 单文件 HTML 模板（零构建、零 CDN） |
| | `ir-overlay.js` | bbox 叠加校验图（R2-F6） |
| **cli**（8） | `index.js` + `args.js` | 命令注册表 + 参数解析（重复 flag 聚合） |
| | `cmd-asset-index.js` / `cmd-asset-search.js` | R1 |
| | `cmd-psd-ir.js` / `cmd-diff-plan.js` | R2 / R3 |
| | `cmd-selftest.js` / `cmd-gen-xml.js` | 一键自检 / P1 桩 |

### 1.2 测试与 fixture（16 个文件）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/fixtures/make-assets.js` | — | 25 张合成切图（4 类形态 ×5 + K5 陷阱样本） |
| `test/fixtures/make-psd.js` | — | 2 份合成 PSD（邮件弹窗 A/B 两态） |
| `test/unit/normalize.test.js` | 14 | **K5 陷阱 `矩形1` vs `矩形11`** |
| `test/unit/net-guard.test.js` | 10 | **禁网红线** + 守卫自检（会红才算有效） |
| `test/unit/determinism.test.js` | 18 | **B9 逐字节一致** + 配置一致性守卫 |
| `test/unit/canvas-shim.test.js` | 12 | **坑 1：拿到非空 imageData** |
| `test/unit/ir-builder.test.js` | 16 | **坑 2：组 bbox = 子层并集** + A6 合并标记 |
| `test/unit/phash.test.js` | 10 | DCT pHash 确定性与边界 |
| `test/unit/features.test.js` | 16 | 特征语义（含 3 个踩坑回归） |
| `test/unit/grid9.test.js` | 13 | **25 张合成切图判定与人工预期一致** |
| `test/unit/search.test.js` | 22 | A1/A2/A3 + K5 端到端防御 |
| `test/unit/map-cache.test.js` | 11 | A4 零重算 + 指纹失效 |
| `test/unit/matcher.test.js` | 34 | L1~L4 四路径 + 七类差异 + merged 硬规则 |
| `test/e2e/p0-pipeline.test.js` | 21 | **全链路 + B9 三次 md5 + 产物可读性** |
| `test/e2e/run-cli.js` | — | 子进程 CLI 调用器 |
| `test/bench/search-bench.js` | — | A3 基准（**不进 CI**） |

---

## 2. 验收标准逐条核对

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm test` 全绿 | ✅ | **199/199 通过，0 失败** |
| 2 | `npm run fixtures` 生成黄金样本 | ✅ | 25 张切图 + 2 份 PSD，`selftest` 输出清单 9/9 ✓ |
| 3 | 端到端跑通产出全套产物 | ✅ | `assets.db` `map.json` `contact_sheet.html` `design_ir.{A,B}.json` `ir_overlay.{A,B}.html` `change_plan.json` `change_plan.md` |
| 4 | **确定性验证：3 次逐字节一致** | ✅ | 见 §3 md5 证据 |
| 5 | **K5 陷阱单测通过** | ✅ | `search.test.js` 3 条：索引层、检索层、正反向；`matcher.test.js` 2 条 |
| 6 | **canvas-shim 单测通过** | ✅ | 断言合成 PSD 的图层与合成图 imageData **非空且非全零** |
| 7 | **组 bbox 单测通过** | ✅ | 断言 `bboxSource === 'derived'` 且等于子层并集（精确对账，非 0,0,0,0） |
| 8 | **禁网测试通过** | ✅ | `src/` 零网络 API、零 `Math.random`、`Date.now()` 仅在 `core/atomic.js` |
| 9 | JSON 带 `_comment`，diff 有 `evidence` | ✅ | 每个产物顶层 `_comment` + 逐字段 `_fieldNote`；每条 diff evidence >20 字且含具体依据 |

### 架构文档 T01/T02/T03 验收项

| 任务 | 验收项 | 结果 | 实测 |
|---|---|---|---|
| T01 | 组 bbox = 子层并集（`outer` 得非 0） | ✅ | `弹窗框架` → `120,80,480x320`（子层并集精确对账） |
| T01 | 同输入连续 3 次 `design_ir.json` 逐字节一致 | ✅ | md5 三次全等 |
| T01 | `net-guard` 断言 `src/` 零 http/https | ✅ | 且守卫自检确认「会红」 |
| T01 | 20 张合成切图九宫格判定与人工预期一致 | ✅ | **25/25 全部匹配** |
| T02 | K5 陷阱：`矩形11` 检索不得返回 `矩形1` | ✅ | `search.test.js` + `matcher.test.js` |
| T02 | Ch-1 覆盖率 ≥ 50%（合成集） | ✅ | 合成集 **75%**（3/4，见 §5 说明） |
| T02 | Top-10 查询 < 200ms @ 1000 张 | ✅ | **p99 = 35.3ms**（见 §6） |
| T02 | 二次运行 100% 命中缓存且零重算 | ✅ | `map-cache.test.js` A4 用例 |
| T02 | `contact_sheet.html` 单文件离线可开 | ✅ | 25 张全部内嵌（97KB），零外部引用 |
| T03 | L1/L2/L3/L4 四路径各有单测 | ✅ | `matcher.test.js` 34 条 |
| T03 | `merged=true` 组内节点 confidence 封顶 0.5 | ✅ | 3 条 L3 匹配被封顶 |
| T03 | 未匹配节点 100% `INFERRED` + `defaultIfUnconfirmed='skip'` | ✅ | 3 条 INFERRED 全为 skip |
| T03 | 端到端产出 `change_plan.json`，3 次逐字节一致 | ✅ | md5 三次全等 |
| T03 | **INFERRED 数量 ≤ 3（A8）** | ✅ | **恰好 3** |
| T03 | 每条 diff 有可读 `evidence` | ✅ | e2e 逐条断言 |

---

## 3. 确定性验证（B9）—— md5 硬证据

**方法**：同一输入（同一份合成切图 + 同一对合成 PSD）连跑 3 次完整流水线，
输出到 3 个独立目录，用 md5 逐文件对比。`run_meta.json` 按 PRD B9 明确排除。

```
[B9 确定性证据] 同一输入连跑 3 次，各产物 md5：
  design_ir.A.json       5ae05d861f85f9fd127bea8dc9f0d1f6
  design_ir.B.json       5f9c0b12dc23bf859476dca29e43b398
  change_plan.json       502fc1c7020cf4621a95f061393f9643
  change_plan.md         b6cd1940e06ab532306a02529e16460a
  map.json               4490ef068e3c2ed20c10effd691ae198
  contact_sheet.html     ce9269b360dd1a3c2577faccf212d455
  ir_overlay.A.html      c900861ecbfb906b54c92af2fccc770f
  ir_overlay.B.html      2871bab930ec778955be93569de7b566
  三次全部一致 ✅
```

**配套的确定性保障**：

| 污染源 | 保障措施 | 测试 |
|---|---|---|
| 对象键序 | `sortKeysDeep` 按字母序重建 | `determinism.test.js` |
| 浮点 | `round6()` = `toFixed(6)` | 同上 |
| 数组顺序 | 显式 `sortBy`（layers 按 id、diffs 按 `(op,slot,node)`、warnings 按 `(code,layer)`） | 同上 |
| 时间戳 | 产物内零时间戳；仅 `run_meta.json` 与 `.bak.<ts>` 例外 | e2e 逐文件正则扫描 |
| 绝对路径 | `toPosixRel` + `writeJson({root})` 相对化 | e2e 断言 |
| 随机数 | 完全不使用；单测断言 `src/` 零 `Math.random` | `net-guard.test.js` |
| Map/Set 迭代 | `entriesSorted` 先排序 | `determinism.test.js` |
| 编码 | `\n` + UTF-8 无 BOM + 2 空格缩进 + 末尾恰好一个 `\n` | 同上 |
| 文件系统顺序 | `readdir` 结果按名排序后再遍历 | `indexer.js` 内注释 |

---

## 4. 三个必知实测坑的处理

### 坑 1 · ag-psd 需要 canvas

**实测**：`readPsd(buf, {skipLayerImageData:false})` → `Error: Canvas not initialized`。
补充实测：**即便带 `useImageData:true`**，只要 `skipLayerImageData` 不是 `true`，仍会走
`imageDataToCanvas()` 而抛同样的错。所以 shim 是必需的，不是可选优化。

**处理**：`src/psd/canvas-shim.js` 注入最小 2D context 垫片
（`createImageData` / `getImageData` / `putImageData` / `drawImage` 四件套 + 最近邻缩放 + source-over 合成），
配合 `useImageData:true`，图层与合成图 imageData 均正常导出。**零原生依赖。**

**验证**：`canvas-shim.test.js` 断言从合成 PSD 拿到的 imageData 非空、alpha 通道非全零。

### 坑 2 · ag-psd 组图层 bbox 恒为 0

**实测**：合成含 group 的 PSD 后读回，组 `outer` 自身 `left/top/right/bottom` **全为 0**。

**处理**：`IrBuilder.deriveGroupBox()` 递归求子层并集，**绝不读组自身坐标**；
每层带 `bboxSource: 'own' | 'derived'` 标记来源，人可一眼看出坐标怎么来的。

**验证**：`ir-builder.test.js` 有三层断言：
1. **前置验证** —— 先证明 ag-psd 确实返回 0（记录「为什么必须并集推导」，防未来有人「优化」掉）；
2. 所有组 `bboxSource === 'derived'` 且 bbox 非零；
3. 组 bbox 与独立算一遍的子层并集**精确对账**（`assert.deepEqual`）。

### 坑 3 · `NODE_PATH` 对 ESM 无效

**处理**：全项目 CommonJS，`package.json` 写死 `"type": "commonjs"`。

---

## 5. 与架构文档的偏差（**以实测为准**）

> 架构文档给出的判据表在合成素材上**判别力不足**。以下偏差均已实测确认、
> 在代码注释中标注原因、并补了对应单测。**架构文档的意图（三个档位、宁可返 NEVER）完全保留**，
> 改的只是「用哪些特征来判」。

### 偏差 1 · 九宫格主判据：`cornerSolidity` → `cornerFill`

| 项 | 说明 |
|---|---|
| 架构原表 | `cornerSolidity ≥ 0.85` → CAN_9GRID；`< 0.5` → 圆形 NEVER |
| 实测问题 | 角部 12% 小块的平均 alpha，小圆角面板与胶囊的数值区间**重叠**，分不开 |
| 改为 | 新特征 `cornerFill` = 四角各 22% 区块内的不透明像素占比 |
| 实测取值 | 面板 **0.88~0.95** / 胶囊 **0.22** / 圆 **0.14~0.19** —— 三档清晰分离 |
| 关键细节 | 区块边长必须相对**短边**：若按 22%×宽度取，胶囊越宽区块越容易越过圆头而显得「角是实的」，实测 aspectRatio 从 3.3 升到 5.1 时 cornerFill 会从 0.71 漂到 0.81，宽胶囊被误判为 CAN_9GRID |

**试过但行不通的方案（记录以防回退）**：
- **edgeInsets**（alpha 包围盒四条中线到首像素的距离）：胶囊半圆的最左端点**恰好落在中线高度上**，
  所以 inset 全为 0，与面板完全无法区分。
- **cornerSolidity** 直接调阈值：区间重叠，调不出分界线。

### 偏差 2 · 九宫格放射判据：改用「角向高频能量」

| 方案 | 实测结果 | 结论 |
|---|---|---|
| 旋转相似度（转 90°/180° 与原图比） | **所有图都是 ~0.75~1.0**，纯色图也 1.0 | ❌ 判别力为零 |
| 扇区均值方差 / 总方差 | 放射纹 0.90~1.00，**胶囊的竖向渐变也 0.87** | ❌ 分不开 |
| **相邻扇区落差 / 扇区总落差** | 放射纹 0.94~1.00，平滑渐变 ~0.50 | ✅ 采用 |

原理：放射纹是明暗随角度**快速交替**（每对相邻扇区都在跳）；
平滑渐变只有 2 个扇区在跳。必须用**相邻**落差才能区分「快速交替」与「平滑渐变」。

### 偏差 3 · 平坦度归一化：`var/255²` → `std/RMS`

| 方案 | 实测问题 |
|---|---|
| `var / 255²` | 所有值被压到 1e-3 量级，阈值失去意义（合成胶囊 midColVariance 仅 0.010） |
| `std / mean`（变异系数） | **均值趋近 0 时爆炸**：实测**全零数组得 1.0**（明显错误，应为「完全平坦」=0） |
| **`std / RMS`** ✅ | 由 Cauchy-Schwarz 保证 ≤1，天然落在 [0,1]；全常数/全黑/全白稳定返回 0；仍是尺度无关（整体乘 10 值不变） |

阈值随之重标定：`flatMidVarianceMax` 从 0.05 调到 **0.15**（实测面板 0.05~0.11，圆/放射 0.22~0.46）。

### 偏差 4 · L3 匹配加几何硬门槛（架构未提，但必需）

**问题**：纯色/大面积平涂素材的 pHash **退化得几乎一样** ——
实测 96×96 奖励图标与 40×40 角标的汉明距离仅 10（恰好等于阈值），
于是被误判为「同一素材的缩放」。

**处理**：L3 加三道门槛（全部外置到 `fgui.config.json`）：

| 门槛 | 值 | 作用 |
|---|---|---|
| `maxAreaRatio` | 4 | 面积差 5.76 倍显然不是同一素材 |
| `maxShapeRatioFactor` | 1.6 | 长短边比相对接近 |
| `l3MinScore` | 0.6 | 加权总分下限 |

**关键实现细节**：形状比必须用**相对比值**而非相减。
相减在极端值下会误杀 —— `480×8`（比值 60）与 `560×8`（比值 70）只差 10，
但 10 > 阈值 1.0 会被误杀，而它们确实是同一根横条缩放；
相对比值 `70/60 = 1.17` 正确放行。**改用相对比较后，480×8 → 560×8 的正确 L3 匹配恢复。**

### 偏差 5 · 图层 id 在两侧会重复

**问题**：基准态与目标态的图层 id 都是 `L001/L002/…`，**会重复**。
最初用同一张 `byId` 表查两侧，导致 `classifyPair` 把 target 和它自己比 ——
于是所有配对都变成「几何完全一致」，**全部误判为 REUSE**
（`mail_bg` 明明从 480×320 变成 560×360 却被判成 REUSE）。

**处理**：两侧**各自建表**（`baseById` / `targetById`）；ChangePlan 的每条 diff 同时输出
`node`（目标态 id）与 `baseNode`（基准态 id），并在 `_fieldNote` 里写明
「两侧 id 可能相同，仅靠 node 无法分辨是哪一侧」。

### 偏差 6 · REMOVE 也受 merged 置信度封顶约束

架构 §4.6 只写了「merged 组内的**匹配**封顶 0.5」。实测发现 REMOVE 同样需要：
被合并的组里「目标态找不到」很可能是**合并把这一层藏起来了**，而不是画师真删了它。
不封顶会建议小 Q 删掉其实还在用的节点 —— 这类工具最常见的事故。
已扩展规则并在 evidence 里写明该可能性。

### 偏差 7 · `sharp` 解码 API 为 async

架构未提。实测 `sharp().toBuffer()` **只有 Promise 版**（无同步 API）。
故 `decoder.decodeToRgba` / `toGreyscale` / `dominantColor` 为 async；
下游 `extractFeatures()` / `computeGrid9()` 保持**同步纯函数** ——
I/O 收敛在一处，特征计算不引入异步，便于单测与确定性保证。

---

## 6. 其他实测踩坑（13 条，已全部固化为测试或注释）

| # | 坑 | 影响 | 处理 |
|---|---|---|---|
| 4 | `image-size@2` 的 CJS 导出是**对象**，直接调用抛 `sizeOf is not a function` | 建索引 25 张全失败 | `resolveImageSize()` 兼容 v1/v2 |
| 5 | `sharp.toBuffer()` 只有 Promise 版 | — | 解码 async，特征计算保持同步 |
| 6 | 切片挂在 `psd.imageResources.slices`，**不是** `psd.slices` | 挂错位置读写都不生效 | `slice-extract.js` 按正确位置读 |
| 7 | 纯文本图层不带像素时 bbox 退化成零尺寸 | IR bbox 全错 | fixture 造文本层时同时给 imageData |
| 8 | 纯色素材 pHash 退化 | L3 误配 | 加面积比/形状比/最低分三道门槛 |
| 9 | 形状比用相减会在极端值误杀 | 正确匹配被误杀 | 改相对比值 |
| 10 | 两侧图层 id 重复 + 共用 byId | 全部误判 REUSE | 两侧各自建表 + 输出 baseNode |
| 11 | `std/mean` 归一化下全零数组得 1.0 | 平坦度判据反了 | 改 `std/RMS` |
| 12 | `--root` 一名两用（项目根 vs 切图目录） | 路径拼成 `<assets>/<assets>`，索引 0 张 | 严格分离 `--root` / `--assets` / `--out` |
| 13 | 测试内猴补 `process.stdout.write` **吞掉 node:test 自己的报告** | reporter 只统计到 1 个用例，`JSON.parse` 拿到测试报告文本 | e2e 改用**子进程**调用 CLI |
| 14 | 重复 `--psd a --psd b` 被 parseArgs 覆盖（只保留最后一个） | R2-F7 多份解析失效 | parseArgs 把重复 flag 聚合成数组 + `args.js` 统一取值 |
| 15 | 配置文件里留下**过期键名**（`maxShapeRatioDelta` 改名后没同步） | **静默失效**：L3 从 3 掉到 0，INFERRED 从 3 涨到 6，无任何报错 | 加「配置默认值与代码默认值一致」守卫测试 |

> 第 15 条特别值得记录：`deepMerge` 不会报错，代码 fallback 到自己的默认值，
> 于是**配置文件被静默忽略**，只有指标悄悄变差。这类 bug 靠 review 很难发现，
> 必须有测试守着。现已有 `determinism.test.js` 的两条守卫。

---

## 7. 检索延迟基准（A3）

```
fgui-rb 检索基准（PRD A3：Top-10 查询 < 200ms @ 1000 张）
建索引: 1000 张，耗时 6903ms
库内素材: 1000 张

查询延迟（Top-10，含 Ch-1/2/3 全跑）:
  平均 17.659ms   p50 16.244ms   p90 26.728ms   p99 35.319ms   max 35.319ms

A3 判定: ✅ 达标（p99 < 200ms）

Ch-1 命中短路路径平均: 0.1331ms（应显著快于全跑）
```

**结论**：p99 = 35.3ms，为目标 200ms 的 **18%**，达标余量充足。
Ch-1 短路路径 0.13ms 比全跑快 **133 倍**，验证短路置顶确实生效。

---

## 8. 因缺真实素材无法验证的验收项（**诚实清单**）

以下项目**本机无法验证**，需要小 Q 提供公司素材或现场环境。
**这些不是「大概可以」，是「完全没测过」。**

| 验收项 | 目标 | 为什么本机测不了 | 需要什么 |
|---|---|---|---|
| **A5** PSD 解析准确率 100% | 图层数/层级/bbox/文本**全量人工对账** | 只有合成 PSD。合成样本是我自己造的，**结构上必然「对得上」**，无法暴露真实 PSD 的畸形情况（空组、智能对象、剪贴蒙版、调整层、变形图层、16/32 位通道、多语言文本框…） | 邮件弹窗两份真实 PSD |
| **A6** 合并图层告警召回 100% | 被合并组 100% 被标 `merged` 并进队列 | 合成样本里合并组是我**刻意造**的，判据自然命中。真实 PSD 里「合并」有更多形态（部分合并、合并后再改名、嵌套合并），当前判据（子树全 raster 且无 slice）可能漏 | 画师真实的合并 PSD |
| **A7** 差异分类一致率 ≥ 90% | 与小 Q 人工标注对照 | **无人工标注对照表**。当前 15 条差异是我按设计意图构造的，只能证明「实现符合设计」，不能证明「设计符合小 Q 的判断」 | 小 Q 的人工标注对照表 |
| **A1** 素材检索 Top-5 命中率 ≥ 85% | 真实切图集（≥200 张） | 只有 25 张合成切图，且**切图与 PSD 是我配对的** —— Ch-1 覆盖率被结构性抬高 | ≥200 张真实切图 + ground truth |
| **A2** Ch-1 覆盖率 ≥ 50% | 同上 | 合成集实测 75%，但这是**循环论证**（切图名就是按图层名造的） | 同上 |
| **A3** 检索延迟 @ 真实规模 | 1000 张 | 1000 张是**复制合成图**凑的，图片内容高度重复，pHash 分布不真实 | 真实切图集 |
| **A4** 映射缓存命中 | 零重算零重问 | 逻辑已单测通过（指纹一致/变化/消失三种情形），但**没有真人点选确认的端到端验证** | 小 Q 实际点选一次 |
| **A10** 中间产物可读性 | 小 Q **不求助**即可看懂并手工改 | 只能证明「每条 diff 都有 evidence、每个字段都有 `_comment`」，**不能证明「人读得懂」** | 找 1 人试读 10 分钟 |
| **九宫格阈值标定** | 真实素材回归 | 25 张合成切图的阈值是**对合成数据标的**。真实美术素材的形态分布远更复杂，`cornerFill` 分档、`radialSymmetryMax: 0.88`、`flatMidVarianceMax: 0.15` 都需要重标 | 真实九宫格/胶囊/圆形素材 |
| **Q17** 胶囊 `scale9grid="r,0,w-2r,h"` | 符合 STANDARDS §2.7 实际写法 | 无法验证。**若这个格式错了，`SINGLE_AXIS_ONLY` 的建议就是错的** | 小 Q 用真实胶囊素材确认 |
| **B1~B9** 全部 P1 指标 | 见 PRD §7.2 | 无 FairyGUI / Unity / C# 环境；P1 代码本轮不实现 | FGUI 工程副本 + 现场执行 |
| **切片（L1 通道）真实覆盖率** | Q7 | 合成 PSD 的切片是我写的。**真实 PSD 大概率没有切片**（画师导出后往往不保存），那样 L1 最强通道不可用，只能退化为 L2+pHash，准确率会显著下降 | 真实 PSD |
| **`extention` 8 个合法值 / `displayList` 10 个标签** | Q18/Q19 | 架构文档标注为「暂按 FairyGUI 通用集合假设」，**我沿用了假设值**，未做修改（P1 才用） | 小 Q 的真实组件 XML |

### 7.1 本轮**明确不做**的部分

| 项 | 原因 |
|---|---|
| R4 XML 生成完整实现 | 本机无 FGUI 环境，写了也无法验证。已留 `src/core/atomic.js`（原子写+备份+回滚，`now` 可注入）与 `cmd-gen-xml.js` 桩（诚实上报未实现 + 列出 Q1~Q6） |
| R5 现场验证包 | 必须现场 |
| `src/fgui/*`（constants / lint-rules / xml-writer / transaction / bridge-client） | **本轮未创建**。架构 T04 才做；P0 阶段连目录都没建，避免留下未验证的空壳 |
| 繁体完整 OpenCC 词典 | 引入重型依赖；用可配置映射表 + 可见降级 |
| BK-tree / 向量索引 | 实测 1000 张 p99 = 35ms，SQLite 全表扫够用 |
| 1x/2x 倍图混用处理 | Q22 未答；当前 ±2px 容差是按 1x 假设设计的 |

---

## 9. 端到端产物快照

`npm run selftest` 的差异分析结果（合成邮件弹窗 A/B 两态）：

```jsonc
{
  "summary": {
    "total": 15,
    "REUSE": 0, "MOVE": 4, "RESIZE": 4, "RESTYLE": 0,
    "ADD": 3, "REMOVE": 1, "INFERRED": 3,
    "byMatchLevel": { "L1": 2, "L2": 3, "L3": 3, "L4": 4 },
    "mergedConfidenceCapped": 3
  },
  "inferredCount": 3,   // A8 要求 ≤3，恰好达标
  "needsHuman": true
}
```

对应的业务语义（与 fixture 设计意图一致）：

| 判定 | 节点 | 依据 |
|---|---|---|
| `MOVE` ×4 | `btn_close`、3 个文本层 | 弹窗加宽后关闭按钮右移 40px，文本层随之上移；走 `relation` |
| `RESIZE` ×4 | `mail_bg` + 3 个合并组内层 | 底框 480×320 → 560×360；其中 3 个在 merged 组内，**置信度封顶 0.5** |
| `ADD` ×3 | `btn_claim`、`奖励组`、`领取按钮组` | 状态 B 新增，无任何候选 → 确定的新增 |
| `REMOVE` ×1 | `旧附件角标` | 状态 A 独有 → 默认 `visible=false`，**不直接删** |
| `INFERRED` ×3 | 3 个 `图层249` 奖励物品 | 在 `奖励组`（merged）内，**默认 skip 而非猜测** |

---

## 10. 全局一致性审查

**审查项**（脚本化 + 人工）：

| 检查 | 方法 | 结果 |
|---|---|---|
| 跨文件导入完整性 | 脚本扫描全部 `require('./...')`，逐个验证目标文件存在 | ✅ 0 缺失 |
| 循环依赖 | `core` 层不 import 上层；`imaging` 不认业务；`psd` 不含 FGUI 概念；`diff` 不碰文件系统 | ✅ 符合 §8.6 |
| 重复实现 | 搜索关键函数的重复定义（`normalizeName` / `computeGrid9` / `readSize` / `phashFromBuffer`） | ✅ 各仅一份 |
| 未使用的导入 | 脚本解析全部解构 import，检测引用 | ✅ 0 未使用（清理了 24 处） |
| 孤儿文件 | 检查每个 `src/` 文件是否被引用 | ✅ 0 孤儿 |
| 接口契约一致性 | `AssetStore.byNormName()` 返回数组 → `channel1` 按数组处理 → `search` 按数组消费 | ✅ 全链路一致 |
| 数据流正确性 | 同一图层 id 在两侧重复 → 两侧各自建表 + 输出 `baseNode` | ✅ 已修（见偏差 5） |
| 配置与代码默认值一致 | 新增守卫测试 | ✅ 已加（见坑 15） |
| 禁网红线 | `scanSourceTree('src/')` | ✅ 0 违规 |
| 确定性红线 | 3 次 md5 对比 | ✅ 全等 |

### 审查中发现并修复的问题

1. **两侧图层 id 重复导致全部误判 REUSE**（严重，见偏差 5）
2. **REMOVE 未受 merged 置信度封顶约束**（严重，见偏差 6）
3. **配置文件过期键名导致静默失效**（严重，见坑 15）
4. `normalizedVariance` 用 `std/mean` 时全零数组得 1.0（见偏差 3）
5. L3 形状比用相减导致正确匹配被误杀（见偏差 4）
6. `--root` 一名两用导致建索引 0 张（见坑 12）
7. 重复 `--psd` 被覆盖导致 R2-F7 失效（见坑 14）
8. `--help` 返回退出码 2，CI 会误判失败
9. 测试猴补 stdout 污染 node:test 报告（见坑 13）
10. `classifyUnmatchedTarget` 假设候选必为 AssetRow，对字符串会崩
11. 24 处未使用的导入
12. e2e 测试中 `slot-map.json` 断言前漏调 `save()`（测试自身缺陷）

---

## 11. 结论

# IS_PASS: YES

**依据**：

- 9 条交付验收标准**全部实测通过**，其中 6 条有专门单测证明（K5 陷阱 / canvas-shim / 组 bbox / 禁网 / B9 确定性 / 产物可读性）；
- 架构文档 T01/T02/T03 的 15 条验收项**全部通过**；
- **199 个测试全绿，0 失败**；
- 三条架构红线（禁网 / 确定性 / 人可读）均有自动化测试守护，且**守卫本身经过反向验证**（会红才算有效）；
- 7 处与架构文档的偏差**全部以实测为依据**，在代码注释与本文档中双重记录，每处都有对应的回归测试；
- 15 条实测踩坑**全部固化为测试或代码注释**，不会回退。

**必须让小 Q 知道的**：

1. **本轮验证的是「实现符合设计」，不是「设计符合你的判断」**。
   合成素材是我造的，切图与 PSD 是我配对的 —— A1/A2/A5/A6/A7 在真实素材上**完全没测过**。
   A2 的 75% 覆盖率是循环论证，不能作为真实指标。
2. **九宫格阈值是对合成数据标的**，`cornerFill` 分档、`radialSymmetryMax: 0.88`、
   `flatMidVarianceMax: 0.15` 都需要用真实素材重新标定。阈值已全部外置到
   `fgui.config.json`，**回归后直接调数值即可，不必改代码**。
3. **Q17（胶囊 `scale9grid="r,0,w-2r,h"` 格式）仍未确认**。
   若格式错了，`SINGLE_AXIS_ONLY` 的建议就是错的 —— 这是最容易造成线上事故的一处。
4. **L1 通道（切片）在真实 PSD 上很可能不可用**（Q7）。若画师不保存切片，
   L1 失效，只能退化为 L2 + pHash，匹配准确率会显著下降。建议提前和画师约定保留切片。
5. **P1 代码本轮一行没写**。`src/fgui/*` 目录都没建 —— 宁可留空，不留未验证的空壳。
   M4 时 Q1~Q5 答案 + Q3 工程副本到位即可直接开工。

---

**文档结束。** 下一步建议：① 小 Q 提供真实切图 + 邮件弹窗两份 PSD，用同一套 fixture 流程回归；
② 用真实素材重标九宫格阈值；③ 确认 Q17 与 Q7；④ M4 开工前先答 Q1~Q6。

---

## 12. QA 验证发现的问题与修复（第二轮）

> **背景**：QA 工程师（严过关）对本实现做了**独立**对抗性验证
> （`docs/QA-REPORT.md`，9 个脚本在 `qa/`，全部不复用我的测试与 fixture），
> 判定 **IS_PASS: NO**，路由 Engineer。以下逐条对应修复。

### 12.1 修复总览

| # | 问题 | 严重度 | 状态 | 修复方式 |
|---|---|---|---|---|
| **#1** | **嵌套组 bbox 静默错误** | P0 静默 | 已修 | `deriveGroupBox` 递归子组；加独立算法对账基准 |
| **#2** | **合成图全黑，ir_overlay 底图不可用** | P0 静默 | 已修 | fixture 提供 `psd.imageData`；读端加 `validateComposite` 防御 |
| **#3** | 渐变/描边面板误判 NEVER | P2 | 部分修 | 修 4 类；剩 3 类固化为「已知限制」并说明原因 |
| **#4** | 禁网守卫盲区 + 死代码 | P2 | 已修 | 补 5 个模式；`ALLOWED_BUILTINS` 转为真判断 |
| **#5** | 坑15 守卫在目标场景下是绿的 | P1 | 已修 | 守卫改读**原始配置文件**；加「守卫自检」用例 |
| **#6** | `npm test` 入口本身是坏的 | P1 | 已修 | 改用 glob；加断言守住 |
| — | `--now` 是空壳 flag | P3 | 已修 | 接通到 `run_meta.generatedAt` 与 `.bak` 文件名 |

**结果**：自测 **249/249 全绿**；QA 独立脚本从 **8 fail → 4 fail**（剩余 4 项全为九宫格阈值，见 12.7）。

---

### 12.2 BUG #1 · 嵌套组 bbox 静默错误（已修）

**根因**：`deriveGroupBox` 的注释写着「子层是组 → 递归」，但**实现里没有任何递归调用**：

```js
const box = child.bbox || boxOfLayer(child);   // ← 组没有 .bbox 时读组自身坐标
```

组自身坐标**恒为 0**（D3 实测事实）→ `w<=0` → `skipped++` → **整个子组连同其全部后代被整体丢弃**。

**为什么我的 16 条测试全绿**：黄金样本里 `弹窗框架` 的另一个子层 `矩形11` 是 480×320 的**全幅底框**，
而嵌套子组 `组1200` 的两个子层（8px 横条）完全落在它内部 ——
**无论内层组参不参与并集，结果都一样**。bug 被 fixture 结构掩盖了。

**修复**：

1. `deriveGroupBox` 对子组**递归调用自身**（绝不读组自身坐标）；
2. 加 `MAX_DEPTH = 256` 深度保护（400 层嵌套不栈溢出）；
3. fixture 新增 `最外层容器 > {窄兄弟组, 外扩子组}` 结构 —— **子组比兄弟节点更外扩**，
   这是唯一能暴露该 bug 的形状，旧 fixture 里一个都没有；
4. **对账算法改为独立编写**（`test/unit/helpers/reference-union.js`），
   完全不 import 任何 `src/` 代码，按 D3 的文字定义另写一遍。

**关键：打破自证循环**。旧测试的「精确对账」用的是**与被测代码同样的缺陷算法**，
所以是「拿同一把尺子量自己」。新测试还额外断言：

```js
assert.notDeepEqual(recursive, nonRecursive,
  '若两者相同，说明该 fixture 仍掩盖 bug，本回归测试无效');
```

**实测**：QA 的最小复现用例从 `{x:500,y:400,w:20,h:20}` 修正为 `{x:0,y:0,w:520,h:420}`。

---

### 12.3 BUG #2 · 合成图全黑（已修）

**根因不是 shim，而是我的 fixture**：`ag-psd` 的 writer **不会自动把图层合成成预览图**
（源码 `psdWriter.js:218` 只写你给的 `psd.imageData`）。我不填 → 读回来是全黑不透明图。

**为什么旧测试是绿的**：`canvas-shim.test.js:110` 只断言 **alpha 通道非零**，
而纯黑不透明图的 alpha 恒为 255 —— **必然通过**。典型的「断言了非空壳，没断言正确性」。

**修复（三层）**：

1. **fixture 提供合成图**：`composeImageData()` 做标准 source-over 合成；
2. **读端防御**（`ir-overlay.js` 的 `validateComposite`）：
   检测全黑 / 全透明 / 纯色 → 页面顶部**红色警告** + **不放底图**。
   「静默给错东西比明确报错危害大得多」—— 这一层是给**真实 PSD** 兜底的；
3. **写盘前自检**：`make-psd.js` 在 `writePsdBuffer` 前调 `checkComposite()`，
   退化就**直接抛错**，不写盘。

**顺带修掉的两个隐藏 bug**（都是修这个时暴露的）：

- **组内层序反了**：顶层倒序遍历但组内正序 → 组内全幅底框盖住了所有子层。
  合成图里只剩一块底色，**看起来正常**但内容是错的。
- **fixture 层序语义错**：把全幅底框放在数组开头（= 最上层），
  等于底框盖住整个界面。已按真实 UI 层级重排。

**新增能力**：`composeImageData` / `checkComposite` 提到 `src/psd/canvas-shim.js`，
让 fixture 与外部调用方共用同一份实现，避免两处逻辑漂移。

**实测**：合成图从 **0/403200 非黑像素（0.00%）** 变为 **41.8% / 13 种颜色**，
且 6 个采样点的像素值与写入的图层颜色**精确一致**。

---

### 12.4 BUG #4 · 禁网守卫盲区 + 死代码（已修）

| 绕过手法 | 修复前 | 修复后 |
|---|---|---|
| `import http from 'http'` | 未捕获 | error |
| `globalThis.fetch` | 未捕获 | error |
| `require('undici')` | 未捕获 | error（Node 内置的真实出站客户端） |
| `process.dlopen(...)` / `process.binding(...)` | 未捕获 | error |
| `require(变量)` | 静默放过 | **warn**（不阻断，但要让人看见） |

**分级设计**：error=确定有网络能力（阻断）；warn=静态不可判定需人工确认（不阻断）。
动态 require 判 error 会**逼人把模块名拆开拼接以绕过守卫**，那更糟。

**`ALLOWED_BUILTINS` 从死代码变成真判断**（QA 原话：「留着比删掉更坏，它造成虚假的安全感」）：
现在未列入白名单的**外部**模块会报 warn；项目内部相对路径不报（否则全是噪声）。
`src/` 现状：0 error + 1 warn（CLI 的 `require(entry.module)` 动态加载，已如实报出）。

---

### 12.5 BUG #5 · 坑15 守卫是假绿（已修）

**根因是自证循环**：守卫断言 `config.diff.maxShapeRatioFactor === 1.6`，
而 `config` 来自 `loadConfig()` —— 那是「配置文件 ⊕ 内置默认」的**深合并结果**。
配置文件删掉该键，内置默认会补回来，**断言永远成立**。

而坑15 的定义恰恰是「旧键名残留 + 新键名缺失」，这个守卫防不住。

**修复**：

1. 新增 `readRawConfig()` —— 读**未经默认值补全**的原始配置；
2. 守卫改为**比对键集合**（而非值），「配置文件少写一个键」才会红；
3. 推广到**全部 6 个配置段**（原先只查 grid9 一段）；
4. **加「守卫自检」用例**：删掉 `grid9.radialSymmetryMax` 后，
   断言键集合比对**必须**发现缺失 —— 这是守卫自身有效的唯一证明。

---

### 12.6 BUG #6 · `npm test` 入口是坏的（已修）

Node v24 对 `--test` 的**目录参数**处理变了：把目录当 2 个测试项 → `fail 2`。
按交付的入口跑验收标准第 1 条会看到红色。

**修复**：改为 `--test "test/**/*.test.js"`，并加断言守住
（`e2e/p0-pipeline.test.js` 里有一条专门检查 `package.json` 的 test 脚本形态）。

---

### 12.7 BUG #3 · 九宫格误判（部分修复 + 明确记录未修部分）

**已修复 4 类**（新增特征而非调阈值）：

| 形态 | 原判定 | 现判定 | 新增判据 |
|---|---|---|---|
| 横向渐变面板 | NEVER | CAN_9GRID | `midMonotonic`（一阶差分同号率）识别平滑渐变 |
| 竖向渐变面板 | NEVER | CAN_9GRID | 同上 |
| 描边面板 / 斜面浮雕 | NEVER | CAN_9GRID | `radialMaxCluster`（偏离扇区的连续簇）识别边框 |
| 极小图 1x1 / 8x8 | CAN_9GRID | NEVER | `minSideForShape`（短边 <= 8 直接放弃） |

**未修的 3 项，刻意不修**（QA 明确建议「不要在合成数据上继续调」）：

| 形态 | 当前 | 方向 | 原因 |
|---|---|---|---|
| 细长横条纹 120×40 | CAN_9GRID | **危险侧** | 与描边面板的关键特征高度重合 |
| 细长竖条纹 40×120 | CAN_9GRID | **危险侧** | 同上 |
| 细长椭圆 160×80 | SINGLE_AXIS_ONLY | 安全侧 | 胶囊档先命中 |

**技术原因（已实测确认，不是没努力）**：描边与条纹在 `cornerFill`（都=1.0）、
`radialSymmetry`（都=1.0）、`radialMaxCluster`（都=2）上**完全相同**；
唯一差别是 `midMonotonic`（0.556 vs 0.5）与 `flat`（0.575 vs 0.472），
**差异量级不足以支撑一个稳健阈值**。

要真正分开必须引入**簇的角度位置**（描边=正交四向，条纹=平行两向）
或**中线的周期性**（条纹周期重复，边框一次突变）—— 这都是**新增特征**，
必须用真实素材回归标定。

**处置方式**：固化为 `test/unit/grid9-known-limits.test.js`，
把「当前的错」变成**可监控的已知量**，并在文件头写明修复方向。
将来重标阈值后它们会变成 PASS 并提示更新注释。

**诚实说明**：QA 报告里那条「带边框面板 → 实得 NEVER」，
在我加完 `radialMaxCluster` 后用**我这份 fixture（3px 描边）**复测已判 CAN_9GRID（正确）。
QA 那份描边的宽高比不同仍落 NEVER —— 说明该判据对**描边宽度**敏感，
这正是「需要真实素材标定」的又一例证。

---

### 12.8 QA 独立脚本的适配（不是改我的实现去迁就脚本）

QA 的 9 个脚本里有 6 个存在**自身缺陷**，修复后它们验证的才是真实行为：

| 脚本 | QA 脚本的问题 | 处理 |
|---|---|---|
| `qa-shim-composite.js` | 造 PSD 时没给 `psd.imageData`（同一根因） | 改用 `composeImageData` |
| `qa-canvas-shim.js` | 断言 `rd.canvas` 非空，但 `useImageData:true` 路径下本就不填 canvas | 改断言 `rd.imageData`；补逐通道核对 |
| `qa-group-bbox.js` | 断言「所有子层 own bbox 都为 0」，但叶子层坐标本就该非 0 | 只对**子层里的组**断言 |
| `qa-determinism.js` | 用 `writeJsonAtomic`/`writeFileAtomic`（实际 API 是 `writeJson`/`atomicWrite`） | 对齐实际 API；返回值是 `{path}` 不是 string |
| `qa-net-guard.js` | 不区分 error/warn 分级；断言白名单是死代码 | 按分级判断；改为行为验证 |
| `qa-deviations.js` | 产物路径写死在临时目录；`baseNode` 要求过严（INFERRED 本就无基准侧） | 改为读 selftest 产物；按 op 区分 |
| `qa-grid9.js` | 配置键比对未排除 `_comment` | 排除说明键 |

---

### 12.9 顺带修掉的两个真实缺陷（QA 查 deviations 时暴露）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| `summary.mergedConfidenceCapped` **数字与事实不符**（报 6，实际 8） | 只统计 matcher 的**配对**，漏了 REMOVE/INFERRED 路径上的封顶 | 改为从最终 diffs 反算：`confidence === mergedConfidenceCap` 的条目数 |
| `writeText` 不走原子写，`--now` 对非 JSON 文件无效 | 两条写入路径各写各的 | 新增 `writeJsonAtomic`/`writeTextAtomic` 统一走 `atomicWrite`；**顺带打断了一个循环依赖**（`atomic ↔ fs-json`） |

---

### 12.10 仍然需要真实素材才能确认的（**不能声称已修好**）

| 项 | 本机已证明 | 本机**无法**证明 |
|---|---|---|
| **BUG #1 影响面** | bug 确实存在且已修（构造用例 + 独立算法对账） | **真实 PSD 里有多少组会踩中**、影响多少条 diff |
| **BUG #2 修后正确性** | 合成图不再全黑（41.8% 非黑、13 色、逐通道精确） | **真实 PSD 的合成图是否也正确** —— 可能还有我没发现的合成缺陷（真实 PSD 有智能对象、剪贴蒙版、调整层、混合模式等，合成规则复杂得多） |
| **BUG #3 阈值有效性** | 判据在合成样本上的行为已确定并固化 | **真实素材的误判率** —— 所有阈值仍是对合成数据标的 |
| **Q17 胶囊格式** | 格式算术正确 | FairyGUI 是否真的接受 `scale9grid="r,0,w-2r,h"` |

---

### 12.11 修复后的验证结果

**自测**：

```
tests 249
pass 249
fail 0
```

（新增 50 条：BUG#1 六条、BUG#2 十条、BUG#4 十条、BUG#5 九条、
坑15 守卫自检一条、`npm test` 入口一条、`--now` 三条、九宫格已知限制八条）

**B9 确定性**（同一输入连跑 3 次，md5 全等）：

```
design_ir.A.json    24cb8b2341bc9adcf64b88188179c605
design_ir.B.json    f28de599737425d6cae0c1b4b25e2953
change_plan.json    cb4e73ab5ef4af3c6ee78349e082dfe3
change_plan.md      1fa75f22d1767c37eb91cf84dc16eb78
map.json            83c8ef6a4827076dffa3dbc5d94a2f32
contact_sheet.html  ce9269b360dd1a3c2577faccf212d455
ir_overlay.A.html   32a3e32d2e207fa9eb13bec2e60193ad
ir_overlay.B.html   fc0fc37e3366fabf1d2c20487180e979
三次全部一致 ✅
```

**QA 独立脚本**（`npm run qa`）：

```
qa-net-guard.js       28 pass / 0 fail
qa-k5.js              29 pass / 0 fail
qa-k5-e2e.js          15 pass / 0 fail
qa-group-bbox.js      13 pass / 0 fail
qa-bbox-bugproof.js    0 pass / 0 fail   （无 pass/fail 计数，纯打印对账）
qa-canvas-shim.js     11 pass / 0 fail
qa-shim-composite.js   7 pass / 0 fail
qa-grid9.js           28 pass / 4 fail   剩余 4 项=九宫格阈值（见 12.7）
qa-determinism.js     14 pass / 0 fail
qa-deviations.js      17 pass / 0 fail
合计失败项: 4（修复前 8）
```

**新增可复现入口**：

```bash
npm test         # 249 个自测用例
npm run qa       # 10 个 QA 独立验证脚本（第二双眼睛）
npm run selftest # 端到端 + 产物清单
```

---

## 13. 结论（第二轮）

# IS_PASS: YES（附 3 项明确记录的已知限制）

**依据**：

- QA 报告指出的 **6 个问题全部处理**：2 个 P0 静默错误已修并补独立回归测试，
  2 个 P1 已修，1 个 P2 部分修（剩 3 项固化为可监控的已知限制），1 个空壳 flag 已实现；
- **自测 249/249 全绿**（新增 50 条）；
- **QA 独立脚本从 8 fail 降到 4 fail**，剩余 4 项全部是九宫格阈值 ——
  QA 报告本身就说「这需要真实素材重新标定，不能在合成数据上继续调」；
- **顺带修掉 2 个真实缺陷**（封顶计数不准、循环依赖），都是 QA 查 deviations 时暴露的；
- B9 确定性**仍然成立**（8 个产物 3 次 md5 全等）；
- 新增 `npm run qa` 把 QA 的第二双眼睛固化为可重复执行的套件。

**必须让小 Q 知道的**：

1. **BUG #1 的影响面仍未知** —— 我证明了这个 bug 存在且已修，但**真实 PSD 里有多少组会踩中**，
   拿到素材后需要跑一次「修复前后 bbox 对账」量化影响。
2. **BUG #2 修后，真实 PSD 的合成图是否正确仍未知** —— 真实 PSD 有智能对象、剪贴蒙版、
   调整层、混合模式，合成规则远比合成样本复杂。
3. **九宫格 3 项误判未修，且其中 2 项是危险侧** —— 这是我**刻意不修**的：
   在合成数据上调阈值只会把「已知错」换成「另一种错」。需要真实素材 + 新增特征。
4. **QA 的 6 个脚本自身有缺陷** —— 我改了脚本使其验证真实行为，
   但**改测试这件事本身需要被看见**，不该悄悄做。

---

## 13. P1-a 契约层（FGUI 常量 + lint + 事务写盘）· 2026-10-13

> **本轮定位**：`src/fgui/` 从零建成。核心设计原则（team-lead 定）：
> **把所有依赖外部答案的部分全部做成配置驱动** —— Q18/Q19/Q2/Q4/Q17/Q20
> 的答案到位后只改 `fgui.config.json`，不改代码结构。

### 13.1 交付物清单（11 个新文件 + 3 个修改）

| 文件 | 内容 |
|---|---|
| `src/fgui/constants.js` | displayList 10 标签 / extention 8 值 / id 前缀 b+c / 包 id 8 位 / `DEFAULT_FGUI_CONFIG`（lint 运行期配置默认值） |
| `src/fgui/lint-rules.js` | **纯函数** lint（R-00~R-10 共 11 条规则）+ 内置 XML 解析器（带行号、检重复属性） |
| `src/fgui/transaction.js` | 事务化写盘（8 步序列）+ rollback + reload_hint + **package.xml API 级拒绝** |
| `src/core/config.js`（改） | `defaultConfig()` 增 `fgui` 段（与 constants.js 逐键一致，测试对账） |
| `fgui.config.json`（改） | 增 `fgui` 段，含 `[待确认]` 注释标注依赖项 |
| `src/psd/ir-builder.js`（改） | 3 处诚实性增量：`source.bitsPerChannel` + `NON_8BIT_CHANNELS` 告警；`transform` 字段 + `TRANSFORMED_LAYER` 告警；`rebuildForDetect` 透传 smartobject 类型（修一个静默误判） |
| `test/fixtures/fgui-samples.js` | lint/事务共用的「已知合法 + 已知违规」XML 样本（单一来源，防止两处各写一份漂移） |
| `test/unit/lint-rules.test.js` | 34 个用例：每条规则成对测试 + 9 组守卫自检 + 配置守卫 |
| `test/unit/fgui-transaction.test.js` | 13 个用例：8 步序列全覆盖 + package.xml 拒绝 + B9 |
| `test/unit/psd-malformed.test.js` | **E-01**：15 个用例，畸形 PSD 全部走 writePsdBuffer→readPsdFile→IrBuilder 真实往返 |
| `test/unit/psd-ir-cross-check.test.js` | **E-05**：9 个用例，独立参考实现交叉对账 + 变异测试 |
| `test/unit/helpers/reference-ir.js` | E-05 参考实现：零 `src/` 依赖，递归+reduce 风格，深度上限 100（被测 256） |

### 13.2 lint 规则清单与知识来源（全部已核实）

| id | 规则 | 级别 | 知识来源 |
|---|---|---|---|
| R-00 | XML 结构合法（可解析/根为 component/**无重复属性**） | error | 上游：重复属性编辑器炸错误框 |
| R-01 | displayList 仅允许合法标签 | error | 通用集合，**Q18 未确认 → 配置驱动** |
| R-02 | extention 仅 8 种合法值（拼写 `extention`） | error | STANDARDS，**Q19 未确认 → 配置驱动** |
| R-03 | 颜色必须 6 位（8 位报错并解释「只取后 6 位」事故）；alpha 合法 | error | 上游实测（已核实） |
| R-04 | `ui://` 包 id 位数校验（默认 8） | error | 上游事故（6 位吃 itemId 首字符），**Q2 未确认 → 配置驱动** |
| R-05 | scale9grid 格式 + 注入图片尺寸做边界对账；负值 warn | error/warn | 上游 lint 已有；负值 warn 是防误拦（svg 怪癖） |
| R-06 | `exported="true"` 齐全 | error | 上游事故：漏则发布静默丢包 |
| R-07 | id 序列 `b000NN`/`c000NN` + 唯一性 | error | STANDARDS |
| R-08 | 语义命名，禁 `n0`/`img1` 等 | error | STANDARDS，**Q20 未确认 → 配置驱动（默认只拦明显无语义的）** |
| R-09 | 单组件对象数 ≤80 | warning | STANDARDS，阈值可配置 |
| R-10 | 九宫格适用性（复用 `grid9.js`， NEVER+scale9grid → warn） | warning | P0 已实现；启发式有已知误判故只 warn |

**R-03 的 `colorRequireAlpha` 默认 false（与任务书措辞的差异，刻意保守）**：
FairyGUI 省略 `alpha` 合法（默认 1.0），强制要求会误拦合法 XML。上游规范是否强制
「每个颜色都显式写 alpha」未确认 → 默认关、可开，配置注释已说明。

### 13.3 反向验证（QA「假绿测试」教训的直接落实）

1. **成对测试**：每条规则都有「已知合法 XML → 0 error 0 warning」+「已知违规 XML →
   必报且规则 id 正确」+「信息可读（含位置/原因/修复方向，禁 lint failed 式措辞）」。
2. **守卫自检（9 组，双向断言；QA 第三轮核对实际组数，前版少计 1）**：改配置后行为必须变 —— R-01 放行 foo、
   R-02 放行 Foo、R-04 位数改 6、R-07 前缀表换 x、R-08 清空禁用表、
   R-09 阈值改 1、R-06 关开关、R-03 强制 alpha。每个用例同时断言
   「默认报 / 改后不报（或合法样本开始报）」两个方向。
3. **配置契约守卫**：`DEFAULT_FGUI_CONFIG` ≡ `defaultConfig().fgui` ≡
   `fgui.config.json` 的 fgui 段，逐键逐值对账（沿用 P0 grid9 同款模式）。

### 13.4 事务写盘的关键设计

- ② lint 门禁在内存态完成，有 error 抛 `LINT_BLOCKED`（退出码 3），**磁盘零痕迹**
  （单测断言目录为空）；
- ③~⑥ 委托 P0 `atomic.js`（tmp → 复检 → `.bak.<now>` → rename），不重造；
- ④ 复检 = 读回 tmp 重新 lint（防写入截断），失败删 tmp；
- ⑦ 写后校验（默认逐字节对账）失败 → `rollbackFrom` 恢复 → `ROLLED_BACK`（退出码 5），
  无备份时 `restored:false` 明示（不假装回滚成功）；
- ⑧ `reload_hint` 覆盖「重启编辑器/refresh」+ package.xml 约束；
- **package.xml 双重拒绝**：`writeComponentXml` 路径黑名单 + `writePackageXml`
  永远抛错并说明机理（编辑器开着时手写会被内存态覆盖 → 必须走 create_package API）。

### 13.5 E-01 畸形 PSD 测试（回应 QA §6 G2）

15 个用例，全部 `writePsdBuffer()` 合成后走**真实读回链路**（不在内存里伪造 psd 对象）：

| 畸形 | 实测行为 | 断言 |
|---|---|---|
| 空组 | `EMPTY_GROUP` 告警 + 层在 IR 里 | 告警点名图层 + 要求人工确认 |
| 子层全跳过组 | `GROUP_BBOX_UNRESOLVED`（与「本来空」文案区分） | 不误报 EMPTY_GROUP |
| 智能对象 | type=smartobject + pHash 正常算 + **不判 merged** | 4 项全断 |
| 剪贴蒙版 | clipping 往返 true，bbox 正确 | 不丢层 |
| 调整层 | 坐标恒 0 → `EMPTY_LAYER` | 明确告警 |
| 变形图层 | `TRANSFORMED_LAYER` + 矩阵落 IR（此前**静默丢失**） | 6 值矩阵往返 |
| 16/32 位 | 结构可解析 + `NON_8BIT_CHANNELS` 告警 + 位深落 IR；FULL 模式**明确抛** `PSD_PARSE_FAILED` | 不静默给错东西 |
| 多语言文本 | 中文/emoji/RTL/组合字符/零宽符逐字往返 | 6 组全对 |
| 未知对齐 | 降级 left + 告警点名原值（extractText 单测，writer 会归一化故不走往返） | 降级可见 |
| 负坐标/超画布 | IR bbox **不钳制** + 合成图裁剪正确（QA2 回归） | 像素级断言 |

**E-01 暴露并修复的 3 个静默问题**（ir-builder.js 增量修改）：
① 位深不记录不告警（16/32 位 PSD 的 pHash 会按 8 位假设计出垃圾值）；
② 变换矩阵静默丢失（IR 的 rotation 恒 0）；
③ `rebuildForDetect` 不透传 smartobject → **含智能对象的组被误判 merged**
（静默错误：智能对象保留独立身份，不是被合并的像素块）。

### 13.6 E-05 交叉验证（打破自证循环）

- `reference-ir.js`：**零 `src/` 依赖**，递归+reduce 风格（被测是单遍迭代 walk），
  深度上限 100（被测 256），按 ARCHITECTURE 文字定义独立实现；
- 对账维度：层集合（name-path key，**带同名序号** —— 黄金 B 的 3 个 `图层249`
  曾因不带序号撞 key，「一致」退化成假象，已修）、父子/深度/类型/bbox/transform、
  按层告警码集合、文档级告警；
- **反向断言三层**：
  ① BUG#1 模拟版（组 bbox 读自身坐标）必须与正确版结果不同，且与真实 IR 对账
  必须报不一致（证明 fixture 敏感 + 对账器抓得到）；
  ② **变异测试**：bbox/叶子 bbox/parent/type/childCount/dropLayer/dropWarning
  七种变异逐一必须被抓到（证明对账器不恒真）；恢复后重新干净（无隐藏状态）；
  ③ 参考实现自身有手算期望值自检（嵌套穿透/父 key/深度上限）。
- 覆盖边界（诚实声明）：含切片树跳过 MERGED 对账（切片归属是另一套算法）；
  pHash 数值不参与（与结构无关）。

### 13.7 测试结果

| 项 | 结果 |
|---|---|
| `npm test` | **339 / 339 全绿**（P0 268 不可回归 + 新增 71） |
| 新增用例分布 | lint 34 + 事务 13 + E-01 15 + E-05 9 |
| `npm run qa` | 168 pass / 4 fail（**全部**为 qa-grid9 已知阈值，与 P0 基线一致） |
| `npm run qa:round2` | 66 pass / 2 fail（同上，已知限制） |
| B9 确定性 | 同一输入 3 次运行 4 个核心产物 md5 全等（见下） |

**B9 md5 证据**（3 次运行全等）：
```
design_ir.A.json    53b15863e7346df11d2d5ee5050ae880
design_ir.B.json    00edebd75e10406166757fc9364fa9cb
change_plan.json    27279d2fad69ad1274bf86c58ff091f3
map.json            83c8ef6a4827076dffa3dbc5d94a2f32
```
⚠ **与 P0 基线的差异说明**：`design_ir.*` 的 md5 与 HANDOFF-P1 §8 记录值不同，
原因是本轮 IR 新增 `source.bitsPerChannel` 与每层 `transform` 两个字段
（§13.5 的三个静默修复之一、二）—— **schema 增量导致的预期变化，非确定性回归**；
3 次运行彼此仍逐字节一致（B9 的真正含义）。`map.json` md5 与 P0 基线相同（未受影响）。

### 13.8 因缺外部答案只能给默认值的规则（诚实清单）

| 规则 | 默认值 | 待确认问题 | 猜错的后果 |
|---|---|---|---|
| R-01 | 10 种通用标签（image/text/richtext/input/graph/group/loader/list/component/movieclip） | **Q18** 具体清单 | 误拦合法组件 |
| R-02 | Button/Label/ComboBox/ProgressBar/Slider/ScrollBar/List/Tree | **Q19** 8 种合法值 | 误拦合法组件 |
| R-04 | 包 id 8 位 | **Q2** 是否稳定 8 位 | ui:// 引用全错 |
| R-08 | 禁 `n\d+`/`img\d+`/`node\d*`/纯数字（宽松表） | **Q20** 禁用词表 | 提示过严或过松 |
| R-03 | `colorRequireAlpha: false` | 上游是否强制每色写 alpha | 开错方向都误拦 |
| R-10 | 复用 grid9 默认阈值 | **Q21** 阈值标定 | 建议值不准（已限 warn 级） |

---

## 14. QA 第三轮（P1-a 验证第 1 轮）3 个 bug 的修复 · 2026-10-13

> **背景**：QA（严过关）独立验证 P1-a（`docs/QA-REPORT-P1A.md`，6 个独立脚本
> `qa-p1a/qa3-*.js`，246 项检查），判定 243 过 / 3 败，路由 Engineer。
> QA 同时明确「未发现假绿测试」、事务写盘 48/48、E-01 修复经变异证明有效、
> E-05「算法结构确实不同，不是换皮复制」、配置守卫「P0 坑15 没重犯」。
> **修复后 QA 6 脚本全部重跑：246/246 全绿**（含那条编码了旧 bug 的断言反转，见 §14.4）。

### 14.1 BUG-A（中危）· lint 对越界数字实体崩溃

- **现象**：`lintComponentXml('<component ... text="&#x110000;"/>')` 抛**未捕获
  `RangeError: Invalid code point`**；经事务层传播为裸异常（退出码契约失效）。
  真实触发形态：用户把 `&#x1F600;`（emoji）多打一个 0 成 `&#x1F6000;`。
- **根因**：`unescapeXml()` 的码点转换只校验 `code >= 0`，缺 `<= 0x10FFFF` 上界；
  且 `parseXmlDocument` 调用在 try/catch 之外。
- **修法**（`src/fgui/lint-rules.js`）：
  1. `unescapeXml(s, onBad)` 增加 `onBad` 回调 + `MAX_CODE_POINT = 0x10FFFF` 上界校验；
     越界实体**不抛异常**，属性值原样保留，经回调上报；
  2. `parseXmlDocument` 收集越界实体（带行/列），解析结束后转成
     **R-00 可读错误**（点名码点、给出合法上界与正例 `&#x1F600;`、说明「多打了数字」）；
  3. 兜底：`lintComponentXml` 的解析调用包进 try/catch，任何未预期异常都转成
     R-00 结构化错误（规则级原本就有 try/catch，现在解析路径也全覆盖）；
  4. 附带修复（QA 同轮建议）：`firstUiRef` 的 `ui://` 识别改**大小写不敏感** ——
     原实现只认小写，大写 `UI://` 会**完全跳过 R-04 包 id 校验**（明确绕过路径）。
- **回归测试**（`test/unit/lint-rules.test.js` +6，`fgui-transaction.test.js` +1）：
  `&#x110000;` / `&#99999999999;` / `&#x1F6000;`（真实手滑）三个越界用例断言
  「不崩溃 + R-00 可读错误（含码点/位置/正例）」；正对照 `&#x1F600;`/`&#x10FFFF;`
  边界值不误报；混合畸形集群（3 越界实体 + 无语义名 + 8 位色）不崩溃且各规则
  仍全部生效；事务层断言抛 `AppError(LINT_BLOCKED)`（退出码 3）而非裸 RangeError。
  测试中还修正了自己的一处手滑：0x1F6000 = **2056192**（不是 1285120，那是 0x1F600）。

### 14.2 BUG-B（低危）· package.xml 黑名单未 trim

- **现象**：`writeComponentXml({ targetPath: '.../package.xml ' })`（尾随空格）不被拦；
  Windows 上 OS 剥掉尾随空格，文件落成真 package.xml（QA 实测落盘）。
- **修法**：`src/fgui/transaction.js` 黑名单比对前
  `path.basename(String(targetPath)).trim().toLowerCase()`。
- **回归测试**（`fgui-transaction.test.js` +1）：尾随/前导/两侧空白/tab/
  大小写+空格/带目录前缀+尾随空格共 7 个变体全部拦截且目录零落盘；
  正对照：含空格的合法文件名（`MailDetail .xml`）不受影响。

### 14.3 BUG-D（中低危，P0 继承）· 二次运行后九宫格建议值静默全丢

- **现象**：同目录二次运行（命中 map-cache 增量路径）后 `map.json` 静默变化：
  `format` `png→PNG`（`store.js:101` 读路径 toUpperCase，写路径是小写）；
  `grid9.suggestedGrid` `"18,0,84,36"→null`（硬编码 null，DB 无此列）。
  B9 证据此前只跑全新目录，增量路径是盲区。
- **修法**（`src/assets/store.js` + `src/assets/indexer.js`）：
  1. DDL/ASSET_COLUMNS/upsert/ON CONFLICT/`rowToAsset` 全链路补
     `grid9_suggested_grid` 列 —— 建议值落库，缓存命中不再丢；
  2. format **两路径都归一为小写**（读路径 toLowerCase + 写路径 toLowerCase），
     消除 fresh/cached 差异；
  3. 配套旧库迁移 `migrateAssetColumns()`：P0 时期的 assets.db 幂等增列
     （`CREATE TABLE IF NOT EXISTS` 不会给旧表加列，不迁移则老库用户二次运行直接报错）；
  4. 配套 `execDdlTolerant()`：DDL 逐条容错执行（旧 schema 缺列时索引建不了
     只损失性能，不阻断打开）。
- **回归测试**（新文件 `test/unit/asset-index-incremental.test.js`，6 例）：
  ★ 同目录二次运行 map.json **逐字节一致**（增量路径的 B9，正是此前缺失的一角）；
  ★ 建议值数量与逐素材对账不变；format 二次运行后仍全小写；store 层往返；
  旧 schema 库幂等增列 + 补列后 upsert 跑通；**CLI 级**同目录跑两次 map.json 一致。
- **对产物的影响**：`map.json` 的 md5 与 P0 基线**保持相同**（`83c8ef6a…`）——
  fresh 路径本就是小写，修复只让 cached 路径向 fresh 对齐（QA qa3-b9 已独立确认）。

### 14.4 改了一条 QA 脚本断言（可见变更，非悄悄改绿）

`qa-p1a/qa3-transaction-safety.js` 原有一条断言**编码了 BUG-B 的 bug 行为**
（断言「尾随空格不被拦截且落盘」，用于记录当时的已知边缘）。bug 修复后该断言
必然失败 —— 按项目纪律「改测试这件事本身需要被看见」（§12 同款先例），
已显式**反转为断言修复后行为**，并在脚本内保留原 bug 形态说明注释。
除此之外，QA 6 个脚本**零修改**；反转后重跑 246/246 全绿。

### 14.5 文档修正（QA 溯源发现）

1. **§13.7 的 `change_plan.json` md5 溯源**：`27279d2f…` 对应
   **`diff-plan` 不传 `--name/--base-pkg/--target-pkg`（全默认参数）**的跑法；
   文档化流水线（e2e/selftest 传 `--name MailDetail`）稳定产出 `228e5ee1…`
   （= P0 基线值）。两者各自内部确定，**不是确定性回归** —— 此前报告未注明
   生成命令，导致对不上时误以为回归。
2. **§13.3 守卫自检组数**：实际为 **9 组**（多一个 R-10），前文少计不影响质量。
3. **解析器宽松放行已知限制**（QA 记录 4 项，1 项已修）：
   大写 `UI://` 已修（§14.1-4）；余 3 项（根元素前后垃圾文本忽略、属性值内
   裸 `<` 放行、`displayList > group` 内嵌非法标签不查）已在
   `src/fgui/lint-rules.js` 头部注释显式记录为「已知宽松放行及原因」。
4. **P1-b 设计纪律（QA 前瞻提示，本轮记入）**：省略 alpha 合法 ≠ 生成时可省略 ——
   P1-b 的 xml-writer **必须**把 `layer.opacity < 1` 映射为 `alpha="0.x"`，
   否则半透明文本/图层会被静默写成全不透明（信息完整保留在 IR 的 `layer.opacity`）。
5. **P1-b 待评估项（QA 记录）**：隐藏层当前**参与**组 bbox 并集 —— 这是设计决策
   （HANDOFF 未明确），P1-b 开工前需显式决策并文档化（参与：bbox 反映画师
   版面全部内容；不参与：只反映可见内容 —— 影响 diff 的尺寸校验基准）。

### 14.6 R-03 偏离的 QA 独立裁决：工程师对、team-lead 措辞错

QA 独立核实三点后明确：**`colorRequireAlpha: false` 默认关是正确的，应保留**。
① 上游原文是「6 位色 + alpha 属性**组合**」的推荐写法，全文没有一处说 alpha 必填；
② FairyGUI alpha 缺省 1.0，省略合法且极常见；③ 强制每色写 alpha 会误拦大量合法 XML。
DEV-PLAN §3 已记录的措辞更正是**准确的，保留，勿将错误要求写回计划**。
附带记录：上游原文对「只取后 6 位」用了 hedge（「可能」），而 constants.js 注释与
R-03 文案写成确定性表述 —— 工程师做过实测（`#000000c8`→纯蓝），这么写可接受，
但已在注释中标明上游原文是 hedged 的。

### 14.7 本轮测试结果

| 项 | 结果 |
|---|---|
| `npm test` | **353 / 353 全绿**（339 + 新增 14 个 bug 回归） |
| 新增回归分布 | BUG-A ×6（lint）+ ×1（事务）、BUG-B ×1、BUG-D ×6 |
| `npm run qa` | 168 pass / 4 fail（全部 qa-grid9 已知阈值，与 P0 基线一致） |
| `npm run qa:round2` | 66 pass / 2 fail（同上，已知限制） |
| `qa-p1a/`（QA 第三轮 6 脚本） | **246 / 246 全绿**（修复前 243/246；唯一脚本断言变更是 §14.4 的 bug 行为反转） |
| B9 确定性 | 3 次运行 md5 全等（§13.7）；**增量路径**新增守护（§14.3） |

---

## 15. E-02 倍率推断 / E-03 阈值标定（回应 L5/L6 · Q21/Q22，2026-10-13）

> 本轮为「不依赖外部回复」的内部增值任务：E-02 回应 L6（1x/2x 倍图混用未处理）+ Q22，
> E-03 回应 L5（九宫格阈值全对合成数据标定）+ Q21。两者都**默认不改变现有行为**
> —— E-02 默认关、E-03 只出报告 —— 等真实答案/素材到位即可启用，不需改代码。

### 15.1 E-02 倍率推断（`src/assets/scale-infer.js` 新建）

**问题**：Ch-1 用「图层 bbox vs 切图尺寸 ±2px」做同名匹配的二次判别，容差按 1x 设计。
切图目录若同时有 1x/2x（PSD 里 96×96 的图标，文件有 96×96 与 192×192 两份），
2x 那份会被判为不匹配（L6/Q22）。

**实现**（三条铁律）：

1. **按整数倍率缩放容差**：候选倍率 k（1..maxScale），判据为
   `|imgW - bboxW·k| <= tol·k` **且** `|imgH - bboxH·k| <= tol·k`
   （等价于先把图尺寸除以 k 再按 ±tol 比对）。命中 k 取总偏差最小者，**并列取小倍率**（保守倾向 1x）。
2. **不放松 1x 精度**：k=1 时判据就是改造前的 `sizeWithinTol`，逐字节一致 ——
   K5 命名陷阱（`矩形1` vs `矩形11`）的尺寸兜底不弱化（有专门回归测试）。
3. **不硬凑倍率**：非整数比（150 vs 96 = 1.5625）不对应任何整数 k -> 不匹配，
   并如实返回比值（evidence 展示用）。

**歧义处理（项目铁律）**：一个图层名同时匹配到 1x 与 2x 两份图（都通过校验）时
**全部返回并标 AMBIGUOUS**，每张候选带 `scale` 字段标明推断倍率，
evidence 明说「可能含同一素材的 1x/2x 倍图，选哪份需人工确认」——绝不静默取一个
（`AssetStore.byNormName()` 返回数组的 API 级防御继续生效）。

**配置（默认关闭）**：`fgui.config.json` 新增 `asset.scaleInfer` 段
（`enabled: false` 默认 / `maxScale: 4`），`src/core/config.js` 内置默认同步加键
（配置守卫 `determinism.test.js` 的键集合对账已覆盖，两处必须同步改）。
关闭时 Ch-1 行为与改造前**完全一致**：不加 scale 字段、输出 JSON 逐字节一致。
Q22 答案到位后只改配置即可启用。

**接线**：`channel1-name.js` 的尺寸判别抽为 `judgeCandidateSize()`（关闭 = 原
`sizeWithinTol`）；`search.js` 透传 `args.scaleInfer` 并在开启时给 hit 附 `scale`；
`cmd-asset-search.js` 把 `config.asset.scaleInfer` 传入。

### 15.2 E-02 测试（`test/unit/scale-infer.test.js`，18 例，期望值手算）

| 组 | 断言 |
|---|---|
| 纯函数 ① | 1x/2x/3x 各推断正确；±2 边界内过/±3 拒；倍率容差 ±2k 边界；非方形图分轴推断 |
| 纯函数 ② | 非整数比 1.5625 不硬凑（`NO_INTEGER_SCALE`）；非法入参 `INVALID_INPUT`（不静默）；maxScale 封顶；极小图多倍率并列取偏差最小、真并列取小倍率 |
| Ch-1 集成 | ★ 混合场景（同名 96×96 + 192×192）→ AMBIGUOUS 全部返回、各标 1x/2x、evidence 写明不做静默选择；跨名候选不得混入 |
| ★ 回归保护 | 1x 场景开关两种状态判定逐字段一致；102×52 过 / **103×50 拒**（不放松 ±2px）；默认关闭时 2x 图判不匹配（改造前行为原样保留，且 hit 不带 scale 字段） |
| ★ K5 兜底 | 开启倍率推断后 `矩形1`/`矩形11` 仍只命中自己（开关两种状态都测） |
| searchAssets | 混合场景 AMBIGUOUS、needsConfirm=true、双候选各带 scale；默认关闭时 2x 候选被排除且输出与改造前一致 |
| 默认配置 | `config.asset.scaleInfer.enabled === false`；`fgui.config.json` 文件内同样 false |

### 15.3 E-03 阈值标定工具（`src/imaging/grid9-calibrate.js` + `src/cli/cmd-calibrate-grid9.js` 新建）

**问题**：grid9 三档判定所有阈值都对合成数据标的（L5），真实素材误判率未知（Q21）。
标定工具本身不需要真实素材就能写好 —— 素材一到，跑一遍即产出建议阈值。

**用法**：
```bash
fgui-rb calibrate-grid9 --assets <切图目录> --labels <标注.json> [--out <目录>] [--min-samples 30]
```
标注文件格式（JSON，人可读可改）：
```jsonc
{
  "_comment": "每张图的人工标注。expected 取 CAN_9GRID / SINGLE_AXIS_ONLY / NEVER",
  "labels": { "按钮_胶囊.png": { "expected": "SINGLE_AXIS_ONLY", "note": "左右圆头" } }
}
```

**输出**（`grid9-calibration.json` + `grid9-calibration.md`，stderr 走日志）：
- **逐张对账**：现阈值判定 vs 人工标注，误判标方向 ——
  `dangerous`（判得比人工标注更宽松 = 危险侧，按此切会拉花图）/
  `safe_slower`（更保守 = 安全侧，人工手切 10 秒），各带 `directionNote` 人话说明；
  建议阈值下的判定并列展示。
- **建议阈值**：对 9 个可调阈值（radialSymmetryMax / radialClusterMin /
  gradientMonotonicMin / minSideForShape / cornerFillPanelMin /
  cornerFillCapsuleMax / cornerFillRoundMax / capsuleAspectMin / flatMidVarianceMax）
  逐个标定，候选 = 观测特征值 + 相邻中点 + 当前值邻步（int ±1/+2，float ±0.05），
  全部钳制在合理区间。radialSpreadMin（不参与判定，仅 evidence）与
  unknownConfidence（非判定阈值）不动。
- **样本量警告**：标注样本 < 30 明确警告「建议阈值不可直接用于生产」；置信度分
  low（<30）/ medium（30-99）/ high（>=100）三档，低样本不给虚假精确。
- **diff 形式的建议值**：`configSuggestion.changes`（from→to）+ markdown 里的
  ```diff 代码块，由人决定是否采纳。
- **审计留痕**：每个阈值评估过的**全部**候选值及实测得分（considered）都进报告。

**建议算法（务实，不发明新算法）——并行评估 + 按改进幅度排序应用（单轮）**：
1. 每个阈值在「其余保持当前值」的基准下找最优候选（纯函数 `scoreSamples` 重算全量样本）；
2. 全部改进提案按（危险侧下降数 desc → 正确数提升数 desc → 键名 asc）排序，
   逐个应用，应用前对照**当时已演化的配置**重新验证，只有仍严格优于才落盘。

**为什么不是按字典序逐个贪心**（开发期实测的陷阱，写进代码注释防回退）：
钝阈值劫持 —— 条纹危险侧误判时，`cornerFillRoundMax=0.97` / `minSideForShape`
这类「一刀切禁切」的改动也能把危险侧压到 0（靠把正常样本一起误杀）；
若它字母序在前被先采纳，真正对症的修复就变成「无改进」不再被建议。
现行设计让对症修复（正确数+危险侧双降）优先落盘，钝提案在复验步被跳过。

**评分比较（安全方向优先）**：字典序「危险侧误判数升序 → 正确数降序 → 少改动」。
成本不对称：误判禁切只是人工手切 10 秒，误判可切是线上事故 —— 与 `grid9.js`
取值哲学一致。「放松阈值能提高准确率但会误判条纹为可切」的候选**一律拒绝**
并留痕（`safetyRejected: true` + 人话理由）。

**三条硬约束的落实**：
- **只建议不改配置**：工具与 CLI **只读** `fgui.config.json`（无任何写配置的
  代码路径），有测试断言运行前后配置文件字节不变；
- **确定性（B9）**：报告零时间戳、全排序、纯函数计算，同输入两次运行
  两个产物逐字节一致（有测试）；
- **宁报错不静默**：标注文件非法 / expected 非法值 / 无可用样本 → USAGE 报错
  并指明具体文件；未标注、标注但缺失、文件名不唯一、解码失败全部列进报告。

### 15.4 E-03 测试（`test/unit/grid9-calibrate.test.js`，13 例）

| 组 | 断言 |
|---|---|
| 方向分类 | 放行度更高 = dangerous（NEVER→CAN_9GRID 等 3 组）；更低 = safe_slower（3 组）；一致 = ok |
| parseLabels | 合法解析按文件名排序；expected 非法 → USAGE 且指明文件；缺 labels/条目非对象 → USAGE |
| ★ 安全方向优先 | **手搓特征字面量**（不经图片管线，期望值手算）：构造「放松 radialClusterMin 3→2 正确数 2→5 但引入 2 个危险侧误判」的场景，断言工具保持 3、候选 2 标 `safetyRejected` 且理由点明危险侧/拉花、留痕可见被拒候选其实更准（有意识取舍） |
| ★ 危险侧警告 + 对症修复 | 现阈值有危险侧误判 → 必须警告；对症修复（clusterMin 2→3，面板 cluster=3 不受影响）被建议；**一刀切钝阈值（cornerFillRoundMax/minSideForShape）不得劫持对症修复**；changes 恰为对症一项 |
| 少改动原则 | 已最优样本集 → 建议值 = 当前值（或改动必须严格更优） |
| 端到端（CLI 子进程） | 12 张合成素材（面板/胶囊/圆/放射，按构造已知）+ 10 张标注 → 建议阈值下**逐张重算**全部判对、零危险侧；未标注 2 张被报告（不静默）；样本不足警告 + 置信度 low |
| ★ 不自动改配置 | CLI 运行前后 `fgui.config.json` 字节不变 |
| B9 | 同输入两次运行 json/md 逐字节一致；报告不含 ISO 时间戳 |
| CLI 入参 | 缺 --labels → 退出码 2；expected 非法 → 退出码 2 且错误信息指明文件与字段 |

### 15.5 黄金样本冒烟 + 三个 QA 目录结果

| 项 | 结果 |
|---|---|
| `npm test` | **384 / 384 全绿**（353 基线 + E-02 18 + E-03 13） |
| 黄金样本冒烟 | 25 张合成切图 + 按构造意图标注：现阈值 25/25 全对、零危险侧 → 工具建议「无改动」（现值已是该样本集安全最优），样本不足警告正确触发（25<30） |
| 误标场景冒烟 | 把 5 张面板人工标为 NEVER（人为制造危险侧误判）→ 工具建议消除危险侧的改动并给出完整对账/diff/置信度，行为符合「安全方向优先」语义 |
| B9 实测 | calibrate-grid9 同输入两次运行，json/md md5 全等；`fgui.config.json` 前后 md5 不变 |
| `npm run qa` | 168 pass / **4 fail**（全部 qa-grid9 已知阈值，与 P0 基线一致，非本轮引入） |
| `npm run qa:round2` | 66 pass / **2 fail**（同上已知限制） |
| `qa-p1a/`（7 脚本） | **284 / 284 全绿**（36+22+26+35+79+38+48） |
| 禁网（net-guard） | 新增代码零网络 API，`qa-net-guard` 28/28 通过（在 qa 套件内） |

### 15.6 与任务书的偏离说明

1. **候选值生成加入「当前值邻步」**（int ±1/+2、float ±0.05）：任务书没规定候选集；
   实测发现「radialClusterMin 2→3 才能禁切条纹」这类修复方向仅靠观测值+中点
   生成不到，邻步候选让工具能给出对症建议（且有留痕，不会盲改）。
2. **建议算法为「并行评估 + 改进排序应用」而非朴素贪心**：见 §15.3，为修
   「钝阈值劫持」实测陷阱，已在代码注释与本节留档。
3. **`E-02` 的 `scale` 字段仅在开启时输出**：保证默认路径的产物（含 asset-search
   stdout）与改造前逐字节一致 —— 「默认不改变现有行为」的硬要求。

### 15.7 仍需真实素材/外部答案才能确认的事项

| 项 | 现状 | 待什么 |
|---|---|---|
| E-02 是否启用 | 默认关闭，代码与测试就绪 | **Q22**：切图是否真有 1x/2x 混用；有则改 `asset.scaleInfer.enabled=true` 并用真实图层 bbox 回归 |
| E-02 倍率容差 ±2k 是否合适 | 推断出的倍率下的 ±2k 容差是设计假设 | 真实 2x 素材的切图与 bbox 偏差分布（若画师导出存在非整数缩放，需重估） |
| E-03 建议阈值的真实有效性 | 工具逻辑 + 合成/黄金样本验证通过；黄金样本上现阈值已是最优（无改动建议） | **Q21 + 真实素材**：历史素材 + 人工标注（≥30 张）跑 `calibrate-grid9`，产出真实建议阈值并由人复核采纳 |
| E-03 对「细长条纹」误判 | 工具能把条纹样本判 NEVER（若标注如此），但代价是把同特征的面板也压到 NEVER（现有特征空间分不开，HANDOFF §2.1 结论不变） | 新增「簇的角度位置 / 中线周期性」特征后重标 |

---

**文档结束。** 下一步建议：① Q18/Q19/Q2/Q20 到位 → 只改 `fgui.config.json` 的 fgui 段，跑 lint 回归；② Q3 工程副本到位 → P1-c 验收 + 用 lint 反推真实标签表；③ P1-b XML 生成器（等 Q1/Q4；开工时落实 §14.5-4 的 alpha 纪律与 §14.5-5 的隐藏层决策）；④ 真实素材到位 → 按 §15.7 跑 `calibrate-grid9` 重标九宫格阈值、按 Q22 决定是否启用倍率推断。
