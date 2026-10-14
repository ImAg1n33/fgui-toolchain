'use strict';
/**
 * test/run-qa-suite.js —— 跑 `qa/` 下的 QA 独立验证脚本
 *
 * ★ 为什么要这个 ★
 *   QA 工程师（严过关）在 `docs/QA-REPORT.md` 里独立写了 9 个验证脚本，
 *   全部**不复用**我的测试与 fixture。这恰恰是我自己测试方法的最大盲区：
 *   「既造数据又写验证」会退化成自证循环（BUG #1 就是这么漏过去的）。
 *   把 QA 的脚本接成可重复执行的套件，等于把**第二双眼睛**固化进 CI。
 *
 * 用法：
 *   node test/run-qa-suite.js          跑全部
 *   node test/run-qa-suite.js --list   列出脚本
 *
 * 退出码：全部通过 0；任一失败 1。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const QA_DIR = path.resolve(__dirname, '../qa');

/**
 * QA 脚本清单与说明。
 * `expectFail` 表示该脚本当前已知有未修完的项（记录在案，不掩盖）。
 */
const SCRIPTS = [
  { file: 'qa-net-guard.js', desc: '禁网守卫：15 恶意样本 + 5 绕过盲区' },
  { file: 'qa-k5.js', desc: 'K5 命名陷阱：归一化层 43 条断言' },
  { file: 'qa-k5-e2e.js', desc: 'K5 端到端：索引层 + 检索层' },
  { file: 'qa-group-bbox.js', desc: '组 bbox 推导（含 BUG#1 复现用例）' },
  { file: 'qa-bbox-bugproof.js', desc: 'BUG#1 证明：独立递归算法对账' },
  { file: 'qa-canvas-shim.js', desc: 'canvas-shim：逐像素往返 + 合成图' },
  { file: 'qa-shim-composite.js', desc: 'BUG#2 证明：合成图像素正确性' },
  { file: 'qa-grid9.js', desc: '九宫格：QA 自造 32 个形态' },
  { file: 'qa-determinism.js', desc: '确定性：6 类污染源' },
  { file: 'qa-deviations.js', desc: '7 处偏差抽查' },
];

/**
 * 跑单个 QA 脚本，解析其结果行。
 * @param {string} file
 * @returns {{code:number, pass:number, fail:number, tail:string}}
 */
function runOne(file) {
  const full = path.join(QA_DIR, file);
  if (!fs.existsSync(full)) return { code: 127, pass: 0, fail: 1, tail: '脚本不存在' };
  const r = spawnSync(process.execPath, [full], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.split(/\r?\n/).filter((l) => /结果|FAIL/.test(l)).slice(-6).join('\n');
  return {
    code: r.status === null ? -1 : r.status,
    pass: (out.match(/\[PASS\]/g) || []).length,
    fail: (out.match(/\[FAIL\]/g) || []).length,
    tail,
  };
}

/**
 * 主流程。
 */
function main() {
  if (process.argv.includes('--list')) {
    process.stdout.write('QA 验证脚本清单：\n');
    for (const s of SCRIPTS) process.stdout.write(`  ${s.file.padEnd(24)} ${s.desc}\n`);
    return 0;
  }

  process.stdout.write('═══ QA 独立验证套件 ═══\n');
  process.stdout.write('（这些脚本由 QA 独立编写，不复用工程师的测试/fixture）\n\n');

  let totalFail = 0;
  const rows = [];
  for (const s of SCRIPTS) {
    const r = runOne(s.file);
    totalFail += r.fail;
    rows.push({
      脚本: s.file,
      通过: r.pass,
      失败: r.fail,
      结论: r.fail === 0 ? '✅' : `⚠ ${r.fail} 项`,
    });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 0).replace(/},/g, '},\n')}\n\n`);
  process.stdout.write(`合计失败项: ${totalFail}\n`);
  if (totalFail > 0) {
    process.stdout.write(
      '\n注：失败项分两类 ——\n'
      + '  (a) 真 bug：必须修\n'
      + '  (b) 已知未修完：受限于「缺真实素材」，已记录在 IMPLEMENTATION-REPORT 的遗留清单\n'
      + '逐条明细见 docs/QA-REPORT.md 与 docs/IMPLEMENTATION-REPORT.md。\n',
    );
  }
  return totalFail === 0 ? 0 : 1;
}

process.exitCode = main();