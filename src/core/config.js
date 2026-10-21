'use strict';
/**
 * src/core/config.js —— 配置加载与默认值合并
 *
 * 优先级：命令行覆盖 > fgui.config.json > 内置默认值。
 * 深合并（对象递归，数组整体替换）——阈值数组应当整体替换而非逐项合并。
 */

const fs = require('fs');
const path = require('path');
const { AppError, CODES } = require('./errors');

/**
 * 内置默认配置。与 fgui.config.json 保持同构，缺文件也能跑。
 * @returns {Object}
 */
function defaultConfig() {
  return {
    version: '1.0',
    paths: { outDir: 'out' },
    asset: {
      extensions: ['.png', '.jpg', '.jpeg', '.webp'],
      thumbSize: 96,
      maxInlineBytes: 5242880,
      grid9Thumbs: 64,
      // E-02 倍率推断（L6/Q22）。默认关闭：Q22 未确认是否有 1x/2x 混用，
      // 默认开启会改变现有 Ch-1 尺寸校验行为。开启后容差按倍率缩放（±2k px）。
      scaleInfer: { enabled: false, maxScale: 4 },
    },
    search: {
      weights: { ch1: 0.5, ch2: 0.3, ch3: 0.2 },
      sizeTolerancePx: 2,
      topK: 10,
      phashMaxDistance: 12,
      aspectTolerance: 0.05,
      ambiguousConfidenceCap: 0.6,
    },
    grid9: {
      radialSymmetryMax: 0.88,
      radialSpreadMin: 0.5,
      radialClusterMin: 2,
      gradientMonotonicMin: 0.9,
      minSideForShape: 12,
      cornerFillPanelMin: 0.7,
      cornerFillCapsuleMax: 0.7,
      cornerFillRoundMax: 0.25,
      capsuleAspectMin: 2.0,
      flatMidVarianceMax: 0.15,
      unknownConfidence: 0.4,
    },
    diff: {
      sizeTolerancePx: 2,
      positionTolerancePx: 4,
      phashMaxDistance: 10,
      phashWeight: 0.5,
      sizeWeight: 0.3,
      positionWeight: 0.2,
      l3MinScore: 0.6,
      maxAreaRatio: 4,
      maxShapeRatioFactor: 1.6,
      minRepeatCount: 3,
      mergedConfidenceCap: 0.5,
      l4Confidence: 0.15,
      restyleOpacityDelta: 0.02,
      aspectTolerance: 0.02,
    },
    psd: { dpr: 1, readImageData: true },
    normalize: { stripCopySuffix: true, stripExtension: true, useVariants: true },
    // P1-a FGUI 契约层 lint 配置。
    // ★ 与 src/fgui/constants.js 的 DEFAULT_FGUI_CONFIG 逐键一致（含值）★
    //   由 test/unit/lint-rules.test.js 的「配置守卫」断言保证。
    //   为什么在两处各写一份：§8.6「core 不得 import 上层」，config.js 不能
    //   require fgui/constants.js（与 grid9 阈值同款模式：config.js 与 grid9.js
    //   各一份，determinism.test.js 对账）。
    //   Q2/Q20 答案到位后只改 fgui.config.json 的本段，不改代码。
    //   displayListTags 已依据上游 STANDARDS.md §2.6 落定（UPSTREAM-FIX-2，
    //   10 种合法标签）；extentionTypes 已核对与上游一致。
    fgui: {
      displayListTags: ['image', 'graph', 'loader', 'loader3D', 'text', 'richtext', 'list', 'component', 'jta', 'group'],
      extentionTypes: ['Button', 'Label', 'ComboBox', 'ProgressBar', 'Slider', 'ScrollBar', 'List', 'Tree'],
      pkgIdLength: 8,
      idPrefixes: ['b', 'c'],
      idDigits: 5,
      colorAttributes: ['color', 'strokeColor', 'fillColor'],
      colorRequireAlpha: false,
      urlAttributes: ['src', 'url', 'icon', 'defaultItem'],
      // R-04 专用：哪些属性里的 ui:// 要做引用合法性校验（含 font）。
      // 与 urlAttributes 分开：后者是"指向可测量资源的属性"（R-05/R-10 用）。
      uiRefAttributes: ['src', 'url', 'icon', 'defaultItem', 'font'],
      exportedRequired: true,
      maxObjectsPerComponent: 80,
      bannedNamePatterns: ['^n\\d+$', '^img\\d+$', '^node\\d*$', '^\\d+$'],
      grid9LintEnabled: true,
    },
  };
}

