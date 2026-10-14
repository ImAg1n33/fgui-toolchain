# QA 报告 · P1-a 契约层独立验证（第三轮）

| 项 | 内容 |
|---|---|
| 作者 | 严过关（Yan）· QA 工程师 |
| 日期 | 2026-10-13 |
| 验证对象 | P1-a FGUI 契约层（`src/fgui/{constants,lint-rules,transaction}.js`、`src/core/config.js`、`fgui.config.json`、`src/psd/ir-builder.js` 3 处增量） |
| 工程师自报 | IS_PASS: YES，`npm test` 339/339 |
| **QA 独立结论** | **部分通过 —— 发现 1 个真 bug（BUG-A，中危）+ 1 个次要 bug（BUG-B，低危）+ 1 个 P0 继承问题（BUG-D，中低危）** |
| **路由判定** | **Engineer**（BUG-A/B 在源码，需工程师修；BUG-D 在 P0 继承代码，建议同轮修或明确排期） |
| QA 独立脚本 | `qa-p1a/qa3-{lint-independent,transaction-safety,e01-mutation,e05-crosscheck,config-guard,b9-determinism}.js`（共 **246 项检查：243 过 / 3 败**，3 败 = BUG-A×2 + BUG-D×1） |

> **方法论声明**：本报告所有 XML 样本、PSD 样本、变异、断言**全部由 QA 独立构造**，
> 未使用工程师的 `test/fixtures/fgui-samples.js`。QA 脚本可重复执行：
> ```bash
> cd /d/UItool && export NODE_PATH="C:/Users/Lee/.workbuddy/binaries/node/workspace/node_modules"
> for f in qa-p1a/qa3-*.js; do node "$f"; done
> ```

---

## 0. 总结论

工程师的 339/339、测试数分布、B9 三运行 md5、E-01 三修复、E-05 交叉独立性、配置守卫有效性——**以上声称全部独立复现属实**。契约层主体质量高：事务写盘 48/48 全过、lint 规则对 QA 全新样本 77/79、配置守卫四种变异全部咬得住、E-01/E-05 变异测试全部按要求变红。

但独立攻击抓到一个**真 bug**：

- **BUG-A（中危，P1-a 源码）**：内置 XML 解析器遇到越界数字实体（`&#x110000;`）直接抛**未捕获的 `RangeError`** —— `lintComponentXml` 崩溃而非报可读 lint 错误，经事务层传播为裸异常（无退出码约定）。用户手滑把 `&#x1F600;` 多打一个 0 就会触发。**这正是项目铁律「宁可明确报错，不要静默给错东西」的反面**。
- **BUG-B（低危）**：`package.xml` 黑名单不拦尾随空格文件名（`'package.xml '`），Windows 上会落成真 package.xml。
- **BUG-D（中低危，P0 继承）**：同目录二次运行（增量缓存）后 `map.json` 静默变化：`format` `png→PNG`、`grid9.suggestedGrid` 被硬编码为 `null` 丢失（`store.js:101/128`，DB 无此列）。B9 证据只覆盖全新目录，这个场景没被看见。

---

## 1. 逐项验证结果

### 1.1 lint 规则有效性（R-00~R-10）—— **部分通过**（77/79，2 败均为 BUG-A）

QA 自建「设置面板」组件（包 id `3f7a91c2`，与工程师样本完全不同）作为合法基准：**0 error / 0 warning / 0 note 通过**。每条规则用「工程师没想到的形态」攻了一遍：

| 规则 | QA 违规形态（工程师样本未覆盖） | 结果 |
|---|---|---|
| R-00 | 属性引号未闭合 / 注释未闭合 / CDATA 未闭合 / XML 声明未闭合 / 文件在标签内结束 / 根层级多出闭合 / 无值属性 / 属性值无引号 / `<1abc>` 非法标签名 / 重复属性同值 / 孤立斜杠 —— 12 种全部抓到 | ✅ |
| R-01 | 大写 `<IMAGE>` / 连字符 `<my-widget>` / `<swf>` 全部抓到；10 种合法标签全放行不误报 | ✅ |
| R-02 | `extention=""` / 小写 `"button"` / 子元素上的 extention 全部抓到；8 种合法值逐一放行 | ✅ |
| R-03 | 3 位缩写 `#FFF` / `#GGGGGG` / `strokeColor` 8 位 / `alpha="1.5"` / `alpha="半透明"` / `alpha="-0.1"` 全部抓到；大写 `#FFFFFF`+`alpha="0"`、省略 color 不误报 | ✅ |
| R-04 | 3 位包 id / 空包 id / 缺 itemId / 空 itemId / loader 的 url 属性全部抓到；嵌套路径 `ui://pkg/a/b/c` 不误报 | ✅ |
| R-05 | 右/下边界 +1 越界、5 个值、浮点值抓到；恰好贴边（760+20=780）、全零、负值只告警不误拦 | ✅ |
| R-06 | `exported="TRUE"` / `"1"` / `""` 全部抓到 | ✅ |
| R-07 | 大写前缀 `B00001` / 4 位序号 / 错误前缀 / 前导空格 / **跨 displayList 重复 id** 全部抓到 | ✅ |
| R-08 | `N5`（大写）/ `node`（无序号）/ `Node7` / 空串 / 纯空白全部抓到；中文名/`n`/`img`/`icon-2x` 不误报（保守表行为符合文档） | ✅ |
| R-09 | 恰好 80 不报、81 报 warning、**跨 displayList 累计 81** 被抓 | ✅ |
| R-10 | QA 自造特征（先经 `computeGrid9` 自检判定，防空转）：CAN_9GRID 不报、NEVER 报 warning、无 features 时 notes 明示 | ✅ |

