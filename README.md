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

CI（`.github/workflows/ci.yml`）在 `ubuntu-latest` + `windows-latest` 上跑
`npm ci → npm run fixtures → npm test → npm run selftest`（Node 22）。
黄金样本不入库（合成即可、且真实素材不得外传），所以 CI 显式先 `npm run fixtures`。

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
npm test             # 405 个用例，含确定性（B9）、禁网（K1）与跨平台路径验证
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
                            ▼
存量 FGUI 工程 ──► project-index ──► project_index.json（工程/资源/组件/引用图/复用）
                            ▼
        gen-xml prepare ────► gen_plan.json ★ 人可读可改（含 SHA-256 指纹）
        gen-xml dryrun  ────► 内存打补丁 + lint + 逐行 diff（对工程零写入）
        gen-xml apply   ────► 事务写盘（漂移校验 + lint 门禁 + .bak + 原子替换 + 回滚）
```

### 命令

| 命令 | 作用 | 关键产物 |
|---|---|---|
| `asset-index` | 递归扫描切图目录，抽特征 + 九宫格判定 | `assets.db` `map.json` `contact_sheet.html` |
| `asset-search` | 三通道检索 + 人工确认写缓存 | `slot-map.json`（二次运行零重算） |
| `psd-ir` | 解析 PSD → Design IR（支持多份一次解析） | `design_ir.<label>.json` `ir_overlay.<label>.html` |
| `diff-plan` | 两份 IR 的四级匹配 + 七类差异分类 | `change_plan.json` `change_plan.md` |
| `project-index` | **只读**解析存量 FGUI 工程（包/组件/资源/引用图/复用） | `project_index.json` |
| `gen-xml` | 生成侧三阶段：`prepare`（出编辑脚本）→ `dryrun`（零写入预演）→ `apply`（事务写盘） | `gen_plan.json` `dryrun_report.{json,md}` `apply_report.{json,md}` |
| `selftest` | 一键跑通全链路 | 全套 |

### 退出码（脚本可据此判断能否进下一步）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 未预期异常 |
| 2 | 参数错误 / **指纹漂移**（prepare 后文件被改动）/ 目标文件找不到 |
| 3 | lint 阻断，**未写盘** |
| **4** | **需要人工介入**：① 人工确认门禁（未确认 `INFERRED` / 未确认的歧义匹配）；② `apply` 缺 `--yes`；③ **构建状态为 `partial`**（有条目被跳过/阻塞/待人工）——`partial` 默认**不算成功**，需加 `--allow-partial` 才放行 |
| 5 | 写盘事务失败，**已回滚** |

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

### 合并图层标记（启发式信号，非硬约束）

对应「第二份 PSD 只给新增素材分层，重复素材被合并」的业务事实。
检测器按**文档是否有切片**分两档（真实 PSD 往往整份无切片，此时「无切片」是常态而非证据）：

| 档 | 判据 | IR 字段 / 告警 |
|---|---|---|
| 强证据 | 文档有切片 + 该组整棵子树全栅格、无文本层/智能对象、无切片 | `merged: true` + `MERGED_LAYER_GROUP`（进人工确认队列） |
| 弱信号 | 文档**无**切片 + 同样形态 | `suspectedMerged: true` + `SUSPECTED_MERGED_GROUP`（info 级提示） |

★ 这两种标记**都不改变匹配路径，只影响未命中去向**（成本不对称：误判为合并会无理放弃
L1/L2 精确匹配，代价高；漏判时真合并组在第二份 PSD 里没有独立子层，L1/L2 本来就会失败，代价低）：

- 组内图层**照常走 L1/L2/L3**（匹配成功，尤其 L1 slice 名一致 / L2 归一名全等，本身就是「未被合并」的证据）；
- 仅 L3（视觉相似，弱证据）命中疑似合并对象时置信度封顶 0.5；
- 未命中且位于 `merged` / `suspectedMerged` 组内的图层进 `INFERRED`（留人工确认）而非 `ADD`；
  `REMOVE` 侧同样压置信度（被合并藏起来的层看起来就像「被删了」）。

> 当前启发式**尚未用真实 PSD 标定误报率** —— 已知限制，见文末。

### 歧义匹配也进人工确认队列

同名多候选时（如目标态有两个 `图标`），匹配器仍确定性取第一个（保证可复现），
但会标 `ambiguous: true` 并在 `candidates` 里**保留全部候选**：
人工在 `change_plan.json` 里把该条目的 `resolved` 设为选定候选 id 后即放行（退出码转 0）。
这是「可放行的人工确认」，不是「有歧义就永远不能进 gen-xml」。

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

QA 工程师用**不复用我任何测试与 fixture** 的独立脚本做了对抗性验证
（现共 `qa/` 9 + `qa-round2/` 6 + `qa-p1a/` 8 = 23 个脚本，全部可重复执行），判定 IS_PASS: NO。修复后：

```bash
npm test        # 405 个自测用例
npm run qa      # qa/ + qa-round2/ + qa-p1a/ 共 23 个独立脚本
```

自测 **405/405 全绿**；QA 脚本剩余 **6 个 fail，全部为九宫格阈值项**
（启发式对合成数据标定，需真实素材重标，见 `fgui.config.json` 的 `grid9` 段与实现报告 §12.7）。

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
| 18 | `path.relative()` 用**宿主 OS** 规则 → Linux 上 `D:\UItool\out` 被当成普通目录名，产物里泄漏绝对路径（Ubuntu CI 才暴露） | `toPosixRel` 按输入形态选 `path.win32` / `path.posix` 规则集（与宿主无关）；跨形态/跨盘符**明确报错**，结果再做「不得是绝对路径」守卫 |

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
│  ├─ unit/                    21 个单测文件（405 个用例）
│  ├─ e2e/                     p0-pipeline.test.js / run-cli.js
│  └─ bench/                   search-bench.js（不进 CI）
└─ docs/                       公开仓库仅保留 ARCHITECTURE.md（内部交接文档不入库）
                               + 上游参考副本 *.baseline
```

