'use strict';
/**
 * src/core/net-guard.js —— 禁网守卫（PRD K1 / ARCHITECTURE 红线 1）
 *
 * 为什么需要：素材是公司未公开美术资产，**任何出站请求都是合规事故**。
 * 本模块在测试期扫描 src/ 源码，命中网络 API 即让测试失败。
 *
 * 设计上的两个自指陷阱及处理：
 *   1. 本文件自己包含网络 API 的「字面量」→ 模式串用片段拼接构造，源码里不出现完整词。
 *   2. 即使拼接，扫描器仍应跳过自身文件（scanSourceTree 的 excludeSelf，默认 true）。
 *   3. net-guard 是 core 层唯一的「策略」模块，不 import 上层，保持单向依赖（§8.6）。
 */

const fs = require('fs');
const path = require('path');

/** 用片段拼接构造敏感词，避免本文件源码里出现完整网络 API 字面量。 */
const F = {
  protoHttp: ['ht', 'tp'].join(''),
  protoHttps: ['ht', 'tps'].join(''),
  modDns: ['d', 'ns'].join(''),
  modNet: ['n', 'et'].join(''),
  modTls: ['t', 'ls'].join(''),
  modHttps: ['h', 'ttps'].join(''),
  modHttp: ['h', 'ttp'].join(''),
  fnFetch: ['fetc', 'h'].join(''),
  ctorXhr: ['XML', 'Http', 'Request'].join(''),
  ctorWs: ['Web', 'Socket'].join(''),
  modChildProc: ['child_pro', 'cess'].join(''),
  fnSpawnish: ['spa', 'wn'].join(''),
  // QA BUG #4 实测出的绕过手法对应的符号
  modUndici: ['und', 'ici'].join(''),      // Node 内置的真实出站 HTTP 客户端
  globalThis: ['global', 'This'].join(''), // globalThis.fetch 可绕过裸 fetch 检测
  procDlopen: ['dl', 'open'].join(''),      // 可加载原生模块
  procBinding: ['bind', 'ing'].join(''),    // 老式原生绑定入口
  modWorker: ['worker', '_threads'].join(''), // 可发起请求的线程入口
  // ★ QA 第二轮 P3 新增：三个都有真实出站能力，原先只报 warn，现提为 error
  modHttp2: ['htt', 'p2'].join(''),   // HTTP/2 出站（over TLS）
  modDgram: ['dgr', 'am'].join(''),   // UDP 出站（DNS/探测/隧道）
  modCluster: ['clust', 'er'].join(''), // 可 fork 出能联网的子进程
  modNetPlus: ['net', '+'].join(''),        // ESM 写法 node:net 的变体
  kwImport: ['im', 'port'].join(''),        // ESM import 语句
};

/**
 * 禁止模式表。
 * kind: 'require' = 模块引入；'call' = API 调用；'global' = 浏览器/Node 全局；'esm' = ESM 引入
 *
 * ★ QA BUG #4：补了 5 个实测可绕过的盲区 ★
 *   静态扫描有本质局限（动态拼接无法完全覆盖），但下面这些**确定能堵**：
 *     undici        —— Node 内置的真实出站客户端，比 fetch 更底层
 *     globalThis.fetch / window.fetch —— 绕开裸 `fetch(` 的检测
 *     process.dlopen / process.binding —— 加载原生模块（canvas.node 那种）
 *     worker_threads —— 可发起请求的线程入口
 *     ESM `import x from 'http'` —— 项目是 CJS，但产物可能混进 ESM
 * @type {{kind:string, re:RegExp, label:string, why:string}[]}
 */