/**
 * 深合并：对象递归，数组/标量直接覆盖。
 * @param {Object} base
 * @param {Object} patch
 * @returns {Object} 新对象（不修改入参）
 */
function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

/**
 * 深冻结，防止运行期被意外改写导致不确定性。
 * @param {Object} obj
 * @returns {Object}
 */
function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

/**
 * 加载配置。
 * @param {Object} [opts]
 * @param {string} [opts.rootDir] 项目根目录（含 fgui.config.json）
 * @param {string} [opts.configPath] 显式指定配置文件
 * @param {Object} [opts.overrides] 命令行覆盖（形如 { search: { topK: 5 } }）
 * @returns {{config:Object, configPath:string|null, existed:boolean}}
 */
function loadConfig(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const configPath = opts.configPath || path.join(rootDir, 'fgui.config.json');
  let fileConfig = {};
  let existed = false;
  if (fs.existsSync(configPath)) {
    existed = true;
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new AppError(CODES.CONFIG_INVALID, `配置文件解析失败: ${configPath}`, { cause: err.message });
    }
  }
  // 配置文件里的 _comment 仅供人读，不进运行时配置（避免污染确定性输出）
  if (fileConfig && typeof fileConfig === 'object') {
    const clone = { ...fileConfig };
    for (const key of Object.keys(clone)) {
      if (key.startsWith('_')) delete clone[key];
    }
    // 嵌套 _comment 也剔掉
    stripComments(clone);
    fileConfig = clone;
  }
  const merged = deepMerge(deepMerge(defaultConfig(), fileConfig), opts.overrides || {});
  deepFreeze(merged);
  return { config: merged, configPath: existed ? configPath : null, existed };
}

/**
 * 递归剔除以 `_` 开头的说明键。
 * @param {Object} node
 */
function stripComments(node) {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (key.startsWith('_')) delete node[key];
    else stripComments(node[key]);
  }
}

/**
 * 读取**原始**配置文件（未经默认值补全）。
 *
 * ★ 这个函数是为「配置一致性守卫」而存在的 ★（见 test/unit/determinism.test.js）
 *
 * 为什么不能用 loadConfig() 的返回值做守卫 —— 那是自证循环：
 *   `loadConfig()` 返回的是「配置文件 ⊕ 内置默认」的深合并结果。
 *   若配置文件**删掉了某个键**，内置默认会把它补回来，
 *   于是 `config.xxx` 永远存在、值永远等于默认值 —— **断言永远成立，抓不到任何问题**。
 *   而「旧键名残留 + 新键名缺失」正是最典型的配置腐化。
 *
 *   QA 实测复现：把 `diff.maxShapeRatioFactor` 改名为 `maxShapeRatioDelta`，
 *   原守卫仍然绿灯通过。
 *
 * 本函数返回**文件里实际写了什么**，不做任何补全，守卫才能真正起到作用。
 *
 * @param {string} configPath 配置文件绝对路径
 * @returns {{raw:Object|null, path:string, exists:boolean}}
 */
function readRawConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return { raw: null, path: configPath, exists: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new AppError(CODES.CONFIG_INVALID, `配置文件解析失败: ${configPath}`, { cause: err.message });
  }
  return { raw: parsed && typeof parsed === 'object' ? parsed : null, path: configPath, exists: true };
}

/**
 * 解析「注入时间戳」。
 *
 * ★ `--now` 曾是一个空壳 flag ★（QA 独立发现）：
 *   `--help` 承诺「注入时间戳，用于 .bak 文件名」，但 index.js 把 flags.now
 *   放进 ctx.now 之后**再无任何消费者** —— 实测传两个不同值，
 *   run_meta.json 的 generatedAt 仍是真实时间。文档承诺了但没实现，
 *   这比 bug 更伤信任（「文档承诺了但没实现」）。
 *
 * 本函数把 `--now` 真正接通：
 *   · run_meta.json 的 generatedAt 用它（不再用 new Date()）
 *   · 非法值直接抛 USAGE，而不是静默回退到真实时间
 *
 * @param {string|Date|number|undefined} now
 * @returns {{iso:string, injected:boolean}}
 */
function resolveNow(now) {
  if (now === undefined || now === null || now === '') {
    return { iso: new Date().toISOString(), injected: false };
  }
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(CODES.USAGE,
      `--now 不是合法时间: ${String(now)}（期望 ISO 8601，如 2026-05-13T10:20:30.123Z）`);
  }
  return { iso: d.toISOString(), injected: true };
}

module.exports = {
  loadConfig, defaultConfig, deepMerge, deepFreeze, readRawConfig, resolveNow,
};
