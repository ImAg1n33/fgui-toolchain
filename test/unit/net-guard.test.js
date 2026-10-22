'use strict';
/**
 * test/unit/net-guard.test.js —— K1 禁网守卫自证
 *
 * ★ 这是「红线要有测试证明」的第一条 ★（ARCHITECTURE §8.4 / PRD K1）
 *
 * 素材是公司未公开美术资产。任何网络出站请求都是合规事故。
 * 本测试扫描 src/ 全部源码，命中网络 API 即失败。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  scanSourceTree, scanContent, formatReport, assertNoNetwork, REVIEWED_EXCEPTIONS,
} = require('../../src/core/net-guard');

const SRC = path.resolve(__dirname, '../../src');

test('K1 禁网: src/ 中零网络 API 引用', () => {
  // ★ 只对 error 级断言零命中。warn 级是「需人工看一眼」的分级告警
  //   （如动态 require、未审查的外部依赖），不是违规 —— 见 BUG#4 修复说明。
  //   reviewed 级是 create/bridge-http.js 的**已登记豁免**（loopback Bridge
  //   客户端，理由见 net-guard.js 的 REVIEWED_EXCEPTIONS 与本文件末尾的钉死测试）。
  const hits = scanSourceTree(SRC).filter((h) => h.severity === 'error');
  assert.equal(hits.length, 0,
    `src/ 中发现网络 API 引用（PRD K1 禁网红线）：\n${formatReport(hits)}`);
});

test('K1 禁网: assertNoNetwork 不抛错', () => {
  assert.equal(assertNoNetwork(SRC, { quiet: true }), true);
});

test('K1 禁网: src/ 中零 Math.random（确定性红线，B9）', () => {
  // Math.random 会破坏 B9「同一输入跑 3 次逐字节一致」
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs)$/.test(e.name)) files.push(full);
    }
  };
  walk(SRC);
  const offenders = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) return;
      if (t.includes('Math.random')) offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
    });
  }
  assert.equal(offenders.length, 0,
    `src/ 中发现 Math.random（会破坏 B9 确定性）：${offenders.join(', ')}`);
});

test('K1 禁网: src/ 中零 Date.now（时间戳只能进 run_meta 与 .bak 文件名）', () => {
  // 允许出现在 atomic.js（.bak.<ts> 文件名）—— 故只检查非 atomic 模块
  const allowed = new Set(['core/atomic.js']);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs)$/.test(e.name)) files.push(full);
    }
  };
  walk(SRC);
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    if (allowed.has(rel)) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) return;
      if (t.includes('Date.now()')) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.equal(offenders.length, 0,
    `src/ 中发现 Date.now()（时间戳只允许出现在 run_meta.json 与 .bak 文件名）：${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------
// 守卫本身的有效性：给它一段有网络的代码，它必须报警。
// 一个从不报警的守卫等于没有守卫，所以这里必须验证它「会红」。
// ---------------------------------------------------------------------
test('守卫自检: 命中 require(http) 应被捕获', () => {
  const hits = scanContent('evil.js', "const h = require('http');");
  assert.ok(hits.length >= 1, '守卫必须捕获 require(http)');
});

test('守卫自检: 命中 require(https) 应被捕获', () => {
  const hits = scanContent('evil.js', 'const h = require("https");');
  assert.ok(hits.length >= 1);
});

test('守卫自检: 命中 node: 前缀形式应被捕获', () => {
  assert.ok(scanContent('evil.js', "require('node:http')").length >= 1);
  assert.ok(scanContent('evil.js', "require('node:dns')").length >= 1);
});

test('守卫自检: 命中 net.connect / fetch / XHR 应被捕获', () => {
  assert.ok(scanContent('evil.js', 'net.connect(80, "1.2.3.4")').length >= 1);
  assert.ok(scanContent('evil.js', 'const r = await fetch(url)').length >= 1);
  assert.ok(scanContent('evil.js', 'new XMLHttpRequest()').length >= 1);
  assert.ok(scanContent('evil.js', 'new WebSocket("ws://x")').length >= 1);
});

test('守卫自检: 纯本地代码不应误报', () => {
  assert.equal(scanContent('good.js', "const fs = require('fs');\nconst p = require('path');").length, 0);
  assert.equal(scanContent('good.js', "// 注释里提到网络但不是代码\nconst x = 1;").length, 0);
});

test('守卫自检: 误报检查 —— 变量名含 net/dns 但不是 API 调用', () => {
  // 这类不应误报，否则守卫会被人为忽略（狼来了）
  assert.equal(scanContent('ok.js', 'const network = 1; const dnsRecord = {};').length, 0);
});

// ======================================================================
// ★ BUG#4 回归：补 QA 实测出的 5 个绕过盲区
// ======================================================================
//
// QA 实测的绕过手法与「守卫是否捕获」：
//   require(变量)             旧版未捕获 -> 现报 warn（动态 require 不可静态判定）
//   import http from 'http'   旧版未捕获 -> 现捕获（ESM 形式）
//   globalThis.fetch          旧版未捕获 -> 现捕获
//   require('undici')         旧版未捕获 -> 现捕获（Node 内置的真实出站能力）
//   process.dlopen(...)       旧版未捕获 -> 现捕获
//
// ★ 关于 warn 而非 error 的取舍：
//   动态 require 的目标静态不可判定，若一律判 error 会逼着人绕过守卫
//   （比如把网络模块名拆开拼接），那更糟。故 error=确定有网络能力，
//   warn=需要人看一眼。前者阻断测试，后者打印出来但不阻断。

test('★ 绕过#1: ESM import http 应被捕获', () => {
  const hits = scanContent('e.js', "import http from 'http';");
  assert.ok(hits.length >= 1, 'ESM import 必须捕获');
  assert.ok(hits.some((h) => h.severity === 'error'), 'ESM 引入网络模块应判 error');
  assert.ok(scanContent('e.js', "import https from 'node:https';").length >= 1);
  assert.ok(scanContent('e.js', "import dns from 'node:dns';").length >= 1);
  // 只 import 本地模块不应误报
  assert.equal(scanContent('e.js', "import fs from 'node:fs';").filter((h) => h.severity === 'error').length, 0);
});

test('★ 绕过#2: globalThis.fetch 应被捕获', () => {
  const hits = scanContent('e.js', 'globalThis.fetch(url)');
  assert.ok(hits.length >= 1, 'globalThis.fetch 必须捕获');
  assert.ok(hits.some((h) => h.severity === 'error'), '应判为 error 级');
});

test('★ 绕过#3: require(\'undici\') 应被捕获（Node 内置出站客户端）', () => {
  const hits = scanContent('e.js', "const u = require('undici');");
  assert.ok(hits.length >= 1, 'undici 是真实出站能力，必须捕获');
  assert.ok(hits[0].why.includes('出站'), '告警应说明这是出站能力');
  assert.ok(scanContent('e.js', "require('node:undici')").length >= 1);
});

test('★ 绕过#4: process.dlopen / process.binding 应被捕获', () => {
  assert.ok(scanContent('e.js', "process.dlopen(m, p)").length >= 1);
  assert.ok(scanContent('e.js', "process.binding('fs')").length >= 1);
});

test('★ 绕过#5: 动态 require 应被报出（哪怕只是 warn）', () => {
  const hits = scanContent('e.js', "const m = 'ht' + 'tp'; require(m);");
  assert.ok(hits.length >= 1, '动态 require 必须被看见');
  assert.ok(hits.some((h) => h.kind === 'dynamic-require'));
});

test('★ ALLOWED_BUILTINS 不再是死代码（未审查的外部模块会报 warn）', () => {
  // 白名单内的模块：静默
  assert.equal(scanContent('a.js', "require('fs')").filter((h) => h.kind === 'unreviewed-module').length, 0);
  assert.equal(scanContent('a.js', "require('sharp')").filter((h) => h.kind === 'unreviewed-module').length, 0,
    '已审查并列入白名单的依赖不应报 warn');
  assert.equal(scanContent('a.js', "require('node:sqlite')").filter((h) => h.kind === 'unreviewed-module').length, 0);

  // 白名单外的外部模块：报 warn（不阻断，但要让人看见）
  const hits = scanContent('a.js', "require('some-unknown-pkg')")
    .filter((h) => h.kind === 'unreviewed-module');
  assert.equal(hits.length, 1, '★ 未列入白名单的外部模块必须报 warn');
  assert.equal(hits[0].severity, 'warn');
  assert.ok(hits[0].why.includes('白名单'), '告警应说明白名单的用途');

  // 项目内部模块（相对路径）不应报 —— 否则噪声会让人真正忽略 warn
  assert.equal(scanContent('a.js', "require('../core/hash')").filter((h) => h.kind === 'unreviewed-module').length, 0,
    '项目内部相对路径 require 不应报 warn（否则全是噪声）');
  assert.equal(scanContent('a.js', "require('./x')").filter((h) => h.kind === 'unreviewed-module').length, 0);
});

test('★ src/ 扫描：0 error 级命中', () => {
  const path = require('path');
  const hits = scanSourceTree(path.resolve(__dirname, '../../src'));
  const errors = hits.filter((h) => h.severity === 'error');
  assert.equal(errors.length, 0,
    `src/ 出现网络 API：\n${formatReport(errors)}`);
});

// ======================================================================
// ★ 唯一豁免的钉死测试（bridge HTTP 传输层引入后新增）
//
// create/bridge-http.js 是 src/ 里**唯一**需要网络能力的文件：它只 POST
// 本机 FairyGUI 编辑器 Bridge（loopback，契约见 docs/BRIDGE-TRANSPORT.md）。
// 豁免必须满足全部四条，缺一条即红：
//   ① 例外表只有一个条目，且就是 create/bridge-http.js；
//   ② 该文件被降级的命中**恰好**是 require('http') / require('https') 两个；
//   ③ 豁免不会放大：同一路径下出现 fetch 等其它网络能力仍是 error；
//   ④ 豁免是「降级」而非「消失」—— reviewed 命中必须仍带豁免理由。
// ======================================================================

test('★ 豁免①: REVIEWED_EXCEPTIONS 只有一个条目（create/bridge-http.js）', () => {
  assert.deepEqual(Object.keys(REVIEWED_EXCEPTIONS), ['create/bridge-http.js'],
    '★ 例外表不许悄悄变长 —— 每一条都是 PRD K1 的让步，必须单独评审');
  const reason = REVIEWED_EXCEPTIONS['create/bridge-http.js'];
  assert.ok(/loopback|127\.0\.0\.1/.test(reason), '豁免理由必须写明 loopback 边界');
  assert.ok(/不含任何素材/.test(reason), '豁免理由必须声明请求体不含素材数据');
});

test('★ 豁免②: 被降级的命中恰好是 http/https 两个模块引入', () => {
  const hits = scanSourceTree(SRC).filter((h) => h.severity === 'reviewed');
  assert.equal(hits.length, 2,
    `★ 降级命中必须恰好 2 条（http + https），实得：\n${formatReport(hits)}`);
  assert.deepEqual(hits.map((h) => h.label).sort(),
    ["require('http')", "require('https')"].sort());
  for (const h of hits) {
    assert.equal(h.file, 'create/bridge-http.js');
    assert.equal(h.kind, 'require');
    assert.equal(typeof h.exception, 'string');
    assert.ok(h.exception.length > 10, 'reviewed 命中必须携带豁免理由（不静默）');
  }
  // 降级不等于消失：assertNoNetwork 仍能看见它们（打印但不阻断）
  assert.equal(assertNoNetwork(SRC, { quiet: true }), true);
});

test('★ 豁免③: 豁免不会放大 —— 同路径出现 fetch 仍是 error 级', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-guard-exempt-'));
  try {
    fs.mkdirSync(path.join(dir, 'create'));
    fs.writeFileSync(path.join(dir, 'create/bridge-http.js'),
      "require('http');\nrequire('https');\nconst r = await fetch(url);\n", 'utf8');
    const hits = scanSourceTree(dir, { excludeSelf: false });
    const errors = hits.filter((h) => h.severity === 'error');
    const reviewed = hits.filter((h) => h.severity === 'reviewed');
    assert.equal(reviewed.length, 2, '两个 require 仍被豁免');
    assert.equal(errors.length, 1, '★ fetch 不在豁免清单内，必须保持 error');
    assert.equal(errors[0].file, 'create/bridge-http.js');
    assert.throws(() => assertNoNetwork(dir, { excludeSelf: false, quiet: true }),
      (err) => {
        assert.match(err.message, /fetch/);
        return true;
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 豁免④: 其它文件的 http require 一律不豁免（回归）', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-guard-noexempt-'));
  try {
    fs.mkdirSync(path.join(dir, 'create'));
    // 同名不同路径（不在例外表里）→ 必须 error
    fs.writeFileSync(path.join(dir, 'other.js'), "require('http');\n", 'utf8');
    const hits = scanSourceTree(dir, { excludeSelf: false });
    assert.equal(hits.filter((h) => h.severity === 'error').length, 1,
      '★ 不在 REVIEWED_EXCEPTIONS 里的文件，require(http) 必须 error');
    assert.equal(hits.filter((h) => h.severity === 'reviewed').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ src/ 扫描：无未审查的外部模块（依赖白名单是完整的）', () => {
  const path = require('path');
  const hits = scanSourceTree(path.resolve(__dirname, '../../src'))
    .filter((h) => h.kind === 'unreviewed-module');
  assert.equal(hits.length, 0,
    `src/ 引入了未列入 ALLOWED_BUILTINS 的外部模块，请审查其网络行为并加入白名单：\n`
    + hits.map((h) => `  ${h.file}:${h.line} ${h.label}`).join('\n'));
});

test('★ 守卫分级：error 阻断、warn 仅告警', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.js'), "require('http');", 'utf8');
    fs.writeFileSync(path.join(dir, 'warn.js'), "require('unknown-pkg');", 'utf8');
    fs.writeFileSync(path.join(dir, 'ok.js'), "const fs = require('fs');", 'utf8');

    const hits = scanSourceTree(dir, { excludeSelf: false });
    assert.equal(hits.filter((h) => h.severity === 'error').length, 1,
      `http 应判 error，实际: ${JSON.stringify(hits)}`);
    assert.equal(hits.filter((h) => h.severity === 'warn').length, 1,
      `未知包应判 warn，实际: ${JSON.stringify(hits)}`);
    assert.throws(() => assertNoNetwork(dir, { excludeSelf: false, quiet: true }),
      (err) => {
        assert.match(err.message, /违规/, 'error 级必须让 assertNoNetwork 抛错');
        return true;
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ======================================================================
// ★ QA 第二轮 P3：http2 / dgram / cluster 提为 error
// ======================================================================
//
// QA 实测这三个「只报 warn」，但它们都有真实出站能力：
//   http2   -> HTTP/2 over TLS 出站
//   dgram   -> UDP 出站（DNS 解析 / 端口探测 / 隧道；比 http 更难被网关发现）
//   cluster -> 可 forkWorker，每个子进程都能独立联网
//
// 保留 warn 的四个（inspector/repl/vm/module）经复核**确实无出站能力**，
// 故维持 warn —— 「有风险就 error」会退化成「什么都 error」，守卫就没人看了。
test('★ QA2-P3: http2 / dgram / cluster 必须判 error（真实出站能力）', () => {
  const cases = [
    ['http2', 'HTTP/2 over TLS 出站'],
    ['dgram', 'UDP 出站（DNS/探测/隧道）'],
    ['cluster', '可 fork 出能联网的子进程'],
  ];
  for (const [mod, why] of cases) {
    const hits = scanContent('e.js', `require('${mod}');`);
    const errs = hits.filter((h) => h.severity === 'error');
    assert.equal(errs.length, 1, `★ require('${mod}') 应判 error，实际 ${JSON.stringify(hits)}`);
    assert.ok(errs[0].why.includes('出站') || errs[0].why.includes('联网'),
      `${mod} 的告警理由应说明出站能力（${why}），实得: ${errs[0].why}`);
  }
});

test('★ QA2-P3: node: 前缀形式同样拦截', () => {
  for (const mod of ['http2', 'dgram', 'cluster']) {
    const errs = scanContent('e.js', `require('node:${mod}');`)
      .filter((h) => h.severity === 'error');
    assert.equal(errs.length, 1, `require('node:${mod}') 应判 error`);
  }
});

test('★ QA2-P3: ESM import 形式同样拦截', () => {
  for (const mod of ['http2', 'dgram', 'cluster']) {
    const errs = scanContent('e.js', `import x from '${mod}';`)
      .filter((h) => h.severity === 'error');
    assert.equal(errs.length, 1, `import from '${mod}' 应判 error`);
  }
});

test('★ QA2-P3: 11 个真实出站模块全部 ERROR，无一漏网', () => {
  const MUST_ERROR = [
    'http', 'https', 'net', 'dns', 'tls',
    'dgram', 'child_process', 'worker_threads', 'cluster', 'http2', 'undici',
  ];
  for (const mod of MUST_ERROR) {
    const errs = scanContent('e.js', `require('${mod}');`)
      .filter((h) => h.severity === 'error');
    assert.equal(errs.length, 1, `★ require('${mod}') 必须 error —— 漏网即守卫失效`);
  }
});

test('★ QA2-P3: 无出站能力的模块维持 warn（不升级为 error，避免守卫通胀）', () => {
  // 这四个经复核确实不能联网：inspector 是调试协议、repl 是交互式求值、
  // vm 是沙箱上下文、module 是加载器。若把它们也升成 error，
  // 守卫会开始报大量无关命中，最终没人看它 —— 那才是真正的失守。
  for (const mod of ['inspector', 'repl', 'vm', 'module']) {
    const hits = scanContent('e.js', `require('${mod}');`);
    assert.equal(hits.filter((h) => h.severity === 'error').length, 0,
      `★ require('${mod}') 无出站能力，不应判 error（会制造噪声）`);
    assert.equal(hits.filter((h) => h.severity === 'warn').length, 1,
      `require('${mod}') 应报 1 条 warn（需人工看一眼），实得 ${JSON.stringify(hits)}`);
  }
});

test('★ QA2-P3: 白名单本地模块不产生任何命中（回归）', () => {
  for (const mod of ['fs', 'path', 'crypto', 'os', 'url', 'util', 'stream', 'sharp', 'ag-psd', 'node:sqlite']) {
    const hits = scanContent('e.js', `require('${mod}');`);
    assert.equal(hits.length, 0, `★ require('${mod}') 是已审查的本地模块，不应有任何命中`);
  }
});
