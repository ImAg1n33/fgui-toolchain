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
 *
 * ★ report.status 取值（P1：没有回读证据的成功不叫 ok）★
 *   refused        门禁未过 / 计划不可执行（**一次都不调 transport**）
 *   failed         第一条步骤失败即停，后续 skipped
 *   verify-failed  回读不通过（onMismatch:'fail' → 命令 ok 也不算成功）
 *   ok             步骤全成 + 回读全过
 *   ok-unverified  步骤全成但**结果未验证**（无 verify 条目 / 计划声明无法回读验证）
 * ════════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

const { writeJson } = require('../core/fs-json');
const { parseXmlDocument } = require('../fgui/xml-parse');
const { parseUiRef } = require('../fgui/resource-resolver');
const { BRIDGE_COMMANDS, validateStepArgs } = require('./exec-plan');

/** 产物版本。 */
const REPORT_VERSION = '0.1';

/**
 * ★ CREATE 允许执行的命令白名单（比"词表内有"更严）★
 *
 * 为什么不是"在 BRIDGE_COMMANDS 词表内就放行"：
 *   `exec_plan` 是 JSON —— 可以被人改，也可能来自不可信来源；而 Bridge **具备修改/删除
 *   资源的能力**（`delete_item` / `remove_object` / `publish` / `screenshot` …）。
 *   CREATE 的目标是"建一个页面"，它**不需要**任何删除/发布/写磁盘副作用命令。
 *   故在词表之外再加一层**能力最小集**：默认只放行建页面所需的命令 + 回读命令。
 *
 * ★ 第十一轮审查 P0-1：移除 `set_image_scale9` ★
 *   它改的是**包内共享图片资源**的九宫格 —— 同一个图片被别的组件引用时，
 *   改它等于偷偷改了无关组件的渲染。而 `exec-plan.js` **从不产出**该 op
 *   （已 grep 确认：只在词表里，没有任何 emit 调用）→ 移除不影响任何合法计划，
 *   只让人为篡进来的该命令被最终门禁拦下（refused）。
 */
const CREATE_ALLOWED_OPS = Object.freeze([
  'create_component', // 建页面/组件容器
  'insert_object', // 插库内已有资源（图片/已有组件）
  'insert_text', // 插文本
  'insert_list', // 插列表
  'insert_loader', // 插装载器
  'save_all', // 落盘
  // 回读（不写盘）：验证"做对了"而不是"命令 ok"
  'read_component',
  'list_children',
  'list_items',
]);

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
 * 把一个"资源引用值"归一化成 `(pkgId, itemId)` —— 用现成的 `parseUiRef`，**不自写解析**。
 *
 * ★ 为什么必须归一化（P0-A）★
 *   真实 FairyGUI 6.1.4 工程里：**同包**引用写**短资源 ID**（`src="q0bg"`），
 *   跨包写 `ui://<pkgId><itemId>`（拼接）或 `ui://<pkgId>/<itemId>`（斜杠）——
 *   **三种写法指的是同一个资源**。若拿原始字符串直接比，同包短 ID 会被判成"不同资源"，
 *   于是"页面其实建对了"却被报成 `verify-failed`，直接毁掉回读验证的信用。
 *
 * @param {*} value 引用值（可能是 `ui://…`，也可能是短 ID）
 * @param {string|null} [fallbackPkgId] 当 value 是**短 ID** 时，它属于哪个包（取期望侧的包 id）
 * @returns {{pkgId:string|null, itemId:string}|null} 无法归一化 → null（调用方须按"不一致"处理）
 */