**误报检查（比漏报更重要）**：合法边缘样本（大写 6 位色 + alpha=0、省略 color、贴边 scale9grid、全零 scale9grid、恰好 80 对象、中文语义名、10 种合法标签、8 种合法 extention、CRLF、BOM+中文+emoji）**全部不误报**。

**发现**：唯一失败是 BUG-A（见 §2）。

**假绿测试扫描结论**：工程师的 lint 测试**未发现恒真断言**。逐条看过：所有 `assert.ok` 都带具体 needle/正则/精确值；无 `catch` 吞异常；配对测试（合法不报 + 违规必报 + 信息可读）是实的；守卫自检双向断言是实的。两处吹毛求疵的记录：① 报告 §13.3 说「8 组守卫自检」，实际文件里有 9 组（多一个 R-10），属文档少计不影响质量；② `配置守卫自检` 测试名说「删掉配置键」但实际只验 `resolveLintConfig` 合并语义——**真正的文件级守卫是上一条测试**，且 QA 用真变异证明了它有效（§1.6）。

### 1.2 内置 XML 解析器—— **部分通过**（1 真 bug + 4 项宽松行为记录）

攻击结果：

| 输入 | 行为 | 判定 |
|---|---|---|
| `&#x110000;` / `&#99999999999;`（越界码点） | **抛未捕获 RangeError，lint 整体崩溃** | **BUG-A** |
| `&#x1F6000;`（用户多打一个 0 的真实手滑） | 同上（经事务层传播为裸 RangeError，非 AppError） | **BUG-A** |
| `&#x10FFFF;`/`&#65;`/`&amp;`/`&lt;` 合法实体 | 正确解析不误报 | ✅ |
| BOM + 中文 + emoji 属性 | 不误报 | ✅ |
| CRLF 行尾 | 不误报 | ✅ |
| 200 层 / 10000 层嵌套 | 不崩不栈溢出（迭代式解析） | ✅ |
| 1MB 单行 | 不崩 | ✅ |
| 空串 / null 入参 | R-00 报错不崩 | ✅ |
| 畸形（未闭合/错配/多闭合/无引号等 12 种） | 全部报对应结构错误带行号 | ✅ |

**宽松行为记录（不崩溃，但 lint 放行了编辑器会拒绝的 XML —— 建议工程师 consciously 接受或收紧）**：
1. `UI://` 大写 scheme 完全跳过 R-04 包 id 校验（`firstUiRef` 只认小写 `ui://`）；
2. 根元素前后的垃圾文本被静默忽略（严格 XML 非法）；
3. 属性值内裸 `<`（`text="a < b"`）被放行（严格 XML 须 `&lt;`）；
4. `displayList > group` 内嵌的非法标签不查（R-01 只查 displayList **直接子级**）。

以上 4 项均为低危（代码注释自述「宽容模式」是有意设计），但**建议在 README/HANDOFF 里显式记录为已知宽松点**，免得将来被当成漏报 bug 反复排查。

### 1.3 事务写盘安全—— **通过**（48/48）

| 场景 | 结果 |
|---|---|
| lint 门禁失败（8 位色） | 抛 LINT_BLOCKED 退出码 3，**目录零痕迹**（无目标/无 tmp/无 bak） |
| tmp 复检失败（verify 抛非 AppError） | 包装为 AppError、tmp 清理、目标 md5 不变、无多余 bak |
| **模拟 rename 失败**（monkeypatch `fs.renameSync`） | 抛 AppError、**原文件 md5 不变**、tmp 清理、.bak 完整留查 |
| 写后校验失败 → 回滚 | ROLLED_BACK 退出码 5、`restored:true`、**回滚后 md5 与原始逐字节一致**、备份完整 |
| 无备份时写后校验失败 | `restored:false` 诚实上报，不假装回滚成功 |
| `.bak` 时间戳 | 注入 now → `Q.xml.bak.20260513T102030123Z`；不同 now → 不同名；不注入 → 真实时间 |
| B9 | 同 now 两次写盘结果对象逐字段一致、备份名一致 |
| package.xml 拦截 | `package.xml`/`Package.XML`/`PACKAGE.xml`/`./package.xml`/`a/b/package.xml` 全部拒绝且未落盘 |
| `writePackageXml` | 无参、带参**永远抛** USAGE 且说明「内存态覆盖」机理 |
| `backup:false` / 自动建目录 / rollback API / assertLintClean | 全部符合契约 |