const FORBIDDEN_PATTERNS = Object.freeze([
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.protoHttp}['"]\\s*\\)`),
    label: `require('${F.protoHttp}')`,
    why: 'HTTP 出站请求（PRD K1：素材禁止外发）',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.protoHttps}['"]\\s*\\)`),
    label: `require('${F.protoHttps}')`,
    why: 'HTTPS 出站请求（PRD K1）',
  },
  {
    // ★ 覆盖全部网络模块的 ESM 引入形式（QA 实测 `import http from 'http'` 可绕过）
    kind: 'esm',
    re: new RegExp(
      `\\b${F.kwImport}\\s+(?:[^;'"]*?\\bfrom\\s*)?['"](?:node:)?`
      + `(?:${F.protoHttps}|${F.protoHttp}|${F.modNet}|${F.modDns}|${F.modTls}`
      + `|${F.modUndici}|${F.modWorker}|${F.modHttp2}|${F.modDgram}|${F.modCluster})['"]`,
    ),
    label: 'ESM import <网络模块>',
    why: 'ESM 形式的网络模块引入（虽本项目是 CJS，仍应拦住）',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modHttp}['"]\\s*\\)`),
    label: `require('${F.modHttp}')`,
    why: 'HTTP 出站请求',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modHttps}['"]\\s*\\)`),
    label: `require('${F.modHttps}')`,
    why: 'HTTPS 出站请求',
  },
  {
    // ★ QA 第二轮 P3：http2 有真实出站能力（HTTP/2 over TLS），应为 error ★
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modHttp2}['"]\\s*\\)`),
    label: `require('${F.modHttp2}')`,
    why: 'http2 可建立 HTTP/2 出站连接（PRD K1）',
  },
  {
    // ★ QA 第二轮 P3：dgram（UDP）有真实出站能力，应为 error ★
    //   UDP 常被用来做 DNS 解析/端口探测/隧道，比 http 更难被网关发现。
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modDgram}['"]\\s*\\)`),
    label: `require('${F.modDgram}')`,
    why: 'dgram 可发 UDP 包（DNS 解析/端口探测/隧道），是真实出站能力（PRD K1）',
  },
  {
    // ★ QA 第二轮 P3：cluster 可拉起子进程（每个子进程都能联网），应为 error ★
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modCluster}['"]\\s*\\)`),
    label: `require('${F.modCluster}')`,
    why: 'cluster 可 forkWorker，每个 worker 都能独立联网（PRD K1）',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modNet}['"]\\s*\\)`),
    label: `require('${F.modNet}')`,
    why: 'net 模块可建 socket',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modDns}['"]\\s*\\)`),
    label: `require('${F.modDns}')`,
    why: 'DNS 解析属于网络出站',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modTls}['"]\\s*\\)`),
    label: `require('${F.modTls}')`,
    why: 'TLS 模块可建加密连接',
  },
  {
    // ★ QA 实测可绕过：undici 是 Node 内置的真实出站能力
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modUndici}['"]\\s*\\)`),
    label: `require('${F.modUndici}')`,
    why: 'undici 是 Node 内置的真实出站 HTTP 客户端（比 fetch 更底层）',
  },
  {
    kind: 'require',
    re: new RegExp(`require\\(\\s*['"](node:)?${F.modWorker}['"]\\s*\\)`),
    label: `require('${F.modWorker}')`,
    why: 'worker_threads 可用于发起请求',
  },
  {
    kind: 'call',
    re: new RegExp(`\\b${F.modNet}\\s*\\.\\s*(connect|createConnection|Socket|createServer)\\s*\\(`),
    label: `${F.modNet}.connect()`,
    why: 'socket 连接',
  },
  {
    kind: 'call',
    re: new RegExp(`\\b${F.fnFetch}\\s*\\(`),
    label: `${F.fnFetch}()`,
    why: '全局 fetch 可发起请求',
  },
  {
    // ★ QA 实测可绕过：globalThis.fetch 不含 "fetch(" 的裸调用形态
    kind: 'call',
    re: new RegExp(`\\b${F.globalThis}\\s*\\.\\s*${F.fnFetch}\\b`),
    label: `${F.globalThis}.${F.fnFetch}`,
    why: 'globalThis 引用可绕过裸 fetch 检测（QA 实测）',
  },
  {
    kind: 'call',
    re: new RegExp(`\\bprocess\\s*\\.\\s*${F.procDlopen}\\s*\\(`),
    label: `process.${F.procDlopen}()`,
    why: '可加载原生模块（QA 实测绕过手法）',
  },
  {
    kind: 'call',
    re: new RegExp(`\\bprocess\\s*\\.\\s*${F.procBinding}\\s*\\(`),
    label: `process.${F.procBinding}()`,
    why: '老式原生绑定入口（QA 实测绕过手法）',
  },
  {
    kind: 'global',
    re: new RegExp(`\\b${F.ctorXhr}\\b`),
    label: F.ctorXhr,
    why: 'XHR 可发起请求',
  },
  {
    kind: 'global',
    re: new RegExp(`\\b${F.ctorWs}\\b`),
    label: F.ctorWs,
    why: 'WebSocket 可发起连接',
  },
  {
    kind: 'call',
    re: new RegExp(`\\b${F.modChildProc}\\b`),
    label: F.modChildProc,
    why: '子进程可拉起 curl/PowerShell 绕过守卫',
  },
]);

