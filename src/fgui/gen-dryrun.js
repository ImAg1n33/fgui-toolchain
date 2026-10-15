'use strict';
/**
 * src/fgui/gen-dryrun.js —— M2 第 4 步：dryrun 核心（M2-SPEC §6）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 职责：给定 prepare 产出的 gen_plan.json + project_index + 目标文件内容，
 *      **在内存里**打补丁、跑 lint 门禁、生成行级 unified diff，返回一份
 *      **确定性**（无时间戳、键序稳定、同输入逐字节一致）的报告。
 *
 * ★ 本模块不做文件 I/O ★（调用方读好内容传进来，dryrun 才能保证对工程
 *   目录零写入 —— 这是 M2 验收标准 2 的核心）。
 *
 * 顺序（与 M2-SPEC §6 一致）：
 *   1. 漂移校验：target.sha256 vs 实测 targetContents[file] 的 SHA-256
 *      → 不一致 exitCode = USAGE(2)。
 *   2. 内存打补丁：只处理 status==='resolved' 的条目；其余进 skippedEntries。
 *   3. lint 门禁：lintComponentXml(after, { config, fileName, resources })
 *      ★ 必须注入 resources（否则 R-05/R-10 静默降级）★
 *      有 error → exitCode = LINT_BLOCKED(3)，磁盘零写入。
 *   4. 行级 unified diff（自写 LCS，零第三方依赖 —— D10）。
 *   5. 组装 report。
 *
 * ★ 接口契约（team-lead 已定死）★
 *   runDryrun({ genPlan, projectIndex, targetContents, options })
 *     → { report, exitCode }
 *   · targetContents: { [file]: string }，调用方读好的目标 XML 内容。
 * ════════════════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

const { EXIT } = require('../core/errors');
const { patchAttrs, insertChild } = require('./xml-patcher');
const { renderNode } = require('./node-render');
const { lintComponentXml } = require('./lint-rules');
const { parseXmlDocument, walkElements } = require('./xml-parse');
const { parseUiRef } = require('./resource-resolver');

/** unix 风格上下文行数（标准 unified diff 缺省 3）。 */
const DIFF_CONTEXT = 3;

/**
 * 计算字符串的 SHA-256（十六进制）。
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 把值转成有限数字，否则 null。
 * @param {*} v
 * @returns {number|null}
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 收集 gen_plan 的目标文件列表（兼容单 target 与 targets[]）。
 * @param {Object} genPlan
 * @returns {Object[]}
 */
function collectTargets(genPlan) {
  const plan = genPlan || {};
  if (plan.target && plan.target.file) return [plan.target];
  if (Array.isArray(plan.targets)) return plan.targets.filter((t) => t && t.file);
  return [];
}

/**
 * 从 project_index 构造 lint 注入用的资源表（D9）。
 *
 * 对每条资源同时给出两个 key：`ui://<pkgId>/<id>`（优先）与 `ui://<pkgId>/<name>`；
 * 再补裸 `id` / 裸 `name`（覆盖 lint 的 lookupResource「退化为末段名」路径）。
 * width/height 任一为 null 的条目跳过。
 *
 * @param {Object} projectIndex
 * @returns {Object<string,{w:number,h:number}>}
 */
function buildLintResources(projectIndex) {
  const map = {};
  const list = (projectIndex && Array.isArray(projectIndex.resources)) ? projectIndex.resources : [];
  for (const r of list) {
    if (!r) continue;
    const w = numOrNull(r.width);
    const h = numOrNull(r.height);
    if (w === null || h === null) continue;
    const pkgId = r.pkgId || r.packageId || null;
    const id = r.id || null;
    const name = r.name || null;
    if (pkgId && id) map[`ui://${pkgId}/${id}`] = { w, h };
    if (pkgId && name) map[`ui://${pkgId}/${name}`] = { w, h };
    if (id) map[id] = { w, h };
    if (name) map[name] = { w, h };
  }
  return map;
}