**唯一例外**：`'package.xml '`（尾随空格）不被拦截（BUG-B，低危，Windows 特有问题——OS 会剥掉尾随空格落成 package.xml）。

### 1.4 E-01 三个静默修复—— **通过**（26/26）

**独立复现**（QA 自造 PSD 走 `writePsdBuffer` 真实往返，含正对照）：
- 正对照：纯 raster 组 `merged=true` + 恰好 1 条 MERGED 告警 → **证明检测器在工作，不是恒假**；
- 纯智能对象组 / 智能对象+raster 混合组 / 文本+raster 组 → 全部 `merged=false`；
- 智能对象 `type=smartobject`、pHash 正常算、组 bbox 由子层正确推导；
- 16 位 PSD：`source.bitsPerChannel=16` 落 IR + NON_8BIT_CHANNELS 告警；
- 旋转文本：6 值矩阵落 IR、值正确（cos30≈0.866025）、TRANSFORMED_LAYER 告警 1 条。

**变异测试**（备份→变异→跑 `psd-malformed`+`psd-ir-cross-check`+`ir-builder` 三个测试文件→恢复）：

| 变异（改回旧行为） | 测试变红 | 恢复后复绿 |
|---|---|---|
| M1 `bitsPerChannel` 恒 8（位深修复回退） | ✅（16/32 位用例红） | ✅ |
| M2 `transformOfLayer` 恒 null（变换修复回退） | ✅（变形文本/智能对象用例红） | ✅ |
| M3 `rebuildForDetect` 丢 smartobject 标记 | ✅（智能对象 merged 用例红） | ✅ |

源文件 md5 还原校验通过；全量 `npm test` 复跑 339/339 确认无残留。

**新静默问题排查**（用 P0「测试绿但行为错」同款方式）：
- 调整层被标 `type=raster`（ag-psd 有 `adjustment` 属性，ir-builder 不读）—— 有 EMPTY_LAYER 告警兜底，**非静默**，可接受；
- 隐藏层参与组 bbox 并集 —— 设计决策，HANDOFF 未明确，**建议 P1-b 评估并文档化**；
- PSD opacity 8 位量化（0.5→0.501961）—— 格式限制，预期行为；
- **前瞻风险（非本轮 bug）**：文本透明度只存在于 `layer.opacity`，`text` 对象无色透明度 —— P1-b 写 XML 时必须把 `layer.opacity` 映射为 `alpha="0.x"`，否则半透明文本会被静默写成全不透明。

### 1.5 E-05 交叉验证独立性—— **通过**（35/35）

| 检查 | 结果 |
|---|---|
| `reference-ir.js` 依赖 | **零 require**（grep 证实，完全不 import 任何模块） |
| 算法独立性 | 参考实现「递归 + reduce」；被测「迭代 + 手动 min/max 比较」；深度上限 100 ≠ 256；不复用 `detectMerged`。**结构确实不同，不是换皮复制** |
| 工程师七种变异 | bbox / bboxLeaf / parent / type / childCount / dropLayer 在黄金 A 上全部被抓；dropWarning 在无切片树上被抓（与工程师 2c 一致） |
| QA 追加变异 | name / depth / transform / 删文档级 NO_SLICE **全部被抓**（工程师没做的四个维度） |
| BUG#1 模拟版 | 与真实 IR 对账报不一致且落在 bbox 上 |
| 「同名兄弟撞 key」修复 | 三个同名兄弟 key 互异；**旧式无序号 key 确实会撞**（证明修复必要）；空名层、含 `#`/`/` 的层名 key 均不撞；端到端对账一致 |
| 参考实现自身 | 三层穿透 bbox 正确、深度 100 截断、确定性，均手算期望值验证 |

**「假一致」路径独立排查结论**：key 方案 `父key/名字#同名序号` 在QA 构造的对抗性层名（空串、`#0`、`a/b`、`x#0`）下**未发现碰撞**——因为父路径必以 `#数字` 结尾，分段可唯一还原。工程师自述的修复充分。

