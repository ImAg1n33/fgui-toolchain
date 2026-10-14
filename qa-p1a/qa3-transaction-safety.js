'use strict';
/**
 * qa-p1a/qa3-transaction-safety.js —— QA 第三轮：事务写盘安全性独立验证
 *
 * 这是会写用户工程的功能，安全性第一位。本脚本全部自建场景：
 *   ① lint 门禁失败 → 磁盘零痕迹（目标不存在 + 无 tmp + 无 bak）
 *   ② tmp 复检失败（含 verify 抛非 AppError）→ tmp 清理、目标不动
 *   ③ 模拟 rename 失败（monkeypatch fs.renameSync）→ 原文件 md5 不变
 *   ④ 回滚后原文件 md5 逐字节一致；备份完整性 md5 对账
 *   ⑤ .bak 时间戳：注入 now 决定文件名；不同 now → 不同名；不注入 → 真实时间
 *   ⑥ --now 注入端到端（atomicWrite 层）
 *   ⑦ writePackageXml 任何入参都抛错；writeComponentXml 对 package.xml 变体的拦截
 *   ⑧ B9：同 now 两次写盘结果对象一致
 *
 * 运行：node qa-p1a/qa3-transaction-safety.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  writeComponentXml, writePackageXml, rollback, assertLintClean,
} = require('../src/fgui/transaction');
const { atomicWrite } = require('../src/core/atomic');
const { CODES } = require('../src/core/errors');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, evidence) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${evidence ? ' :: ' + evidence : ''}`);
  }
}
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const tmpDir = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `qa3-tx-${n}-`));

// QA 自建合法/违规 XML（不用他的 fixtures）
const LEGAL = '<?xml version="1.0"?>\n<component size="100,100" exported="true">\n  <displayList>\n    <image id="b00001" name="qa_bg" xy="0,0" size="100,100"/>\n  </displayList>\n</component>\n';
const BAD = LEGAL.replace('color', 'color'); // 占位
const BAD8BIT = '<?xml version="1.0"?>\n<component size="100,100" exported="true">\n  <displayList>\n    <text id="b00001" name="qa_t" xy="0,0" size="50,20" color="#000000c8"/>\n  </displayList>\n</component>\n';
const NOW = '2026-05-13T10:20:30.123Z';

console.log('=== QA3-T1. lint 门禁失败 → 磁盘零痕迹 ===');
{
  const dir = tmpDir('lintgate');
  const target = path.join(dir, 'Q.xml');
  let err = null;
  try {
    writeComponentXml({ targetPath: target, content: BAD8BIT, now: NOW });
  } catch (e) {
    err = e;
  }
  ok('抛 AppError 且 code=LINT_BLOCKED', err && err.code === CODES.LINT_BLOCKED, err && err.code);
  ok('退出码为 3', err && err.exitCode === 3, err && String(err.exitCode));
  ok('目标文件不存在', !fs.existsSync(target));
  ok('无 tmp 残留', !fs.existsSync(`${target}.tmp`));
  ok('目录为空（零痕迹）', fs.readdirSync(dir).length === 0, JSON.stringify(fs.readdirSync(dir)));
}

console.log('\n=== QA3-T2. tmp 复检失败（verify 抛非 AppError）→ tmp 清理、目标不动 ===');
{
  const dir = tmpDir('verifythrow');
  const target = path.join(dir, 'Q.xml');
  fs.writeFileSync(target, LEGAL, 'utf8');
  const before = md5(target);
  let err = null;
  try {
    writeComponentXml({
      targetPath: target,
      content: LEGAL.replace('100,100"', '100,100"'),
      now: NOW,
      verify: () => { throw new TypeError('模拟复检函数内部崩溃'); },
    });
  } catch (e) {
    err = e;
  }
  ok('复检崩溃被包装为 AppError（不裸抛 TypeError）', err && err.code !== undefined, err && `${err.constructor.name}: ${err.message}`);
  ok('目标 md5 不变', md5(target) === before);
  ok('tmp 被清理', !fs.existsSync(`${target}.tmp`));
  ok('无多余 bak（复检失败在备份前）', fs.readdirSync(dir).filter((f) => f.includes('.bak')).length === 0,
    JSON.stringify(fs.readdirSync(dir)));
}

console.log('\n=== QA3-T3. 模拟 rename 失败（磁盘写一半）→ 原文件 md5 不变 ===');
{
  const dir = tmpDir('renamefail');
  const target = path.join(dir, 'Q.xml');
  const original = LEGAL;
  fs.writeFileSync(target, original, 'utf8');
  const before = md5(target);
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('模拟磁盘 rename 失败'); };
  let err = null;
  try {
    writeComponentXml({
      targetPath: target,
      content: LEGAL.replace('qa_bg', 'qa_bg_v2'),
      now: NOW,
    });
  } catch (e) {
    err = e;
  } finally {
    fs.renameSync = realRename;
  }
  ok('rename 失败抛 AppError', err && err.code !== undefined, err && `${err.constructor.name}`);
  ok('★ 原文件 md5 不变（事务核心承诺）', md5(target) === before, `${md5(target)} vs ${before}`);
  ok('tmp 被清理', !fs.existsSync(`${target}.tmp`));
  // rename 失败时 .bak 已生成（备份在 rename 前）—— 确认备份完整且原文件未被动
  const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  ok('备份存在且 md5 等于原文件（留作人工检查）', baks.length === 1 && md5(path.join(dir, baks[0])) === before,
    JSON.stringify(fs.readdirSync(dir)));
}

console.log('\n=== QA3-T4. 回滚后 md5 一致 + 备份完整性 ===');
{
  const dir = tmpDir('rollback');
  const target = path.join(dir, 'Q.xml');
  const original = LEGAL;
  fs.writeFileSync(target, original, 'utf8');
  const before = md5(target);
  let err = null;
  try {
    writeComponentXml({
      targetPath: target,
      content: LEGAL.replace('qa_bg', 'qa_bg_v3'),
      now: NOW,
      postVerify: () => '模拟写后校验失败',
    });
  } catch (e) {
    err = e;
  }
  ok('抛 ROLLED_BACK（退出码 5）', err && err.code === CODES.ROLLED_BACK && err.exitCode === 5, err && err.code);
  ok('details.restored === true', err && err.details.restored === true);
  ok('★ 回滚后 md5 与原始一致', md5(target) === before, `${md5(target)} vs ${before}`);
  const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  ok('备份完整（md5 等于原始）', baks.length === 1 && md5(path.join(dir, baks[0])) === before);

  // 无备份时 postVerify 失败：restored=false，且目标保留新内容（不假装回滚成功）
  const dir2 = tmpDir('rollback-nobak');
  const target2 = path.join(dir2, 'Q.xml');
  let err2 = null;
  try {
    writeComponentXml({
      targetPath: target2, content: LEGAL, now: NOW,
      postVerify: () => '模拟失败',
    });
  } catch (e) {
    err2 = e;
  }
  ok('无备份时 restored=false（诚实上报）', err2 && err2.details.restored === false);
  ok('无备份时目标保留新内容（不谎称已恢复）', fs.existsSync(target2) && fs.readFileSync(target2, 'utf8') === LEGAL);
}

console.log('\n=== QA3-T5. .bak 时间戳与 --now 注入 ===');
{
  const dir = tmpDir('bakts');
  const target = path.join(dir, 'Q.xml');
  fs.writeFileSync(target, LEGAL, 'utf8');
  const r = writeComponentXml({
    targetPath: target, content: LEGAL.replace('qa_bg', 'qa_bg_v4'), now: NOW,
  });
  ok('注入 now → .bak 名含 20260513T102030123Z', path.basename(r.backupPath) === 'Q.xml.bak.20260513T102030123Z',
    r.backupPath);

  // 不同 now → 不同备份名
  const dir2 = tmpDir('bakts2');
  const target2 = path.join(dir2, 'Q.xml');
  fs.writeFileSync(target2, LEGAL, 'utf8');
  const r2 = writeComponentXml({
    targetPath: target2, content: LEGAL.replace('qa_bg', 'qa_bg_v5'), now: '2020-01-02T03:04:05.678Z',
  });
  ok('不同 now → 不同 .bak 名', path.basename(r2.backupPath) !== path.basename(r.backupPath),
    `${path.basename(r.backupPath)} vs ${path.basename(r2.backupPath)}`);

  // 不注入 now → 真实时间戳（文件名含当前年份）
  const dir3 = tmpDir('bakts3');
  const target3 = path.join(dir3, 'Q.xml');
  fs.writeFileSync(target3, LEGAL, 'utf8');
  const r3 = writeComponentXml({ targetPath: target3, content: LEGAL.replace('qa_bg', 'qa_bg_v6') });
  const year = String(new Date().getFullYear());
  ok('不注入 now → .bak 名用真实时间（含当前年份）', path.basename(r3.backupPath).startsWith(`Q.xml.bak.${year}`),
    path.basename(r3.backupPath));

  // 原子写层直接验 now 注入
  const dir4 = tmpDir('atomicnow');
  const t4 = path.join(dir4, 'a.json');
  fs.writeFileSync(t4, 'old', 'utf8');
  const w = atomicWrite({ targetPath: t4, content: 'new', now: NOW, backup: true });
  ok('atomicWrite 层 now 注入生效', path.basename(w.backupPath) === 'a.json.bak.20260513T102030123Z', w.backupPath);

  // backup:false → 无 .bak
  const dir5 = tmpDir('nobak');
  const t5 = path.join(dir5, 'Q.xml');
  fs.writeFileSync(t5, LEGAL, 'utf8');
  const r5 = writeComponentXml({
    targetPath: t5, content: LEGAL.replace('qa_bg', 'qa_bg_v7'), now: NOW, backup: false,
  });
  ok('backup:false → 无 .bak', r5.backupPath === null && !fs.readdirSync(dir5).some((f) => f.includes('.bak')));
}

console.log('\n=== QA3-T6. writePackageXml 永远抛错 / writeComponentXml 拦截变体 ===');
{
  const dir = tmpDir('pkgxml');
  const cases = [
    ['package.xml', 'package.xml'],
    ['Package.XML（大小写变体）', 'Package.XML'],
    ['PACKAGE.xml（大小写变体）', 'PACKAGE.xml'],
    ['./package.xml（相对路径）', './package.xml'],
    ['a/b/package.xml（子目录）', path.join('a', 'b', 'package.xml')],
  ];
  for (const [label, name] of cases) {
    let err = null;
    try {
      writeComponentXml({ targetPath: path.join(dir, name), content: LEGAL, now: NOW });
    } catch (e) {
      err = e;
    }
    ok(`writeComponentXml 拒绝 ${label}`, err && err.code === CODES.USAGE, err && err.code);
    ok(`${label} 未落盘`, !fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(dir, name, 'package.xml')));
  }

  // writePackageXml：任何入参（含无参）都抛
  let e1 = null;
  try { writePackageXml(); } catch (e) { e1 = e; }
  ok('writePackageXml() 无参也抛', e1 && e1.code === CODES.USAGE, e1 && e1.code);
  let e2 = null;
  try { writePackageXml('/anywhere/package.xml'); } catch (e) { e2 = e; }
  ok('writePackageXml(路径) 抛且说明机理', e2 && e2.code === CODES.USAGE && e2.message.includes('内存态覆盖'));

  // ★ BUG-B 修复后断言反转（2026-10-13，Engineer）★
  // 原断言编码的是**当时的 bug 行为**（尾随空格不被拦截、文件落盘），
  // 用于在报告中记录已知边缘（QA 称 BUG-C，team-lead 路由为 BUG-B）。
  // Engineer 已修：basename 比对前 trim（src/fgui/transaction.js）。
  // 按项目纪律「改测试这件事本身需要被看见」（IMPLEMENTATION-REPORT §12），
  // 此处显式反转为断言**修复后行为**，并保留原 bug 形态说明。
  const spaced = path.join(dir, 'package.xml ');
  let e3 = null;
  try {
    writeComponentXml({ targetPath: spaced, content: LEGAL, now: NOW });
  } catch (e) {
    e3 = e;
  }
  const landed = fs.existsSync(path.join(dir, 'package.xml')) || fs.existsSync(spaced);
  ok('BUG-B 修复：package.xml 尾随空格被拦截（原 bug：不拦截且落盘）',
    e3 && e3.code === CODES.USAGE && !landed,
    `e3=${e3 && e3.code} landed=${landed}`);
  // 保险清理（修复后不应有任何落盘，保留以防回归时留痕）
  if (fs.existsSync(path.join(dir, 'package.xml'))) fs.unlinkSync(path.join(dir, 'package.xml'));
  if (fs.existsSync(spaced)) fs.unlinkSync(spaced);
}

console.log('\n=== QA3-T7. B9：同 now 两次写盘结果一致 ===');
{
  const dirA = tmpDir('b9a');
  const dirB = tmpDir('b9b');
  const tA = path.join(dirA, 'Q.xml');
  const tB = path.join(dirB, 'Q.xml');
  fs.writeFileSync(tA, LEGAL, 'utf8');
  fs.writeFileSync(tB, LEGAL, 'utf8');
  const rA = writeComponentXml({ targetPath: tA, content: LEGAL.replace('qa_bg', 'qa_bg_v8'), now: NOW });
  const rB = writeComponentXml({ targetPath: tB, content: LEGAL.replace('qa_bg', 'qa_bg_v8'), now: NOW });
  const norm = (r) => JSON.stringify({ ...r, targetPath: null, backupPath: path.basename(r.backupPath) });
  ok('同 now → 结果对象逐字段一致', norm(rA) === norm(rB), `${norm(rA)} vs ${norm(rB)}`);
  ok('同 now → 盘上内容一致', md5(tA) === md5(tB));
  ok('备份名一致', path.basename(rA.backupPath) === path.basename(rB.backupPath));
}

console.log('\n=== QA3-T8. 成功写盘基本契约 ===');
{
  const dir = tmpDir('ok');
  const target = path.join(dir, 'sub', 'Q.xml'); // 目录不存在 → 应自动建
  const r = writeComponentXml({ targetPath: target, content: LEGAL, now: NOW });
  ok('自动创建父目录并写盘', r.applied === true && fs.readFileSync(target, 'utf8') === LEGAL);
  ok('首次写无备份', r.backupPath === null);
  ok('reload_hint 覆盖重启/refresh/package.xml 约束',
    /重启|refresh/.test(r.reloadHint) && r.reloadHint.includes('package.xml'));
  ok('bytes 与内容一致', r.bytes === Buffer.byteLength(LEGAL, 'utf8'));

  // rollback API：手工恢复
  // 注意：此时盘上是 LEGAL（T8 第一次写入），先改成 corrupted，再触发一次覆盖写 ——
  // 该次的 .bak 装的是**覆盖前**的 'corrupted'，所以 rollback 后应回到 'corrupted'。
  fs.writeFileSync(target, 'corrupted', 'utf8');
  const r2 = writeComponentXml({ targetPath: target, content: LEGAL.replace('qa_bg', 'qa_bg_v9'), now: NOW });
  const res = rollback(r2.backupPath, target);
  ok('rollback API 恢复成功（恢复到覆盖前内容）', res.restored === true && fs.readFileSync(target, 'utf8') === 'corrupted',
    `实际: ${JSON.stringify(fs.readFileSync(target, 'utf8').slice(0, 30))}`);
  const res2 = rollback(path.join(dir, 'nonexistent.bak'), target);
  ok('rollback 不存在的备份 → restored:false 不抛', res2.restored === false);
}

console.log('\n=== QA3-T9. assertLintClean 契约 ===');
{
  const okRes = assertLintClean(LEGAL);
  ok('干净内容原样返回', okRes.ok === true);
  let err = null;
  try { assertLintClean(BAD8BIT); } catch (e) { err = e; }
  ok('脏内容抛 LINT_BLOCKED 且 details 带 errors', err && err.code === CODES.LINT_BLOCKED
    && Array.isArray(err.details.errors) && err.details.errors.length > 0);
}

console.log(`\n=== QA3-transaction 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
