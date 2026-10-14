'use strict';
/** QA 独立验证：禁网守卫反向验证 —— 一个从不报警的守卫等于没有守卫 */
const { scanContent, scanSourceTree, ALLOWED_BUILTINS } = require('../src/core/net-guard');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

console.log('=== QA-6.1 恶意样本必须被守卫捕获 ===');
const evil = [
  ["require('http')", "const h = require('http');"],
  ["require('node:http')", "const h = require('node:http');"],
  ["require('https')", "const h = require('https');"],
  ["require('net')", "const n = require('net');"],
  ["require('node:net')", "const n = require('node:net');"],
  ["require('dns')", "const d = require('dns');"],
  ["require('tls')", "const t = require('tls');"],
  ["net.connect()", "net.connect(80, 'x.com');"],
  ["fetch()", "await fetch('http://a');"],
  ["XMLHttpRequest", "const x = new XMLHttpRequest();"],
  ["WebSocket", "const w = new WebSocket('ws://a');"],
  ["child_process", "const cp = require('child_process');"],
  ["双引号 require", 'const h = require("http");'],
  ["带空格 require", "const h = require( 'http' );"],
  ["node: 前缀+https", "const h = require('node:https');"],
];
for (const [name, src] of evil) {
  const hits = scanContent('evil.js', src);
  ok(`捕获: ${name}`, hits.length > 0, `hits=${hits.length}`);
}

console.log('\n=== QA-6.2 守卫的已知盲区探测（构造绕过） ===');
// 盲区 1: 变量名 require 拼接 —— 静态扫描无法判定目标模块
// ★ 修复后（BUG#4）：不再「静默放过」，而是报 warn 级 —— 让人看见这件事需要人工确认。
//   判为 error 会逼人把网络模块名拆开拼接以绕过守卫，那更糟。
const evade1 = "const m = 'ht' + 'tp'; const h = require(m);";
const evadeHits = scanContent('e.js', evade1);
ok('[已修复] 动态 require 被报出（warn 级）',
   evadeHits.some(h=>h.kind==='dynamic-require' && h.severity==='warn'),
   `实际命中: ${JSON.stringify(evadeHits)}`);
ok('[已修复] 动态 require 不判 error（否则会逼人绕过守卫）',
   !evadeHits.some(h=>h.kind==='dynamic-require' && h.severity==='error'));
// 盲区 2: 行内注释后跟代码? 不, 那是代码
// 盲区 3: 多行注释中的 require —— isCommentOnly 只看行首
const inBlockComment = "/*\nconst h = require('http');\n*/";
ok('[已知局限] 块注释内 require 会被误报', scanContent('e.js', inBlockComment).length > 0,
   '误报方向（保守），可接受');
// 盲区 4: import 语法（ESM）
const esm = "import http from 'http';";
ok('[盲区?] ESM import http 被捕获?', scanContent('e.js', esm).length > 0,
   `hits=${scanContent('e.js', esm).length} —— 若为0则是守卫盲区(项目是CJS,风险低)`);
// 盲区 5: 全局 node:https 常量
const g = "globalThis.fetch";
ok('[盲区?] globalThis.fetch', scanContent('e.js', g).length > 0, `hits=${scanContent('e.js',g).length}`);
// 盲区 6: undici / node:sqlite 扩展
const undici = "const { request } = require('undici');";
ok('[盲区] require(undici)', scanContent('e.js', undici).length > 0,
   `hits=${scanContent('e.js', undici).length} —— undici 是真实出站能力`);
// 盲区 7: process.binding / dlopen
const dl = "process.dlopen(module, 'x.node')";
ok('[盲区] process.dlopen', scanContent('e.js', dl).length > 0, `hits=${scanContent('e.js',dl).length}`);
// 盲区 8: node:inspector / node:worker_threads 里其实也能 net? 不测
// 盲区 9: dns.promises
const dns2 = "const dns = require('node:dns');";
ok('[盲区] node:dns', scanContent('e.js', dns2).length > 0, `hits=${scanContent('e.js',dns2).length}`);
// 盲区 10: worker_threads + Atomics? 略

console.log('\n=== QA-6.3 真实 src/ 树扫描 ===');
// ★ 按分级判断：error=确定有网络能力（必须为 0）；warn=需人工看一眼（如动态 require）
const hits = scanSourceTree(path.join(__dirname, '..', 'src'));
const errors = hits.filter(h=>h.severity!=='warn');
const warns = hits.filter(h=>h.severity==='warn');
ok('src/ 零 error 级网络 API 命中', errors.length === 0, JSON.stringify(errors, null, 2));
console.log(`  info: warn 级 ${warns.length} 条（动态 require / 未审查的外部模块，需人工看一眼）`);
warns.forEach(w=>console.log(`    - ${w.file}:${w.line} ${w.label}`));
console.log(`  扫描文件数: ${require('../src/core/net-guard').scanSourceTree ? 'n/a' : 'n/a'}`);

console.log('\n=== QA-6.4 全仓库（含 test/ bin/）扫描 —— 比 src/ 更严 ===');
const hitsAll = scanSourceTree(path.join(__dirname, '..'), { excludeSelf: true, selfFile: 'src/core/net-guard.js' });
// 过滤掉 net-guard 自身与 test 里的守卫自检字符串
const realHits = hitsAll.filter(h => !h.file.includes('net-guard') && !h.file.includes('docs'));
console.log('  全仓命中明细:');
for (const h of hitsAll) console.log(`   - ${h.file}:${h.line} [${h.label}] ${h.text.slice(0,90)}`);

console.log('\n=== QA-6.5 ALLOWED_BUILTINS 是否真被使用 ===');
// ★ 修复后（BUG#4）：白名单真的参与判定 —— 未列入白名单的**外部**模块会报 warn
const guardSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'net-guard.js'), 'utf8');
const srcLines = guardSrc.split(/\r?\n/);
const codeLines = srcLines.filter(ln=>{
  const t=ln.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');});
const usesAllow = codeLines.some(ln=>/ALLOWED_BUILTINS\.(has|includes|add|delete)/.test(ln));
ok('ALLOWED_BUILTINS 被守卫逻辑实际引用（非死代码）', usesAllow,
   '守卫源码里找不到 ALLOWED_BUILTINS.has(...) 之类的实际调用 —— 白名单形同虚设');
// 行为验证：白名单外的外部模块必须报 warn
const unrev = scanContent('e.js', "require('totally-unknown-pkg');")
  .filter(h=>h.kind==='unreviewed-module');
ok('白名单外的外部模块被报 warn（白名单真的在起作用）', unrev.length===1,
   `实际 ${unrev.length} 条`);
ok('白名单内的模块不报 warn',
   scanContent('e.js', "require('fs');").filter(h=>h.kind==='unreviewed-module').length===0);
ok('项目内部相对路径 require 不报 warn（避免噪声）',
   scanContent('e.js', "require('../core/hash');").filter(h=>h.kind==='unreviewed-module').length===0);

console.log(`\nQA-6 结果: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