**覆盖边界（诚实记录，非缺陷）**：
1. **定义性风险固有**：参考实现与被测共享同一份 ARCHITECTURE 文字定义。若定义本身错（如「零尺寸叶子应跳过」），两边会一致地错——交叉验证证明的是「实现符合共同解读」，不是「解读符合画师预期」；
2. 深度 100~256 区间的树两边必然不一致（截断 vs 不截断），不可对账（真实 PSD 极少超 10 层）；
3. **黄金样本 A/B 的告警全是 MERGED_LAYER_GROUP，而含切片树上 MERGED 对账被显式跳过**——即黄金样本的「按层告警码」维度实际空转，该维度只由无切片树守护（工程师的 skip 是有文档的设计，但这个覆盖事实值得知道）；
4. `bitsPerChannel`/NON_8BIT_CHANNELS 告警参考实现不预测——该维度只由 E-01 守护，E-05 不兜底。

### 1.6 配置驱动守卫—— **通过**（22/22）

| 检查 | 结果 |
|---|---|
| 守卫断言对象 | **原始配置文件**（`readRawConfig` 读 `fgui.config.json`），**不是合并后对象** —— P0 坑15 的错没有重犯 |
| 变异 A：配置文件删 `maxObjectsPerComponent` | 守卫测试变红（点名键不一致）✅ |
| 变异 B：`pkgIdLength` 8→6 | 变红 ✅ |
| 变异 C：键改名 `idDigits`→`idDigitCount` | 变红 ✅ |
| 变异 D：`constants.js` 默认值 80→81 | 变红 ✅ |
| 每次变异后恢复 | 守卫重新全绿 ✅ |
| 端到端 | `loadConfig` 加载放行 `foo` 的配置 → lint 对 `<foo>` 不再报 R-01；`colorRequireAlpha:true` → 省略 alpha 开始报错。**配置驱动贯穿真实加载路径，不是单元级自嗨** ✅ |

### 1.7 B9 确定性—— **部分通过**（35/36，1 败为 BUG-D）

| 检查 | 结果 |
|---|---|
| 3 次运行到 3 个不同目录（固定 `--now`） | 4 个核心产物 md5 **全等** ✅ |
| 与工程师声称值对比 | `design_ir.A/B`、`map.json` **逐值一致** ✅ |
| `.bak` 污染 | CLI 管线**零 .bak 文件**（`cmd-*-plan/ir/index` 用非原子 `writeJson`，根本不产备份）；同目录重跑仍零 .bak；无 .tmp 残留 ✅ **工程师「B9 比较范围不含 .bak」的说法属实，且真相更彻底——管线压根不产 .bak** |
| schema 增量论证 | `design_ir` 与 P0 基线不同，IR 确有 `source.bitsPerChannel` 与每层 `transform` 字段，source 段差异恰为这一个键；`map.json` 与 P0 基线相同（未受影响）。**「schema 增量 vs 确定性回归」的区分成立** ✅ |
| 零时间戳 + `--now` | 4 个核心产物内无 ISO 时间戳；`run_meta.generatedAt` = 注入值 ✅ |
| **同目录二次运行** | **`map.json` md5 变化（BUG-D）** ❌ |

**证据溯源发现（低危文档项，非 bug）**：工程师 §13.7 的 `change_plan.json` md5（`27279d2f`）无法用文档化流水线复现——QA 实测该值对应 **`diff-plan` 不传 `--name/--base-pkg/--target-pkg`（全默认）**的跑法；文档化流水线（e2e/selftest 传 `--name MailDetail`）稳定产出 `228e5ee1`（恰为 P0 基线值）。两种参数集各自内部确定 → **是报告未注明生成命令的溯源差异，不是确定性回归**。建议工程师在报告里补注命令。

### 1.8 回归基线

`npm test` 339/339 ✅（QA 验证前后各跑一次，变异测试还原后复跑仍 339/339）；`npm run qa` 168/4、`npm run qa:round2` 66/2，失败均为已知九宫格阈值限制（与 P0 基线一致）✅。新增测试数分布 **lint 34 + 事务 13 + E-01 15 + E-05 9 = 71**，与声称逐文件相符 ✅。

---

## 2. Bug 清单（按严重程度排序）

### BUG-A（中危 · P1-a 源码 · 路由 Engineer）

- **现象**：XML 含越界数字实体时 `lintComponentXml` 抛**未捕获 `RangeError: Invalid code point`**。最小复现：
  ```js
  lintComponentXml('<component exported="true"><displayList><text id="b00001" name="t" text="&#x110000;"/></displayList></component>')
  // RangeError: Invalid code point 1114112
  ```
  真实触发形态：用户把 `&#x1F600;`（emoji）多打一个 0 成 `&#x1F6000;`，或写 `&#99999999999;`。