---

## 当前范围与已知限制

**已完成：**
- **P0**：切图索引 + PSD 解析 + 差异分析（离线闭环）
- **P1-a**：FGUI 契约层（常量表 / 纯函数 lint / 事务写盘）
- **M1**：只读 FGUI Project Indexer（`project-index`）
- **M2**：`gen-xml` 生成侧三阶段增量构建（prepare → dryrun → apply），含人工确认门禁、SHA-256 防漂移、lint 写盘门禁、`.bak` 备份与失败回滚
- **v0.3-A 真实工程校准**：依据朋友授权的 FairyGUI 6.1.4 真实工程，修正资源引用形态（短 ID / 拼接 `ui://`）与 `exported` 判定（按引用场景），并补齐 lint：R-04 接受两种 `ui://` 风格、R-11 短 ID 登记性校验（**按目标包作用域**，不跨包误判）

全部产物确定性（同输入逐字节一致），`npm test` **544 项全绿**，CI 在 Windows + Linux 双平台通过。

**生成侧的安全约束**（`gen_plan.json` 被定位为"人可编辑"，因此其中一切路径都视为**不可信输入**）：
- 目标路径必须**位于工程根之内**（路径段比较，非字符串前缀），`fs.realpath` 解析符号链接后仍须在根内，且**必须是工程索引中登记的组件 XML** —— 拒绝 `../` 逃逸 / 绝对路径 / 带盘符 / 软链跳出 / 未登记文件；
- 写入前校验 SHA-256 指纹，prepare 之后文件被改动即拒绝写入；
- 构建状态三态 `complete` / `partial` / `failed`：**`partial` 默认不算成功**（退 4），需 `--allow-partial` 显式放行。

**未实现：** R5 现场验证发布包（`gen-xml apply` 的真实编辑器对账）。
本机无 FairyGUI / Unity / C# 环境，**写出的 XML 没有任何办法在真实编辑器里验证**——这是当前最大的可信度边界。

已知限制（诚实清单）：

| 项 | 说明 |
|---|---|
| 九宫格阈值 | 对**合成数据**标定，QA 脚本仍有 6 项阈值 fail；需真实素材重标（阈值全外置在 `fgui.config.json`，不必改代码） |
| `merged` / `suspectedMerged` 启发式 | **尚未用真实 PSD 测量误报率**；设计成「不影响匹配路径、只影响未命中去向」，误报代价已压到最低 |
| 素材索引特征 | pHash 对纯色/大面积平涂会退化（已加面积比+形状比门槛兜底，仍属启发式） |
| 资源引用形态已按真实工程校准 | 依据朋友提供的 FairyGUI 6.1.4 真实工程核对：**同包 `<image>` 用短资源 ID**（`src="q0jse"`，不带 `ui://`）；`ui://` 只出现在 Loader `url` / 列表 `defaultItem` / 字体 `font`，且真实写法是**拼接无斜杠**（`ui://<pkgId><itemId>`）。解析端两种风格都接受；生成端按上表分场景输出 |
| `exported` 按引用场景判定 | 真实工程里 27 张图有 11 张**没有** `exported` 属性却被同包正常引用 → **同包引用放行（发告警）**，跨包公开 `ui://` 才要求 `exported="true"`，未登记一律阻断 |
| 包 id 的落盘位置（**已观察**） | 在朋友提供的 FairyGUI 6.1.4 真实工程里，包 id 写在 **`package.xml` 根节点 `<packageDescription id="mtlga5qj">`** 上。我们的索引对其它格式仍做兼容（从 `ui://` 引用反推）；**图片 ADD 已不需要包 id**（用短 ID），只有跨包 `ui://` 引用才需要，届时取不到就阻断、不降级猜测 |
| z-order 不推断 | 新增节点一律追加到 `displayList` 末尾（= 最上层），并在产物里记录该决策；不猜层级 |
| 控件类型不猜 | 上游策略提示「需人工指定控件类型」时只写入 note，由人在 `gen_plan.json` 里改 `patch.tag` |
| 生成侧验证深度 | lint/事务写盘/三阶段已由单元、接缝（真 `buildGenPlan` → `runDryrun`）与全链路 e2e（含 3 变异 + 回滚 + B9）覆盖，但**未对真实编辑器产物对账** |

验证记录：`test/` 下的单元与 e2e（`test/e2e/gen-xml-pipeline.test.js`、`test/unit/gen-plan-seam.test.js` 等）都可重复执行，结论以代码与测试为准。

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