/**
 * 统计一段组件 XML 里可解析的 `ui://` 引用条数（复用解析器 + resource-resolver，
 * 不另写一套识别逻辑）。
 *
 * ★ 为什么需要它 ★（D9 的防静默降级）
 *   `project-index` 带 `--no-images` 时 resources[].width/height 全为 null →
 *   buildLintResources 产出空表 → lint 的 R-05/R-10 静默降级（正是 D9 要防的坑）。
 *   本函数提供的计数用于在「注入表为空却有 ui:// 引用」时发出显式告警。
 *
 * @param {string} xmlText
 * @returns {number}
 */
function countUiRefs(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText) return 0;
  let parsed;
  try {
    parsed = parseXmlDocument(xmlText);
  } catch {
    return 0;
  }
  if (!parsed.root) return 0;
  let n = 0;
  walkElements(parsed.root, (node) => {
    const attrs = node.attrs || {};
    for (const attr of Object.keys(attrs)) {
      const v = attrs[attr];
      if (typeof v === 'string' && v.includes('ui://') && parseUiRef(v)) n += 1;
    }
  });
  return n;
}

// ════════════════════════════════════════════════════════════════════════════
// 行级 unified diff（自写 LCS，零依赖 —— D10）
// ════════════════════════════════════════════════════════════════════════════
/** LCS DP 的行数上限（超过则退化为整体替换；组件 XML 远小于此）。 */
const DIFF_MAX_LINES = 4000;

/**
 * 计算两行数组的编辑脚本（LCS 回溯）。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{t:'eq'|'del'|'ins', s:string}[]}
 */
function diffScript(a, b) {
  const n = a.length;
  const m = b.length;
  if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES) {
    return [
      ...a.map((s) => ({ t: 'del', s })),
      ...b.map((s) => ({ t: 'ins', s })),
    ];
  }
  // dp[i][j] = LCS(a[i:], b[j:])
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const script = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { script.push({ t: 'eq', s: a[i] }); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      script.push({ t: 'del', s: a[i] }); i += 1;
    } else {
      script.push({ t: 'ins', s: b[j] }); j += 1;
    }
  }
  while (i < n) { script.push({ t: 'del', s: a[i] }); i += 1; }
  while (j < m) { script.push({ t: 'ins', s: b[j] }); j += 1; }
  return script;
}

/**
 * 生成标准 unified diff（含 `---`/`+++` 头与 `@@ -a,b +c,d @@` hunk 头）。
 *
 * @param {string} before
 * @param {string} after
 * @param {Object} [opts]
 * @param {string} [opts.path] 文件路径（出现在头行，如 `a/<path>`）
 * @param {number} [opts.context]
 * @returns {string} 无差异时返回空串
 */
function formatUnifiedDiff(before, after, opts = {}) {
  if (before === after) return '';
  const context = opts.context === undefined ? DIFF_CONTEXT : opts.context;
  const p = opts.path || 'file';

  const aLines = String(before).split('\n');
  const bLines = String(after).split('\n');
  const script = diffScript(aLines, bLines);

  // 标注行号：a = 原文件行号（del/eq），b = 新文件行号（ins/eq）
  let ai = 0;
  let bi = 0;
  const rows = script.map((e) => {
    if (e.t === 'eq') { const r = { type: 'eq', text: e.s, a: ai + 1, b: bi + 1 }; ai += 1; bi += 1; return r; }
    if (e.t === 'del') { const r = { type: 'del', text: e.s, a: ai + 1, b: null }; ai += 1; return r; }
    const r = { type: 'ins', text: e.s, a: null, b: bi + 1 }; bi += 1; return r;
  });

  // 聚类 hunk：变更行相距 > 2*context 则断开
  const changeIdx = [];
  for (let k = 0; k < rows.length; k++) if (rows[k].type !== 'eq') changeIdx.push(k);
  const hunks = [];
  let cur = null;
  for (const idx of changeIdx) {
    if (!cur || idx - cur.last > context * 2) {
      cur = { start: Math.max(0, idx - context), last: idx };
      hunks.push(cur);
    } else {
      cur.last = idx;
    }
  }

  const out = [`--- a/${p}`, `+++ b/${p}`];
  for (const h of hunks) {
    const from = h.start;
    const to = Math.min(rows.length - 1, h.last + context);
    const slice = rows.slice(from, to + 1);
    const aStart = (slice.find((r) => r.a !== null) || {}).a || 0;
    const bStart = (slice.find((r) => r.b !== null) || {}).b || 0;
    const aCount = slice.filter((r) => r.type !== 'ins').length;
    const bCount = slice.filter((r) => r.type !== 'del').length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const r of slice) {
      const prefix = r.type === 'eq' ? ' ' : (r.type === 'del' ? '-' : '+');
      out.push(prefix + r.text);
    }
  }
  return out.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// 条目处理