- **根因**：`src/fgui/lint-rules.js` `unescapeXml()` 第 61 行 `String.fromCodePoint(code)` 前只校验 `code >= 0`，未校验上界 `0x10FFFF`；且 `lintComponentXml` 第 855 行的 `parseXmlDocument(xml)` 调用在 try/catch **之外**（规则级 try/catch 兜不到它）。
- **影响**：违背项目铁律「宁可明确报错，不要静默给错东西」——用户得到的是带栈崩溃，不是 `[R-00] 实体 &#x1F6000; 码点越界（第 N 行）` 这样的可读 lint 错误；经 `transaction.js` 传播为裸 RangeError（非 AppError，退出码契约失效）。磁盘不会被动（lint 门禁在写盘前），但 P1-b 把 gen-xml 接上事务层后，这就是用户可见崩溃。
- **修复方向**：`unescapeXml` 校验 `code >= 0 && code <= 0x10FFFF`，越界则原样返回（让 R-00 或专门的实体告警来报）；或将 `parseXmlDocument` 调用包进 try/catch 转成 R-00 错误。
- **测试现状**：工程师的测试**没有覆盖**这个输入（QA 独立构造才发现）。

### BUG-B（低危 · P1-a 源码 · 路由 Engineer）

- **现象**：`writeComponentXml({ targetPath: '.../package.xml ' })`（尾随空格）不被 `PROTECTED_BASENAMES` 拦截；Windows 上 OS 剥掉尾随空格，文件会落成 `package.xml`（QA 已实测落盘）。
- **根因**：`src/fgui/transaction.js` 第 103 行 `path.basename(targetPath).toLowerCase()` 未 trim。
- **修复方向**：`base.toLowerCase().trim()`，或对 basename 做 `replace(/\s+$/,'')` 后再比对。

### BUG-D（中低危 · P0 继承代码 · 建议同轮修或明确排期）

- **现象**：同一输入、同一输出目录，**第二次运行**（命中 map-cache）后 `map.json` 与首次不同：
  - `assets[].format`：`"png"` → `"PNG"`（`src/assets/store.js:101` `toUpperCase()`）；
  - `assets[].grid9.suggestedGrid`：`"18,0,84,36"` → **`null`**（`src/assets/store.js:128` 硬编码 `suggestedGrid: null`；DB schema 无此列 → 缓存命中即**静默丢失**九宫格建议值）。
- **影响**：① 人可读产物 `map.json` 在二次运行后**静默丢掉全部九宫格建议**（format 大小写也变）；② 产物依赖隐藏状态（assets.db 是否存在），违背 B9 精神；③ `diff-plan` 的 `grid9ByLayerId.suggestedGrid` 也走同一条 DB 路径，建议值同样为 null。
- **为什么 QA 两轮 + 工程师自测都没发现**：B9 证据只跑**全新目录**；增量场景（A4 零重算）只断言了「命中缓存、零重算」，没断言「产物内容不变」。
- **修复方向**：store 增列 `grid9_suggested_grid`（或整个 grid9 JSON 列）；format 大小写两路径归一（都小写或都大写）。
- **归属说明**：P0 代码，非 P1-a 引入；但既然发现了，建议在本轮或明确排期修，不要默默带进 P1-b。

---

## 3. R-03 偏离的独立判断（team-lead 措辞错误复核）

**结论：工程师是对的，team-lead 的原措辞是错的。`colorRequireAlpha` 默认 `false` 应保留。**

独立依据：

1. **上游原文**（`docs/UPSTREAM-README.md:174`）：「`#RRGGBBAA` 运行时**可能**只取后 6 位……组件里用 6 位色 + `alpha="0.x"` 属性**组合**」——这是针对「8 位色会渲染错」给出的**推荐组合写法**，全文**没有任何一处**说 alpha 属性是必填；
2. **语义事实**：FairyGUI 的 `alpha` 属性缺省即 1.0（不透明）。省略 alpha 的合法 XML 极其常见（如纯白底框 `color="#FFFFFF"` 不带 alpha）；
3. **误拦代价**：若按原措辞强制「每色必须写 alpha」，lint 会把大量合法组件 XML 判 error —— 这正是「误报比漏报更伤」的典型（用户会觉得工具老拦他，进而不再信任 lint）；
4. **保留可开性**：`colorRequireAlpha: true` 做成配置可开（Q 系列答案若确认上游强制，改配置即可），默认关是正确的保守方向。

**两条附带记录**（不影响判定）：
- 上游原文对「只取后 6 位」用了**可能**（hedge），而 `constants.js` 注释与 R-03 报错文案写成确定性表述「只取后 6 位」。工程师做过实测，这么写可接受，但建议注释里标一下上游原文是 hedged 的；
- **前瞻风险**：省略 alpha 合法 ≠ 生成时可以省略。P1-b 的 xml-writer 从 PSD 生成 XML 时，**必须**把 `layer.opacity < 1` 的层映射为 `alpha="0.x"`（该信息目前完整保留在 IR 的 `layer.opacity`，text-extract 刻意不输出 8 位色是对的），否则半透明文本/图层会被静默写成全不透明 —— 这是生成侧纪律，不是 lint 默认值问题。