/**
 * 已审查的 loopback 例外表（**src/ 里唯一的网络能力**，PRD K1 的唯一豁免）。
 *
 * ★ 为什么需要这张表 ★
 *   `create-run` 必须与本机 FairyGUI 编辑器里的 agent-bridge 插件通信
 *   （HTTP loopback，默认 127.0.0.1:7531 —— 见 `docs/BRIDGE-TRANSPORT.md`），
 *   没有 HTTP 客户端就完不成这件事。而**静态守卫分不清**「连本机编辑器」
 *   与「把公司素材发到外网」。与其逼着后人把模块名拆串拼接绕过守卫
 *   （那才是真的失守），不如把唯一例外**显式登记、逐条限定、被测试钉住**：
 *     · 只豁免 `require('http')` / `require('https')` 两个模块引入字面量；
 *     · 命中降级为 `reviewed`（仍进报告、仍打印，**不静默**）；
 *     · 例外表由 `test/unit/net-guard.test.js` 钉死 —— 想悄悄加条目/加能力会红。
 *
 * 安全边界（为什么这不算违反 K1）：
 *   · 目标 URL 只能来自显式 `--bridge-url` / env `FGUI_BRIDGE_URL`，默认 127.0.0.1；
 *   · 请求体只有 Bridge 命令与参数，**不含任何素材内容**（素材从不出本机）；
 *   · 本表之外，src/ 任何网络 API 仍是 error 级、照样让测试红。
 *
 * @type {Object<string,string>} 相对 src/ 的路径 -> 豁免理由（必须写清为什么安全）
 */
const REVIEWED_EXCEPTIONS = Object.freeze({
  'create/bridge-http.js':
    '唯一允许的网络能力：POST 本机 FairyGUI 编辑器 Bridge（loopback 127.0.0.1:7531，'
    + '契约见 docs/BRIDGE-TRANSPORT.md）。URL 只来自显式 --bridge-url / env FGUI_BRIDGE_URL，'
    + '请求体仅含 Bridge 命令与参数，不含任何素材数据。',
});

/**
 * 例外只豁免这两个**模块引入字面量**。豁免文件里出现任何其它网络能力
 * （fetch / WebSocket / net.connect / 动态拼接 require …）仍是 error 级。
 * @type {Set<string>}
 */
const EXEMPTED_LABELS = Object.freeze(new Set([
  `require('${F.protoHttp}')`,
  `require('${F.protoHttps}')`,
]));

/**
 * 允许的 Node 内置模块白名单（纯本地能力，不产生网络出站）。
 *
 * ★ QA BUG #4：这一段以前是「导出了但从不被引用」的死代码 ★
 *   QA 的原话：「留着比删掉更坏，它造成虚假的安全感」。
 *   现在它被 scanContent 的**反向检查**真正使用：
 *   若代码 require 了既不在白名单、也不在任何禁止模式里的第三方模块，
 *   会以 `warn` 级命中报出（不阻断，但让人知道「这个模块没被审查过」）。
 *   这样白名单才是真的在起作用，而不是一个摆设。
 *
 * @type {Set<string>}
 */
const ALLOWED_BUILTINS = Object.freeze(new Set([
  'fs', 'path', 'crypto', 'os', 'url', 'util', 'stream',
  'assert', 'buffer', 'zlib', 'events', 'string_decoder', 'querystring',
  // 本项目用到的非网络模块（ag-psd / sharp / pngjs / image-size / node:sqlite）
  'ag-psd', 'sharp', 'pngjs', 'image-size', 'node:sqlite',
]));