// ════════════════════════════════════════════════════════════════════════════

/**
 * 非 resolved 条目的跳过原因（人可读）。
 * @param {Object} entry
 * @returns {string}
 */
function skipReason(entry) {
  switch (entry.status) {
    case 'unresolved':
      return '未解析：nodeId 缺失或同名歧义，请在 gen_plan.json 补齐 nodeId 后重跑 dryrun';
    case 'blocked':
      return entry.note ? `结构性阻塞：${entry.note}` : '结构性阻塞（详见 note）';
    case 'skipped':
      return '门禁丢弃或低置信度，已按策略跳过';
    default:
      return `状态 ${entry.status || '(缺失)'} 不处理`;
  }
}

/**
 * 把一个条目归一化成 skippedEntries 记录。
 * @param {Object} entry
 * @returns {Object}
 */
function toSkipRecord(entry) {
  return {
    op: entry.op || null,
    slot: entry.slot === undefined ? null : entry.slot,
    nodeId: entry.nodeId === undefined ? null : entry.nodeId,
    status: entry.status || null,
    reason: skipReason(entry),
  };
}

/**
 * 对一段 XML 文本套用单个 resolved 条目。
 *
 * @param {string} text
 * @param {Object} entry
 * @param {string[]} [notes] 收集器：记录「非静默」的处理说明
 * @returns {string} 新文本
 * @throws {AppError} 定位/插入失败
 */
function applyEntry(text, entry, notes) {
  const patch = entry.patch || {};
  // ADD：{ tag, attrs, after }
  if (patch.tag) {
    const rendered = renderNode({ tag: patch.tag, attrs: patch.attrs || {} });
    // ★ M2-SPEC §9：不推断 z-order —— ADD 一律追加到 displayList 末尾。★
    //   `after` 是「同级锚点」语义（§4：after=null → displayList 末尾），
    //   而 xml-patcher.insertChild 只支持「父容器末尾追加」；M2 不做 z-order，
    //   故 after 仅作人可读提示、不参与定位 —— 在 report 里显式记一条 note，
    //   绝不静默丢弃（团队纪律：blocked/skipped/忽略都要可见）。
    if (notes && patch.after !== undefined && patch.after !== null) {
      notes.push(`ADD(op=${entry.op || '?'} slot=${entry.slot || '?'}) 已按 M2-SPEC §9 追加到 displayList 末尾`
        + `（忽略 z-order 锚点 after=${patch.after}；M2 不推断 z-order）`);
    }
    return insertChild(text, { tag: 'displayList' }, rendered);
  }
  // 多属性：{ attrs: { color, alpha } }
  if (patch.attrs && typeof patch.attrs === 'object') {
    return patchAttrs(text, { id: entry.nodeId }, patch.attrs);
  }
  // 单属性：{ attr, value }
  if (patch.attr) {
    return patchAttrs(text, { id: entry.nodeId }, { [patch.attr]: patch.value });
  }
  throw new Error(`条目缺少可识别的 patch（需要 {tag,attrs,after} / {attrs} / {attr,value}）`);
}

// ════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════

/**
 * 跑一次 dryrun（内存打补丁 + lint 门禁 + unified diff），**零磁盘写入**。
 *
 * @param {Object} input
 * @param {Object} input.genPlan gen_plan.json 对象（M2-SPEC §4）
 * @param {Object} [input.projectIndex] project_index.json 对象（注入 lint resources）
 * @param {Object} [input.targetContents] { [file]: string } 目标文件内容
 * @param {Object} [input.options] { config }
 * @returns {{report:Object, exitCode:number}}
 */