DEV-PLAN §3 已记录的措辞更正**准确**，请保留，勿将错误要求写回计划。

---

## 4. 无法验证 / 环境限制项（明确标注，未用合成素材假装验证）

| 项 | 状态 |
|---|---|
| R-01/R-02/R-04/R-08 的**真实**合法集合（Q18/Q19/Q2/Q20） | **无法验证** —— 等朋友答复。当前默认值全部配置驱动且守卫证明在生效，答案到位只改 `fgui.config.json` |
| R-10 九宫格阈值标定（Q21） | 同上，合成数据无法标定 |
| 真实 PSD / 真实 FGUI 工程副本上的端到端 | **无素材**（Q3），本轮所有 PSD 均为 ag-psd 合成真实往返 |
| `writePackageXml` 在真实编辑器开着时的行为 | 无编辑器环境；仅验证 API 级拒绝（设计意图） |

---

## 5. 交付物

| 文件 | 内容 | 结果 |
|---|---|---|
| `qa-p1a/qa3-lint-independent.js` | 独立 XML 样本逐规则验证 + 解析器攻击 + 误报检查 | 77/79（2 败 = BUG-A） |
| `qa-p1a/qa3-transaction-safety.js` | 事务写盘 9 组安全场景 | 48/48 |
| `qa-p1a/qa3-e01-mutation.js` | 独立复现 + 3 变异 + 静默排查 | 26/26 |
| `qa-p1a/qa3-e05-crosscheck.js` | 独立性核查 + 11 种变异 + key 对抗 | 35/35 |
| `qa-p1a/qa3-config-guard.js` | 守卫对象确认 + 4 种真变异 + 端到端 | 22/22 |
| `qa-p1a/qa3-b9-determinism.js` | 3 运行 md5 + 溯源分析 + .bak/now 检查 | 35/36（1 败 = BUG-D） |
| **合计** | | **243/246** |

---

## 6. 给工程师的修复清单（按序）

1. **BUG-A**：`unescapeXml` 码点上界校验（`<= 0x10FFFF`）+ 考虑把 `parseXmlDocument` 包进 try/catch 转 R-00；补测试：`&#x110000;`、`&#x1F6000;`（真实手滑形态）、`&#99999999999;` 必须报可读错误不崩溃；
2. **BUG-B**：`PROTECTED_BASENAMES` 比对前 trim basename；补测试 `'package.xml '` 被拒；
3. **BUG-D**：store 补 `grid9_suggested_grid` 列 + format 大小写归一；补「同目录二次运行 map.json 与首次一致」的回归测试（这正是 B9 在增量场景的空白）；
4. （文档）报告 §13.7 补注 change_plan md5 的生成命令；§13.3 守卫自检组数 8→9；README/HANDOFF 记录解析器 4 项已知宽松行为；HANDOFF 补「隐藏层参与组 bbox」的设计决策说明；
5. （P1-b 备忘）xml-writer 必须映射 `layer.opacity → alpha="0.x"`。

---

## 7. 路由判定（第 1 轮）

**Engineer** —— BUG-A 是交付代码里的真 bug（QA 测试正确、实现错误，符合路由规则）；BUG-B 低危同轮修；BUG-D 为 P0 继承问题，建议同轮修或明确排期，不建议默默带入 P1-b。

**Round 计数**：本轮为 P1-a 验证第 1 轮。工程师修复后 QA 做第 2 轮回归（重跑 `qa-p1a/qa3-*.js` 全绿 + `npm test` 无回归），若仍有残留即按两轮上限记入 Known Issues 收口。

---
---

# 第 2 轮回归 + E-02/E-03 验证（2026-10-14）

| 项 | 内容 |
|---|---|
| 验证对象 | ① BUG-A/B/D 三个修复 ② E-02 倍率推断（`src/assets/scale-infer.js`，默认关）③ E-03 九宫格标定（`src/imaging/grid9-calibrate.js` + `calibrate-grid9` CLI） |
| 工程师自报 | `npm test` 353/353（修复后）→ 384/384（E-02/E-03 加 31 测试） |
| **QA 独立结论** | **全部通过** —— 三个修复经变异测试证明真实有效；E-02/E-03 未发现静默错误；**NoOne** |
| QA 脚本 | `qa-p1a/` 现 8 个脚本共 **340 项检查全部通过**（本轮新增 `qa3-round2-regression.js` 38 项、`qa3-e02-e03.js` 56 项） |

## R2-1. 三个修复的变异测试（表面绿不算修复）