/**
 * 匹配 require/import 的模块名（非网络模块，用于白名单反向检查）。
 * 只匹配字面量形式 —— `require(变量)` 这类动态形式静态无法判断，
 * 由「动态 require 检测」单独告警（见 FORBIDDEN_PATTERNS 的 dynamic 条目说明）。
 */
const REQUIRE_LITERAL_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 动态 require（`require(变量)`）—— 无法静态判断，但至少要让人看见。 */
const DYNAMIC_REQUIRE_RE = /\brequire\s*\(\s*(?!['"])[A-Za-z_$][\w.$]*\s*\)/g;

/**
 * 判断一行是否落在「注释或字符串里」的弱命中。
 * 保守策略：只要出现即视为命中（宁可误报也不漏报），但会剔除明显的行注释。
 * @param {string} line
 * @returns {boolean} true 表示可跳过
 */
function isCommentOnly(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) return true;
  return false;
}

/**
 * 扫描单个文件内容。
 *
 * 两类命中：
 *   severity='error' —— 明确的网络能力，必须修
 *   severity='warn'  —— 未被审查过的模块 / 动态 require，需人工确认
 *
 * ★ warn 级不是「摆设」★：QA 指出 ALLOWED_BUILTINS 以前导出了却从不被引用，
 *   造成虚假的安全感。现在它真正参与判断：require 了白名单外的模块会报 warn，
 *   让人知道「这个模块的行为没被本守卫审查过」。
 *
 * @param {string} relPath 用于报告的相对路径
 * @param {string} content
 * @param {Object} [opts]
 * @param {boolean} [opts.warnUnreviewed=true] 未审查模块是否报 warn
 * @returns {{file:string, line:number, label:string, why:string, kind:string,
 *            severity:string, text:string}[]}
 */
function scanContent(relPath, content, opts) {
  const warnUnreviewed = !opts || opts.warnUnreviewed !== false;
  const hits = [];
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnly(line)) continue;
    // 同一行可能被多个模式命中（如 require('http') 同时匹配 require 与 esm 规则），
    // 去重后只报一次 —— 报告里重复列同一行只会让人以为是多个问题
    const seenError = new Set();
    for (const p of FORBIDDEN_PATTERNS) {
      if (!p.re.test(line)) continue;
      const key = `${p.kind}:${p.label}`;
      if (seenError.has(key)) continue;
      seenError.add(key);
      hits.push({
        file: relPath,
        line: i + 1,
        label: p.label,
        why: p.why,
        kind: p.kind,
        severity: 'error',
        text: line.trim().slice(0, 160),
      });
    }
    if (!warnUnreviewed) continue;

    // ---- 白名单反向检查：未被审查的**外部**模块 ----
    // ★ 只看裸模块名（不含 ./ ../ 前缀）：项目内部模块是我们自己写的，
    //   逐个报「未审查」纯属噪声，会让人真正忽略 warn（狼来了）。
    //   外部依赖才需要审查 —— 「这个包会不会偷偷发请求」是个真问题。
    REQUIRE_LITERAL_RE.lastIndex = 0;
    let m = REQUIRE_LITERAL_RE.exec(line);
    while (m) {
      const mod = m[1];
      if (!mod.startsWith('.')) {
        const bare = mod.replace(/^node:/, '');
        // 已被 error 命中的（网络模块）不再重复报 unreviewed —— 同一行一件事
        const alreadyError = hits.some((h) => h.line === i + 1 && h.severity === 'error');
        if (!alreadyError && !ALLOWED_BUILTINS.has(mod) && !ALLOWED_BUILTINS.has(bare)) {
          hits.push({
            file: relPath,
            line: i + 1,
            label: `require('${mod}')`,
            why: `外部模块 '${mod}' 不在 ALLOWED_BUILTINS 白名单内 —— 其行为未被本守卫审查过，`
              + '请人工确认它不含网络能力（白名单的用途就在这里，不是摆设）',
            kind: 'unreviewed-module',
            severity: 'warn',
            text: line.trim().slice(0, 160),
          });
        }
      }
      m = REQUIRE_LITERAL_RE.exec(line);
    }

    // ---- 动态 require：静态无法判断，但至少要让人看见 ----
    if (DYNAMIC_REQUIRE_RE.test(line)) {
      hits.push({
        file: relPath,
        line: i + 1,
        label: 'require(<变量>)',
        why: '动态 require 的目标静态不可判定 —— 本守卫无法验证它是否引入网络能力，'
          + '请改为字面量 require 以便被审查',
        kind: 'dynamic-require',
        severity: 'warn',
        text: line.trim().slice(0, 160),
      });
    }
  }
  return hits;
}

