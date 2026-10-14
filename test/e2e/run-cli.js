'use strict';
/**
 * test/e2e/run-cli.js —— 以**子进程**方式调用 CLI 并采集产物
 *
 * ★ 为什么用子进程而不是直接 require ★
 *   在测试进程内猴补 `process.stdout.write` 会连带吞掉 node:test 自己的报告输出 ——
 *   实测导致 reporter 只统计到 1 个用例、且 JSON.parse 拿到测试报告文本。
 *   子进程调用同时还额外验证了三件事：
 *     ① bin/fgui-rb.js 这个入口真的能跑（shebang / 路径 / CJS 加载都没问题）
 *     ② 退出码真的按 §8.1 返回（进程退出码而非返回值）
 *     ③ stdout 真的是干净的 JSON（管道里没有日志混进来）
 */

const path = require('path');
const { spawnSync } = require('child_process');

/** CLI 入口。 */
const CLI = path.resolve(__dirname, '../../bin/fgui-rb.js');

/**
 * 跑一次 CLI。
 * @param {string[]} args 命令与参数
 * @param {Object} [opts]
 * @param {string} [opts.cwd=项目根]
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', CLI, ...args,
  ], {
    cwd: opts.cwd || path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

/**
 * 跑一次 CLI 并解析 stdout 的 JSON。
 * @param {string[]} args
 * @param {Object} [opts]
 * @returns {{code:number, json:Object, stderr:string}}
 */
function runCliJson(args, opts) {
  const r = runCli(args, opts);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(
      `CLI stdout 不是合法 JSON（${args.join(' ')}）：${err.message}\n`
      + `--- stdout 前 500 字 ---\n${r.stdout.slice(0, 500)}\n`
      + `--- stderr 前 500 字 ---\n${r.stderr.slice(0, 500)}`,
    );
  }
  return { code: r.code, json, stderr: r.stderr };
}

module.exports = { runCli, runCliJson, CLI };