function runDryrun(input = {}) {
  const genPlan = input.genPlan || {};
  const projectIndex = input.projectIndex || null;
  const contents = input.targetContents || {};
  const options = input.options || {};

  const entries = Array.isArray(genPlan.entries) ? genPlan.entries : [];
  const targets = collectTargets(genPlan);
  const lintResources = buildLintResources(projectIndex);

  /** @type {string[]} */
  const topErrors = [];
  /** @type {Object[]} 顶层非致命告警（如 lint 资源注入表为空 —— D9 防静默降级） */
  const reportWarnings = [];
  /** resources 注入表是否为空（空则 R-05/R-10 会降级，需告警） */
  const resourcesEmpty = Object.keys(lintResources).length === 0;
  /** @type {Object[]} */
  const files = [];
  let entriesApplied = 0;
  let entriesSkipped = 0;
  let lintErrorCount = 0;

  if (!targets.length) {
    topErrors.push('gen_plan 缺少 target.file（没有可 dryrun 的目标文件）');
    return {
      exitCode: EXIT.USAGE,
      report: {
        ok: false,
        files: [],
        summary: {
          filesChanged: 0, entriesApplied: 0, entriesSkipped: 0, lintErrors: 0,
        },
        errors: topErrors,
        warnings: reportWarnings,
      },
    };
  }

  // ---- 阶段 1：漂移校验 ----
  const drifts = [];
  for (const t of targets) {
    const before = contents[t.file];
    if (typeof before !== 'string') {
      topErrors.push(`未提供目标文件内容：${t.file}（targetContents 缺少该键）`);
      continue;
    }
    if (t.sha256) {
      const actual = sha256(before);
      if (actual !== t.sha256) {
        drifts.push({ file: t.file, expected: t.sha256, actual });
      }
    }
  }
  if (topErrors.length || drifts.length) {
    for (const d of drifts) {
      topErrors.push(`文件在 prepare 后被修改，请重跑 prepare：${d.file}（期望 ${d.expected.slice(0, 12)}…，实测 ${d.actual.slice(0, 12)}…）`);
    }
    // 漂移/缺内容时：给出每文件的结构化记录（lint=null，零打补丁）
    for (const t of targets) {
      const before = contents[t.file];
      const d = drifts.find((x) => x.file === t.file);
      files.push({
        file: t.file,
        sha256Before: typeof before === 'string' ? sha256(before) : null,
        sha256After: typeof before === 'string' ? sha256(before) : null,
        changed: false,
        status: d ? 'drift' : 'missing-content',
        drift: d ? { expected: d.expected, actual: d.actual } : null,
        lint: null,
        diff: '',
        skippedEntries: [],
        notes: [],
      });
    }
    return {
      exitCode: EXIT.USAGE,
      report: {
        ok: false,
        files,
        summary: {
          filesChanged: 0, entriesApplied: 0, entriesSkipped: 0, lintErrors: 0,
        },
        errors: topErrors,
        warnings: reportWarnings,
      },
    };
  }

  // ---- 阶段 2/3/4：逐文件打补丁 + lint + diff ----
  const appliedEntries = [];
  const skippedEntries = [];
  const touchedFiles = new Set(targets.map((t) => t.file));

  // 所有条目默认作用于唯一的 target 文件（M2 单组件 plan）
  const defaultFile = targets[0].file;
  // 先把每个文件的工作文本准备好
  /** @type {Map<string,string>} */
  const work = new Map();
  /** @type {Map<string,string[]>} 每文件的非静默处理说明 */
  const fileNotes = new Map();
  for (const t of targets) { work.set(t.file, contents[t.file]); fileNotes.set(t.file, []); }

  for (const entry of entries) {
    if (entry && entry.status === 'resolved') {
      const file = entry.file || defaultFile;
      if (!work.has(file)) {
        skippedEntries.push({ ...toSkipRecord(entry), reason: `目标文件不在本次 plan（${file}）` });
        entriesSkipped += 1;
        continue;
      }
      try {
        const notes = fileNotes.get(file);
        const next = applyEntry(work.get(file), entry, notes);
        work.set(file, next);
        appliedEntries.push({ op: entry.op || null, slot: entry.slot === undefined ? null : entry.slot, nodeId: entry.nodeId === undefined ? null : entry.nodeId });
        entriesApplied += 1;
      } catch (err) {
        // patch 失败 = plan 与工程不一致 → 记 error 并按 USAGE 处理（不静默）
        const msg = `条目 patch 失败（op=${entry.op || '?'} slot=${entry.slot || '?'} nodeId=${entry.nodeId || '?'}）：${err.message}`;
        topErrors.push(msg);
        skippedEntries.push({ ...toSkipRecord({ ...entry, status: 'error' }), reason: msg });
        entriesSkipped += 1;
      }
    } else {
      skippedEntries.push(toSkipRecord(entry || {}));
      entriesSkipped += 1;
    }
  }

  let lintBlocked = false;
  for (const t of targets) {
    const before = contents[t.file];
    const after = work.get(t.file);
    const changed = before !== after;

    const lint = lintComponentXml(after, {
      config: options.config,
      fileName: t.file,
      resources: lintResources,
    });
    const errs = (lint.errors || []).map((e) => ({ rule: e.rule, message: e.message, line: e.line }));
    if (errs.length) lintBlocked = true;
    lintErrorCount += errs.length;

    const lintWarns = (lint.warnings || []).map((w) => ({ rule: w.rule, message: w.message, line: w.line }));

    // ★ D9 防静默降级 ★：resources 注入表为空 + 文本里有 ui:// 引用
    //   → R-05/R-10 会静默降级（典型成因：project-index 带 --no-images 跑，
    //     width/height 全 null）。这里发显式 warning，**不改变退出码**
    //     （不带图索引是用户的构建选择，不是错误）。
    if (resourcesEmpty) {
      const uiRefCount = countUiRefs(after);
      if (uiRefCount > 0) {
        const msg = `lint 资源注入表为空（project_index.resources 的 width/height 全为 null —— `
          + '可能 project-index 未带图运行），但本文件有 ' + uiRefCount + ' 处 ui:// 引用：'
          + 'R-05（scale9grid 边界对账）与 R-10（九宫格适用性）已降级为「仅格式校验」。'
          + '补全资源信息（去掉 --no-images 重跑 project-index）可获得完整对账';
        lintWarns.push({ rule: 'LINT_RESOURCES_EMPTY', message: msg, line: null });
        reportWarnings.push({ file: t.file, code: 'LINT_RESOURCES_EMPTY', uiRefCount, message: msg });
      }
    }

    // 该文件的跳过条目：单目标时全归它；多目标时按 entry.file 归属
    const fileSkips = skippedEntries.filter((s) => {
      const e = entries.find((x) => x && x.op === s.op && (x.slot === s.slot) && (x.nodeId || null) === s.nodeId);
      const f = e && e.file ? e.file : defaultFile;
      return f === t.file;
    });

    files.push({
      file: t.file,
      sha256Before: sha256(before),
      sha256After: sha256(after),
      changed,
      status: errs.length ? 'lint-blocked' : 'ok',
      lint: {
        errors: errs,
        warnings: lintWarns,
      },
      diff: formatUnifiedDiff(before, after, { path: t.file }),
      skippedEntries: fileSkips,
      notes: fileNotes.get(t.file) || [],
    });
  }

  let exitCode = EXIT.OK;
  if (topErrors.length) exitCode = EXIT.USAGE;
  else if (lintBlocked) exitCode = EXIT.LINT_BLOCKED;

  const report = {
    ok: exitCode === EXIT.OK,
    files,
    summary: {
      filesChanged: files.filter((f) => f.changed).length,
      entriesApplied,
      entriesSkipped,
      lintErrors: lintErrorCount,
    },
    errors: topErrors,
    warnings: reportWarnings,
  };
  return { report, exitCode };
}

module.exports = {
  runDryrun,
  countUiRefs,
  sha256,
  buildLintResources,
  formatUnifiedDiff,
  diffScript,
  collectTargets,
  applyEntry,
  DIFF_CONTEXT,
};