/**
 * 递归收集目录下所有 .js/.cjs/.mjs 文件（确定性排序）。
 * @param {string} dir
 * @param {string} [base] 相对化基准
 * @returns {string[]}
 */
function collectSourceFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...collectSourceFiles(full, base));
    } else if (/\.(js|cjs|mjs)$/.test(entry.name)) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * 扫描源码树，返回全部违规。
 * @param {string} rootDir 源码根（通常是 src/）
 * @param {Object} [opts]
 * @param {boolean} [opts.excludeSelf=true] 跳过 net-guard.js 自身
 * @param {string} [opts.selfFile='core/net-guard.js']
 * @returns {{file:string, line:number, label:string, why:string, kind:string, text:string}[]}
 */
function scanSourceTree(rootDir, opts = {}) {
  const excludeSelf = opts.excludeSelf !== false;
  const selfFile = opts.selfFile || 'core/net-guard.js';
  const files = collectSourceFiles(rootDir);
  const hits = [];
  for (const rel of files) {
    if (excludeSelf && rel.replace(/\\/g, '/') === selfFile) continue;
    const abs = path.join(rootDir, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // 读不到的文件不是网络违规，跳过
    }
    const fileHits = scanContent(rel, content);
    // 已登记例外：只把「豁免清单内的模块引入」降级为 reviewed（仍可见、不阻断），
    // 其余命中（哪怕是同一个文件里的 fetch）保持 error 级不动。
    const exception = REVIEWED_EXCEPTIONS[rel.replace(/\\/g, '/')];
    if (exception) {
      for (const h of fileHits) {
        if (h.severity === 'error' && EXEMPTED_LABELS.has(h.label)) {
          h.severity = 'reviewed';
          h.exception = exception;
        }
      }
    }
    hits.push(...fileHits);
  }
  return hits;
}

/**
 * 人类可读的报告（测试失败时直接打印，比裸 true/false 有用得多 —— §8.4 失败姿态）。
 * @param {{file:string, line:number, label:string, why:string, text:string}[]} hits
 * @returns {string}
 */
function formatReport(hits) {
  if (!hits.length) return 'net-guard: src/ 未发现任何网络 API 引用 ✅';
  const lines = ['net-guard 发现违规（PRD K1 禁网红线）：'];
  for (const h of hits) {
    if (h.severity === 'reviewed') {
      // 已登记豁免：明说「这是什么、为什么被放过」，绝不静默
      lines.push(`  - ${h.file}:${h.line}  ${h.label}  // [已登记豁免] ${h.exception}`);
    } else {
      lines.push(`  - ${h.file}:${h.line}  ${h.label}  // ${h.why}`);
    }
    lines.push(`      ${h.text}`);
  }
  lines.push('修复：移除该引用。P0 全链路不需要任何网络能力。');
  return lines.join('\n');
}

/**
 * 断言源码树无网络 API。违规则抛错。
 * @param {string} rootDir
 * @param {Object} [opts] 透传 scanSourceTree
 * @throws {Error} 含完整违规清单
 */
function assertNoNetwork(rootDir, opts) {
  const hits = scanSourceTree(rootDir, opts);
  // error 级阻断；warn / reviewed 级不阻断但必须被人看见（打印出来，不静默吞）
  const errors = hits.filter((h) => h.severity === 'error');
  const visible = hits.filter((h) => h.severity !== 'error');
  if (errors.length) throw new Error(formatReport(errors));
  if (visible.length && !(opts && opts.quiet)) {
    process.stderr.write(formatReport(visible) + '\n');
  }
  return true;
}

module.exports = {
  FORBIDDEN_PATTERNS,
  ALLOWED_BUILTINS,
  REQUIRE_LITERAL_RE,
  REVIEWED_EXCEPTIONS,
  scanSourceTree,
  scanContent,
  formatReport,
  assertNoNetwork,
};
