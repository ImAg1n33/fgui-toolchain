'use strict';
/**
 * src/create/exec-runner.js —— CREATE Executor 的**调度器**：执行 create_exec.json
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 真实 Bridge 适配层是**独立的另一层，尚未实现** ★
 *   本机连不上 Bridge（没有 FairyGUI/Unity），所以本模块**不实现** HTTP/WS 传输，
 *   而是通过**注入的 transport** 执行：
 *       `{ send(op, args) => Promise<{ok, data?, error?}> }`
 *   真实 HTTP/WS 适配留给朋友那侧实现后注入。**不许**用假的 HTTP 客户端伪装"连过"。
 *
 * ★ 三条纪律 ★
 *   1. **禁止假成功**：`executable!==true` 或存在 required unsupported / invalidSteps →
 *      `status:'refused'`，**一次都不许调 transport**。
 *   2. **失败即停**：第一条步骤失败立刻停止，后续标 `skipped`
 *      （不做"尽力继续"—— 半截组件比不做更难清理）。
 *   3. **确定性**：默认**不写时间戳、不写耗时**（`ms` 仅在 `opts.timing===true` 时输出），
 *      同输入 + 同 transport 两次运行报告**逐字节一致**。
 * ════════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

const { writeJson } = require('../core/fs-json');
const { parseXmlDocument } = require('../fgui/xml-parse');

/** 产物版本。 */
const REPORT_VERSION = '0.1';

/**
 * 从 `read_component` 返回的组件 XML 里取 displayList 的**直接子节点**（按文档顺序）。
 *
 * @param {string} xml
 * @returns {Array<{tag:string,name:string|null,src:string|null,xy:string|null,size:string|null}>}
 */
function childrenFromComponentXml(xml) {
  const parsed = parseXmlDocument(typeof xml === 'string' ? xml : '');
  const root = parsed && parsed.root ? parsed.root : null;
  if (!root || !Array.isArray(root.children)) return [];
  const out = [];
  for (const dl of root.children) {
    if (!dl || dl.tag !== 'displayList') continue;
    for (const c of Array.isArray(dl.children) ? dl.children : []) {
      out.push({
        tag: c.tag || null,
        name: c.attrs && c.attrs.name !== undefined ? c.attrs.name : null,
        src: c.attrs && (c.attrs.src !== undefined ? c.attrs.src : c.attrs.url) || null,
        xy: c.attrs && c.attrs.xy !== undefined ? c.attrs.xy : null,
        size: c.attrs && c.attrs.size !== undefined ? c.attrs.size : null,
      });
    }
  }
  return out;
}

/**
 * 把「期望值 vs 实际值」记成一条 diff（含点名字段，便于人看）。
 *
 * @param {Object} where {index} 或 {}
 * @param {string} field
 * @param {*} expected
 * @param {*} actual
 * @returns {Object}
 */
function diff(where, field, expected, actual) {
  return { ...where, field, expected, actual };
}

/**
 * 执行 verify 并与 `expect` 比对。
 *
 * @param {Object} v verify 条目（{op, args, expect, compare, onMismatch}）
 * @param {{ok:boolean, data?:any, error?:string}} res transport 返回值
 * @returns {{ok:boolean, diffs:Object[]}}
 */
function compareVerify(v, res) {
  const diffs = [];
  const expect = (v && v.expect) || {};

  if (!res || !res.ok) {
    diffs.push(diff({}, 'transport', 'ok', (res && res.error) || 'unknown error'));
    return { ok: false, diffs };
  }

  if (v.op === 'read_component') {
    const actual = childrenFromComponentXml(res.data && res.data.xml);
    if (typeof expect.childCount === 'number' && actual.length !== expect.childCount) {
      diffs.push(diff({}, 'childCount', expect.childCount, actual.length));
    }
    for (const e of Array.isArray(expect.children) ? expect.children : []) {
      const a = actual[e.index];
      const where = { index: e.index };
      if (!a) {
        diffs.push(diff(where, 'child', '存在', '缺失'));
        continue;
      }
      // ★ 图片比 url（对应 XML 的 src/url），文本等比 name —— 与 exec-plan 的约定一致 ★
      if (e.url !== undefined && e.url !== null && a.src !== e.url) {
        diffs.push(diff(where, 'url', e.url, a.src));
      }
      if (e.name !== undefined && e.name !== null && a.name !== e.name) {
        diffs.push(diff(where, 'name', e.name, a.name));
      }
      if (e.xy !== undefined && e.xy !== null && a.xy !== e.xy) {
        diffs.push(diff(where, 'xy', e.xy, a.xy));
      }
      if (e.size !== undefined && e.size !== null && a.size !== e.size) {
        diffs.push(diff(where, 'size', e.size, a.size));
      }
    }
    return { ok: diffs.length === 0, diffs };
  }

  if (v.op === 'list_children') {
    const children = (res.data && Array.isArray(res.data.children)) ? res.data.children : [];
    if (typeof expect.childCount === 'number' && children.length !== expect.childCount) {
      diffs.push(diff({}, 'childCount', expect.childCount, children.length));
    }
    const wantNames = Array.isArray(expect.nameGuaranteedNames) ? expect.nameGuaranteedNames : null;
    if (wantNames) {
      const actualNames = children.map((c) => (c && c.name) || null);
      // 只校验"名字可保证的节点"是否都在，且顺序一致
      const got = actualNames.filter((n) => wantNames.includes(n));
      if (wantNames.length !== got.length || wantNames.some((n, i) => got[i] !== n)) {
        diffs.push(diff({}, 'nameGuaranteedNames', wantNames, got));
      }
    }
    return { ok: diffs.length === 0, diffs };
  }

  // 词表内其它回读命令未被建模 → 不假装验过
  diffs.push(diff({}, 'verify', `${v.op} 的回读比对已实现`, '未建模'));
  return { ok: false, diffs };
}