function normalizeRef(value, fallbackPkgId) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^ui:\/\//i.test(v)) {
    const p = parseUiRef(v);
    return p ? { pkgId: p.pkgId, itemId: p.itemId } : null;
  }
  if (v.includes('://')) return null; // 别的协议（http:// 等）不是 FGUI 资源引用
  // 短资源 ID：本身不含包信息 → 视为"目标包"（fallbackPkgId）内的资源
  return { pkgId: fallbackPkgId || null, itemId: v };
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
      // ★ 图片比"归一化后的引用"（对应 XML 的 src/url），文本等比 name —— 与 exec-plan 约定一致 ★
      if (e.url !== undefined && e.url !== null) {
        const want = normalizeRef(e.url, null);
        // 回读侧的短 ID 视为「期望侧那个包」内的资源
        const got = normalizeRef(a.src, want ? want.pkgId : null);
        if (!want || !got) {
          diffs.push(diff(where, 'url', e.url, a.src));
          diffs.push(diff(where, 'url.normalize', '可解析的引用', !want ? `期望值无法归一化` : `实际值无法归一化：${String(a.src)}`));
        } else if (want.itemId !== got.itemId
          || (want.pkgId && got.pkgId && want.pkgId !== got.pkgId)) {
          diffs.push(diff(where, 'url', `${want.pkgId || '(短ID)'}/${want.itemId}`, `${got.pkgId || '(短ID)'}/${got.itemId}`));
        }
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

  // ── ①b 最终门禁：不信任"调用方传进来的自述"，Runner 自己再过一道 ──
  //   exec_plan 是 JSON：可以被人工改，也可能来自不可信来源；
  //   而 Bridge 具备修改/删除资源的能力 —— 故在调 transport 前必须复核四件事。
  const steps = Array.isArray(execPlan.steps) ? execPlan.steps : [];
  const gateFailures = [];
  /** @type {Object[]} */
  const gateInvalid = [];

  // ① preflight.ok
  if (!execPlan.preflight || execPlan.preflight.ok !== true) {
    gateFailures.push(`preflight.ok !== true（failures=${JSON.stringify((execPlan.preflight && execPlan.preflight.failures) || [])}）`);
  }

  // ②③④ 逐条复核 op（词表 → CREATE 白名单）与参数结构
  const vocab = new Set(Object.keys(BRIDGE_COMMANDS));
  const allowed = new Set(CREATE_ALLOWED_OPS);
  const toCheck = [
    ...steps.map((s) => ({ where: `step ${s.step}`, op: s.op, args: s.args || {}, step: s.step })),
    ...(Array.isArray(execPlan.verify) ? execPlan.verify : [])
      .map((v) => ({ where: `verify`, op: v.op, args: v.args || {}, step: null })),
  ];
  for (const it of toCheck) {
    if (!vocab.has(it.op)) {
      gateFailures.push(`${it.where} 的 op '${it.op}' 不在 BRIDGE_COMMANDS 词表内`);
      continue;
    }
    if (!allowed.has(it.op)) {
      gateFailures.push(`${it.where} 的 op '${it.op}' 在词表内但**不在 CREATE 白名单内**`
        + '（删除类 / 发布类 / 截图等一律拒绝 —— 建页面不需要它们）');
      continue;
    }
    const v = validateStepArgs(it.op, it.args);
    if (!v.ok) {
      const parts = [];
      if (v.missing.length) parts.push(`缺少必填参数 ${v.missing.join('/')}`);
      for (const e of v.typeErrors) parts.push(`参数 ${e.param} 类型应为 ${e.expected}，实际 ${e.actual}`);
      gateInvalid.push({
        step: it.step, op: it.op, missing: v.missing, typeErrors: v.typeErrors,
        reason: `${it.where} 的 ${it.op} 参数不合规：${parts.join('；')}`,
      });
    }
  }

  if (gateFailures.length || gateInvalid.length) {
    report.status = 'refused';
    report.invalidSteps = gateInvalid;
    report.reason = [
      ...(gateFailures.length ? [`最终门禁未通过：${gateFailures.join('；')}`] : []),
      ...(gateInvalid.length ? [`参数复核不合规：${gateInvalid.map((x) => x.reason).join('；')}`] : []),
    ].join(' ｜ ');
    return { report };
  }

  if (!transport || typeof transport.send !== 'function') {
    report.reason = 'transport 缺失或没有 send(op,args) 方法（真实 Bridge 适配层尚未实现）';
    return { report };
  }

  // ── ② 逐步执行：第一条失败即停 ──
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

  // ── ④ 定 status：没有回读证据的"成功"不许叫 ok（第十一轮审查 P1）──
  //
  //   ok              步骤全成 + 回读全过（有证据的成功）
  //   ok-unverified   步骤全成，但**结果未验证**（无 verify 条目，或计划自己
  //                   声明了「无法回读验证」的能力缺失）→ 退 0 但必须让人看见
  //   verify-failed   回读不通过
  //   failed          步骤失败即停
  //   refused         门禁未过（一次都没调 transport）
  const readbackMissing = (Array.isArray(execPlan.unsupported) ? execPlan.unsupported : [])
    .some((u) => u && u.required === false && /无法回读/.test(String(u.reason || '')));

  if (!verifyList.length) {
    report.status = 'ok-unverified';
    report.advisories = ['execPlan 没有 verify 条目（回读能力缺失）→ 结果**未验证**，需人工核对'];
  } else if (!verifyOk) {
    // ★ onMismatch:'fail' → 命令 ok 也不能算成功 ★
    report.status = 'verify-failed';
  } else if (readbackMissing) {
    report.status = 'ok-unverified';
    report.advisories = ['回读能力缺失（计划声明无法回读验证）→ 结果**未验证**，需人工核对'];
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