| 变异 | 回退内容 | 结果 |
|---|---|---|
| M-A1 | 去掉 `unescapeXml` 码点上界校验（兜底 try/catch 仍在） | ✅ 4 个 BUG-A 测试变红（具体码点信息断言失败），恢复复绿 |
| M-A2a | 仅去掉 `parseXmlDocument` 兜底 try/catch | ✅ 仍绿 —— 证明**上界校验是主修复**，try/catch 是纵深防御 |
| M-A2b | 完全回退（= 原始崩溃形态） | ✅ 3+ 个 BUG-A 测试变红（含 doesNotThrow），恢复复绿 |
| M-B | basename 去 trim | ✅ BUG-B 测试变红（尾随空格变体漏拦被测试抓到），恢复复绿 |
| M-D1 | store 读路径 format 改回 `toUpperCase()` | ✅ 4 个 BUG-D 测试变红（含增量 map.json 一致性），恢复复绿 |
| M-D2 | suggestedGrid 改回硬编码 `null` | ✅ 3+ 个 BUG-D 测试变红，恢复复绿 |
| M-D3 | `migrateAssetColumns` 改 no-op | ✅ 迁移测试变红（旧库缺列不被补），恢复复绿 |
| M-D4（侦察） | indexer 写路径去 `toLowerCase()` | 绿 —— 现有 fixture 全小写扩展名，**写路径归一无测试守护**（记录为覆盖缺口：`.PNG` 大写扩展名 fixture 缺失；读路径归一仍在，实际风险极低） |

**BUG-D 旧库迁移端到端（QA 亲手造 P0 旧 schema 库）**：
- 手工造「无 `grid9_suggested_grid` 列」的 assets.db → CLI 首次运行成功（迁移生效不报错）；
- 迁移后二次运行 `map.json` == 首次 == **全新库运行**（迁移无损数据）；
- suggestedGrid 保留（>0）。
- `execDdlTolerant` 探针（远古 schema 缺 phash 列）：store 打开**不阻断**、建不成的索引被跳过（只损失性能）——「打开不阻断」成立；但该库 upsert 会抛 `no such column`（「任意旧库都能用」不成立）。现实中不存在比 P0 更旧的库（P0 是首次发布），可接受。

**BUG-A 副作用检查**：
- `name="&#x110000;"` → R-00 抓到、R-08 不因原样实体文本误判（`n&#x110000;0` 不误判为 `n0`）✅
- `firstUiRef` 大小写不敏感：大写 `UI://abc123/x`（3 位包 id）被 R-04 抓到（原绕过路径闭合）；`UI://abcd1234/x`（合法 8 位）不误报；**文本内容里的 `ui://` 不触发 R-04**（只查 src/url/icon/defaultItem 四个属性）✅
- CDATA 内实体文本不误报（字面量语义）✅
- 记录一处小缺口：**无引号属性值**里的越界实体不做码点专报（该值本身已因「未加引号」报 error，文档仍被拦截，无放行风险）——低危记录。
- 工程师自曝的码点算错已更正：测试断言 `0x1F6000 = 2056192` ✅（正确值）。

## R2-2. E-02 倍率推断验证（56 项中 24 项）

| 检查 | 结果 |
|---|---|
| 1x/2x/3x 推断、2x 容差 ±4px 命中/±5px 不命中 | ✅ |
| 非整数倍 1.5625x 拒绝、仅 W 为 2x 拒绝（不硬凑） | ✅ |
| 并列偏差取更小倍率（保守倾向 1x，box2 img3 场景） | ✅ |
| 非法入参（null/零/负/NaN）→ INVALID_INPUT | ✅ |
| **★ k=1 回归保证**：确定性网格 576 组，关闭时 `judgeCandidateSize` ≡ `sizeWithinTol` 且无推断痕迹 | ✅ |
| 开启时 1x 邻域（±3px）判定与改造前一致 | ✅ |
| 同名 1x+2x 开启 → **AMBIGUOUS 全返回**（不静默取一个）；关闭 → 只 1x（L6 旧行为） | ✅ |
| 只有 2x 图：开启命中且 evidence 带倍率说明；关闭不命中 | ✅ |
| 默认 `enabled=false`（config.js 与 fgui.config.json 双侧确认） | ✅ |
| **守卫侦察**：把 fgui.config.json 的 `enabled` 改 true → 有测试变红（配置文件侧有守卫） | ✅ |
| 变异 M-E2a：`judgeCandidateSize` 开关失效 → 测试红 | ✅ |
| 变异 M-E2b：并列 tie-break 反转（取大 k）→ 测试红 | ✅（工程师有覆盖） |
| 变异 M-E2c：config.js 代码默认翻转 → **不变红**（见下方低危缺口） | ⚠ 记录 |