/**
 * 执行一份 create_exec.json。
 *
 * @param {Object} execPlan buildExecPlan 的产物
 * @param {{send:(op:string,args:Object)=>Promise<{ok:boolean,data?:any,error?:string}>}} transport
 * @param {Object} [opts]
 * @param {boolean} [opts.timing=false] 是否在报告里输出每步耗时。
 *   ★ 耗时只能通过 `opts.now` **注入的时钟**测量 ★ —— 本模块**不得**自带时钟：
 *     K1 守卫（`test/unit/net-guard.test.js`）**静态**禁止 `src/` 里出现时间戳 API
 *     （它 grep 的是源码字面量，不看运行时条件）—— 因为"确定性"不能靠自觉保证：
 *     默认行为正确但源码里留着时间戳 API，下一个人改个默认值就破功。故：`timing=false` 或未提供 `now` → **不计时、报告里无 `ms`**。
 * @param {() => number} [opts.now] 可选注入的时钟（测试用假时钟即可保证耗时也是确定值）
 * @returns {Promise<{report:Object}>}
 */
async function runExecPlan(execPlan, transport, opts = {}) {
  const timing = opts.timing === true;
  const report = {
    version: REPORT_VERSION,
    status: 'refused',
    target: execPlan && execPlan.target ? execPlan.target : null,
    steps: [],
    verify: null,
    summary: {
      steps: 0, executed: 0, ok: 0, failed: 0, skipped: 0, verifyDiffs: 0,
    },
  };

  // ── ① 前置拒绝：禁止假成功 ──
  if (!execPlan || typeof execPlan !== 'object') {
    report.reason = 'execPlan 缺失';
    return { report };
  }
  const requiredUnsupported = (Array.isArray(execPlan.unsupported) ? execPlan.unsupported : [])
    .filter((u) => u && u.required);
  const invalidCount = Array.isArray(execPlan.invalidSteps) ? execPlan.invalidSteps.length : 0;
  if (execPlan.executable !== true) {
    report.reason = `execPlan.executable !== true（preflight：`
      + `${JSON.stringify((execPlan.preflight && execPlan.preflight.failures) || [])}）`
      + ' —— 存在必然失败/被拒绝的前提，拒绝执行';
    return { report };
  }
  if (requiredUnsupported.length) {
    report.reason = `${requiredUnsupported.length} 个必需操作无法执行，拒绝执行（一次都不调用 transport）：`
      + requiredUnsupported.map((u) => u.reason).join(' | ');
    return { report };
  }
  if (invalidCount) {
    report.reason = `${invalidCount} 个步骤参数不合规，拒绝执行`;
    return { report };
  }
  if (!transport || typeof transport.send !== 'function') {
    report.reason = 'transport 缺失或没有 send(op,args) 方法（真实 Bridge 适配层尚未实现）';
    return { report };
  }

  // ── ② 逐步执行：第一条失败即停 ──
  const steps = Array.isArray(execPlan.steps) ? execPlan.steps : [];
  let stopped = false;
  let stoppedAt = null;
  for (const step of steps) {
    const rec = {
      step: step.step, op: step.op, ok: false, result: null, error: null, skipped: stopped,
    };

    if (stopped) {
      report.steps.push(rec);
      continue;
    }

    const now = timing && typeof opts.now === 'function' ? opts.now : null;
    const t0 = now ? now() : 0;
    let res = null;
    try {
      res = await transport.send(step.op, step.args || {});
    } catch (err) {
      res = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (now) rec.ms = now() - t0;

    if (res && res.ok) {
      rec.ok = true;
      rec.result = res.data === undefined ? null : res.data;
    } else {
      rec.ok = false;
      rec.error = (res && res.error) ? String(res.error) : 'transport 返回 ok=false 但未给 error';
      stopped = true;
      stoppedAt = step.step;
    }
    report.steps.push(rec);
  }

  const executed = report.steps.filter((s) => !s.skipped).length;
  const okCount = report.steps.filter((s) => s.ok).length;
  const failedCount = report.steps.filter((s) => !s.skipped && !s.ok).length;
  const skippedCount = report.steps.filter((s) => s.skipped).length;
  report.summary = {
    steps: steps.length,
    executed,
    ok: okCount,
    failed: failedCount,
    skipped: skippedCount,
    verifyDiffs: 0,
  };

  if (stopped) {
    report.status = 'failed';
    report.failedAtStep = stoppedAt;
    return { report };
  }

  // ── ③ 回读校验 ──
  const verifyList = Array.isArray(execPlan.verify) ? execPlan.verify : [];
  const verifyResults = [];
  let verifyOk = true;
  for (const v of verifyList) {
    let res = null;
    try {
      res = await transport.send(v.op, v.args || {});
    } catch (err) {
      res = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    const cmp = compareVerify(v, res);
    if (!cmp.ok) verifyOk = false;
    verifyResults.push({
      op: v.op,
      args: v.args || {},
      ok: cmp.ok,
      onMismatch: v.onMismatch || null,
      diffs: cmp.diffs,
    });
  }
  report.verify = verifyResults;
  report.summary.verifyDiffs = verifyResults.reduce((n, r) => n + (r.diffs ? r.diffs.length : 0), 0);

  if (!verifyList.length) {
    report.status = 'ok';
    report.advisories = ['execPlan 没有 verify 条目（回读能力缺失）→ 未做结果校验，需人工核对'];
  } else if (!verifyOk) {
    // ★ onMismatch:'fail' → 命令 ok 也不能算成功 ★
    report.status = 'verify-failed';
  } else {
    report.status = 'ok';
  }
  return { report };
}

/**
 * 渲染 exec_report.md（每步结果表 + verify diff）。
 *
 * @param {Object} report
 * @returns {string}
 */
function renderExecReportMarkdown(report) {
  const lines = [];
  const r = report || {};
  lines.push('# create exec 报告', '');
  lines.push(`- status: ${r.status}`);
  lines.push(`- target: ${JSON.stringify(r.target || null)}`);
  if (r.reason) lines.push(`- reason: ${r.reason}`);
  if (r.failedAtStep !== undefined && r.failedAtStep !== null) {
    lines.push(`- failedAtStep: ${r.failedAtStep}`);
  }
  const s = r.summary || {};
  lines.push(`- summary: steps=${s.steps} executed=${s.executed} ok=${s.ok} failed=${s.failed} skipped=${s.skipped} verifyDiffs=${s.verifyDiffs}`);
  lines.push('');

  lines.push('## 步骤', '');
  if (!Array.isArray(r.steps) || !r.steps.length) {
    lines.push('（无步骤；见上方 reason）', '');
  } else {
    lines.push('| step | op | ok | skipped | error |');
    lines.push('|---|---|---|---|---|');
    for (const st of r.steps) {
      lines.push(`| ${st.step} | ${st.op} | ${st.ok ? '✅' : '❌'} | ${st.skipped ? 'yes' : '-'} | ${st.error ? String(st.error).replace(/\|/g, '\\|') : '-'} |`);
    }
    lines.push('');
  }

  lines.push('## 回读校验（verify）', '');
  if (!Array.isArray(r.verify) || !r.verify.length) {
    lines.push('（无回读结果）', '');
  } else {
    for (const v of r.verify) {
      lines.push(`- ${v.op} ${JSON.stringify(v.args)} → ${v.ok ? '✅ 一致' : '❌ 不一致'}（onMismatch=${v.onMismatch || 'null'}）`);
      if (v.diffs && v.diffs.length) {
        for (const d of v.diffs) {
          const where = d.index === undefined ? '' : `children[${d.index}].`;
          lines.push(`  - ${where}${d.field}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`);
        }
      }
    }
    lines.push('');
  }
  if (Array.isArray(r.advisories) && r.advisories.length) {
    lines.push('## 说明', '');
    for (const a of r.advisories) lines.push(`- ${a}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 写 exec_report.json + exec_report.md。
 *
 * @param {string} outDir
 * @param {Object} report
 * @returns {{json:string, md:string}}
 */
function writeExecReport(outDir, report) {
  const jsonPath = path.join(outDir, 'exec_report.json');
  const mdPath = path.join(outDir, 'exec_report.md');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  writeJson(jsonPath, report);
  fs.writeFileSync(mdPath, renderExecReportMarkdown(report), 'utf8');
  return { json: jsonPath, md: mdPath };
}

module.exports = {
  runExecPlan,
  renderExecReportMarkdown,
  writeExecReport,
  childrenFromComponentXml,
  compareVerify,
  REPORT_VERSION,
};
