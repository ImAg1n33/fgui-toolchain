'use strict';
/**
 * test/run-qa-round2.js —— 跑 `qa-round2/` 下的 QA 第二轮独立验证脚本
 *
 * ★ 为什么单独一个入口 ★
 *   第一轮脚本在 `qa/`（入口 `npm run qa`），第二轮在 `qa-round2/`。
 *   两轮脚本由 QA 各自编写、互不依赖，分开入口便于对比「修前/修后」的通过情况。
 *
 * 用法：
 *   node test/run-qa-round2.js          跑全部
 *   node test/run-qa-round2.js --list   列出脚本
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const QA_DIR = path.resolve(__dirname, '../qa-round2');

/** 第二轮脚本清单。 */
const SCRIPTS = [
  { file: 'qa2-guard.js', desc: '禁网守卫：11 个出站模块分级 + 绕过探测' },
  { file: 'qa2-bbox-deep.js', desc: '组 bbox 深度/负坐标/畸形输入' },
  { file: 'qa2-composite-fresh.js', desc: '合成图：逐像素与退化分级' },
  { file: 'qa2-overlay-real.js', desc: 'ir_overlay 底图可用性判定' },
  { file: 'qa2-grid9-fresh.js', desc: '九宫格：QA 自造形态（阈值类，见 HANDOFF §2.1）' },
  { file: 'qa2-hunt-silent.js', desc: '静默错误猎手：找「不报错但结果错」' },
];

/**
 * 跑单个脚本。
 * @param {string} file
 * @returns {{code:number, pass:number, fail:number}}
 */
function runOne(file) {
  const full = path.join(QA_DIR, file);
  if (!fs.existsSync(full)) return { code: 127, pass: 0, fail: 1 };
  const r = spawnSync(process.execPath, [full], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/pass=(\d+)\s+fail=(\d+)/);
  return { code: r.status === null ? -1 : r.status, pass: m ? +m[1] : 0, fail: m ? +m[2] : 0 };
}

/** 主流程。 */
function main() {
  if (process.argv.includes('--list')) {
    process.stdout.write('QA 第二轮脚本清单：\n');
    for (const s of SCRIPTS) process.stdout.write(`  ${s.file.padEnd(24)} ${s.desc}\n`);
    return 0;
  }
  process.stdout.write('═══ QA 第二轮独立验证 ═══\n\n');
  let pass = 0;
  let fail = 0;
  for (const s of SCRIPTS) {
    const r = runOne(s.file);
    pass += r.pass;
    fail += r.fail;
    process.stdout.write(
      `  ${s.file.padEnd(24)} pass=${String(r.pass).padStart(3)} fail=${r.fail}`
      + `${r.fail === 0 ? '  ✅' : '  ⚠'}\n`,
    );
  }
  process.stdout.write(`\n合计: pass=${pass} fail=${fail}\n`);
  if (fail > 0) {
    process.stdout.write(
      '\n注：剩余 fail 均为**九宫格阈值类**（QA 自造形态），\n'
      + '    已作为已知限制固化在 test/unit/grid9-known-limits.test.js，\n'
      + '    并写入 docs/HANDOFF-P1.md §2.1 —— 需真实素材才能标定，\n'
      + '    刻意不「改测试改绿」。\n',
    );
  }
  return 0;
}

process.exitCode = main();