**低危覆盖缺口（记录，不阻塞）**：`config.js` 的代码默认 `scaleInfer.enabled:false` 无测试直接守护 —— 但 fgui.config.json 显式写 false 会遮蔽它（本仓库内行为不变），且配置文件侧有守卫、asset 段顶层键有对账（删整个 scaleInfer 段会红）。残余风险仅「无配置文件环境 + 代码默认被翻转」的组合，极低。

## R2-3. E-03 九宫格标定验证

| 检查 | 结果 |
|---|---|
| QA 自造标注样本（panel×5/capsule×5/circle×5/**stripe×3**）——fixture 自检现阈值确实有 3 个危险侧误判（条纹形态与 HANDOFF §2.1 一致） | ✅ |
| 标定后危险侧不增加；建议阈值不产生**新的**危险侧误判 | ✅ |
| **安全红线**：全 NEVER 样本上，把圆判松的候选全部被安全拒绝或不采纳；建议阈值下圆仍全 NEVER | ✅ |
| 变异 M-E3a：安全比较器回退（忽略危险侧只看正确数）→ 标定测试变红 | ✅（工程师的安全原则测试真实在保护） |
| 样本不足（5<30 / 20<30）→ 警告 + 置信度 low | ✅ |
| 非法标注值 → USAGE 错（宁报错不静默） | ✅ |
| 未标注文件 / 标注了但目录缺失的文件 → 全部列出（不静默跳过） | ✅ |
| **★ 绝不改 fgui.config.json（设计红线）**：CLI 两次运行前后 md5 不变 | ✅ |
| 确定性：同输入两次标定报告逐字节一致（剔除绝对路径输入面后）；产物零时间戳 | ✅ |

## R2-4. 新静默错误排查结果

用 P0「测试绿但行为错」的方式攻击了改动路径，**未发现新的静默错误**。记录的观察项：

1. **M-D4**：indexer 写路径 format 归一无测试守护（现有 fixture 全 `.png` 小写）。建议补一个 `.PNG` 大写扩展名 fixture；
2. **M-E2c**：config.js 代码默认 `scaleInfer.enabled` 无直接测试（被配置文件遮蔽，见上）；
3. **无引号属性值**的越界实体不做码点专报（文档仍被拦截）；
4. **run_meta.json** 增量二次运行差异恰为 `indexed/skipped` 统计字段（25/0→0/25），`generatedAt` 一致 —— 这是文档化预期（B9 明确排除 run_meta），非问题；
5. `contact_sheet.html` 增量二次运行 md5 不变 ✅；`assets.db` 二次运行 md5 不变（记录项，B9 本就不比缓存库）。

## R2-5. ⚠ flaky 测试观察（需工程师留意）

`npm test` 在 QA 的 ~10 次运行中**观察到 1 次失败**（384 中 1 败），随后 8 连跑全绿，未能捕获失败测试名（当时未开全量输出捕获）。怀疑方向：A3 延迟基准（<200ms）在 QA 脚本并发加载（sharp/解码占用 CPU）时毛刺。**建议**：若再现，先记录测试名；A3 类延迟断言可考虑放宽到 p99 分位数或加 retry 容差。本项**不阻塞收口**（非 P1-a 代码问题），但不应被忽视。

## R2-6. 三个 QA 目录结果（最终态）

| 套件 | 结果 | 说明 |
|---|---|---|
| `npm test` | **384/384** ✅ | 含 E-02/E-03 新增 31 测试；QA 观察到 1 次 flaky（见 R2-5） |
| `qa/` | 168 pass / 4 fail | 4 败全为九宫格已知阈值（与 P0 基线一致），**无新增失败** |
| `qa-round2/` | 66 pass / 2 fail | 同上 |
| `qa-p1a/` | **340/340 全过**（8 脚本） | 第 1 轮 6 脚本在修复后全部转绿（BUG-A/BUG-D 检查项从「证 bug 存在」反转为「守修复」，两处断言反转已在脚本内显式留痕） |

## R2-7. 路由判定（第 2 轮）

**NoOne** —— 三个修复经变异测试证明真实有效且测试在保护；E-02/E-03 独立验证未发现静默错误；安全红线（E-03 不建议危险阈值、绝不改配置）实测成立；确定性（含增量路径）成立。三个 QA 目录无新增失败。

**收口备注**（不阻塞，留给工程师的备忘）：
1. `.PNG` 大写扩展名 fixture 缺失（M-D4 侦察）；
2. `config.js` 代码默认 `scaleInfer.enabled` 无直接测试（被配置文件遮蔽，残余风险极低）；
3. flaky 测试观察一次（R2-5），建议下次出现时记录测试名；
4. 解析器宽松行为 4 项与「无引号值实体不专报」已在本报告记录，建议随 Q1 答案一起复核。
