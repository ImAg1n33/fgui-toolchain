'use strict';
/**
 * src/create/bridge-http.js —— 真实 Bridge 的 HTTP 传输适配器
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 协议依据（全部来自**源码取证**，无推测；详见 docs/BRIDGE-TRANSPORT.md）★
 *   · 传输：**HTTP**（非 WebSocket）。插件用 `HttpListener`
 *     —— `docs/plugin_main.js.baseline:1136-1141`（`Prefixes.Add("http://127.0.0.1:"+port+"/")`）
 *   · 端口：默认 7531；`plugins/agent-bridge/port.txt` 覆盖；冲突自动递增
 *     —— `plugin_main.js.baseline:47,51,1133`
 *   · 方法/路径：**POST** 到 `/`（OPTIONS 只做 CORS 预检）
 *     —— `plugin_main.js.baseline:1213-1227`
 *   · 请求体：`{"cmd":"<命令>","args":{...}}`（插件错误信息里原文明写）
 *     —— `plugin_main.js.baseline:1219-1227`
 *   · 响应：`{"ok":true,"data":...}` / `{"ok":false,"error":"..."}`
 *     —— `plugin_main.js.baseline:56-57`（`ok()` / `fail()` 的定义）
 *   · 无鉴权、无自定义头要求 —— `plugin_main.js.baseline:1211-1227`
 *   · 超时默认值 30000ms —— 朋友脚本 `request(URL, name, args, 30000)`
 *
 * ★ HTTP 恒 200，成败只看 body 里的 `ok` ★
 *   插件把命令异常也包成 `fail(msg)` 后用 200 返回（只有 body 读不了 / 缺 `cmd`
 *   才是 400）。因此**绝不按 HTTP 状态码判成败** —— 否则会把「命令失败」误判成成功，
 *   也会把「HTTP 500 但 body 说 ok」误判成失败。
 *
 * ★ 边界（instances.mjs 缺失 → 不猜）★
 *   官方客户端 `cli/instances.mjs` 不在我们手里（仓库与朋友压缩包均无），
 *   因此下列语义**未确认**：超时实现（HTTP 超时 / 队列超时）、是否内建重试、
 *   `route()` 的多实例路由优先级、`stripSelector()` 剥哪些字段。
 *   → 本适配器**只支持显式 URL**（`--bridge-url` 或 env `FGUI_BRIDGE_URL`），
 *     **不做多实例路由复刻**，也**不加内建重试**（失败即停，与朋友 SKILL.md
 *     「同一组件上的编辑命令串行、上一条成功再发下一条」一致）。
 *
 * ★ P0-2：只连本机回环 ★
 *   请求体带组件名/文本内容/工程路径 —— `--bridge-url` 指向外部服务器就等于
 *   把工程细节送出本机（PRD K1 合规事故）。故 `assertLoopbackUrl()` 在
 *   **发请求之前**强校验：协议必须 `http:`，主机只认 127.0.0.1 / localhost /
 *   [::1]（显式白名单，不做子网猜测），不合法直接抛错、绝不静默降级。
 * ════════════════════════════════════════════════════════════════════════════
 */

const http = require('http');
const https = require('https');
const { AppError, CODES } = require('../core/errors');

/** 默认超时（依据朋友脚本 `request(URL, name, args, 30000)`）。 */
const DEFAULT_TIMEOUT_MS = 30000;

/** 默认端口（依据 `plugin_main.js.baseline:51`）。 */
const DEFAULT_PORT = 7531;

/**
 * ★ P0-2：Bridge 只允许**本机回环**地址 ★
 *
 * agent-bridge 是插在本机 FairyGUI 编辑器里的服务（HttpListener 只听
 * `http://127.0.0.1:<port>/`，见 docs/BRIDGE-TRANSPORT.md §1）。请求体里
 * 带组件名、文本内容、工程路径 —— 一旦 `--bridge-url` 指向外部服务器，
 * 就是把工程细节送出本机（PRD K1 合规事故）。
 *
 * 故在**发请求之前**做强校验：显式白名单，不做子网猜测。
 * `http://127.0.0.2:` 这类"也是回环"的地址同样拒绝 —— 白名单的含义就是
 * 「只认列明的形态」，默认 URL 本来就是 127.0.0.1，没有放行更多地址的需要。
 *
 * @type {Set<string>}
 */
const LOOPBACK_HOSTS = Object.freeze(new Set([
  '127.0.0.1',
  'localhost', // URL 会把大小写归一成小写
  '::1', // 规范形态（URL.hostname 对 IPv6 带括号，见下）
  '[::1]',
]));

/**
 * 校验 bridgeUrl 是「本机回环 + http」，不合法则**抛错**（绝不静默降级）。
 *
 * @param {string} url 已解析出优先序的最终 URL
 * @returns {URL} 解析后的 URL 对象（调用方可复用）
 * @throws {AppError} 协议非 http / 主机非回环 / 不是合法 URL
 */
function assertLoopbackUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw new AppError(CODES.USAGE, `bridgeUrl 不是合法 URL: ${String(url)}`);
  }
  if (u.protocol !== 'http:') {
    throw new AppError(CODES.USAGE,
      `bridgeUrl 协议必须是 http:（Bridge 是 HTTP 服务，不支持 ${u.protocol}）：${url}`);
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
    throw new AppError(CODES.USAGE,
      `Bridge 只允许本机回环地址（127.0.0.1 / localhost / [::1]），拒绝连接到 `
      + `${u.hostname}：${url} —— Bridge 是本机编辑器里的服务；把组件名/文本内容/工程路径`
      + '发去非本机地址属于 PRD K1 合规事故');
  }
  return u;
}

/**
 * 默认 POST 实现（Node 原生 http/https，零依赖）。
 *
 * ★ 永不 reject ★ —— 任何异常都转成 `{status:0, error}` 返回，
 *   避免裸异常冲出 Runner（Runner 期望 `send()` 只返回 `{ok,...}`）。
 *
 * ★ 超时语义（问答记录：`timeoutMs` 是「整次请求超时」）★
 *   用**自有时钟定时器**实现：从发请求那一刻起，`timeoutMs` 内必须完成
 *   「连接 → 发送 → 收完响应」全过程，超时即 `req.destroy()` 并返回
 *   `{status:0, error:'请求超时（Nms）'}`。请求一 settle（end/error/超时）
 *   立即 `clearTimeout`。
 *
 *   为什么不用 `req.setTimeout()`：那是**套接字空闲超时**——
 *     · 连接建立阶段不计时（连一个不可路由的地址会永久挂起）；
 *     · 每收到一个字节就重新计时（不是整次请求期限）；
 *     · 它的 `once('timeout')` 监听器会留在套接字上 —— Node ≥19 默认
 *       keep-alive 复用套接字，已完成请求的陈旧监听器可能在**后续请求**
 *       正用时触发，把人家在用的连接 destroy 掉（莫名的 ECONNRESET）。
 *   自有时钟定时器三者皆无，且不需要 `Date.now`（src/ 禁时间戳 API，
 *   见 test/unit/net-guard.test.js 的 K1 确定性守卫）。
 *
 * @param {string} url 绝对 URL（如 `http://127.0.0.1:7531/`）
 * @param {string} body 请求体（JSON 字符串）
 * @param {number} timeoutMs 整次请求超时（毫秒，必须 > 0）
 * @returns {Promise<{status:number, text:string, error?:string}>}
 */
function defaultPost(url, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      // ★ P0-2 第二道闸：直调 defaultPost 也先过回环校验（本函数永不 reject，
      //   故校验失败以 {status:0,error} 表达，同样不进网）★
      u = assertLoopbackUrl(url);
    } catch (e) {
      resolve({ status: 0, text: '', error: String((e && e.message) || e) });
      return;
    }
    const mod = (u.protocol === 'https:') ? https : http;
    const payload = Buffer.from(String(body), 'utf8');

    // settle 一次生效：先清定时器再 resolve（Promise 本身也只会取首次结果，
    // 但清定时器是必须的 —— 否则超时回调会在请求完成后仍挂在进程里）。
    let settled = false;
    let timer = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => settle({ status: res.statusCode || 0, text }));
      // 响应中途断流（编辑器崩溃等）：不等 error，直接按失败收口
      res.on('aborted', () => settle({ status: 0, text: '', error: '响应中断（连接被对端关闭）' }));
      res.on('error', (e) => settle({ status: 0, text: '', error: String((e && e.message) || e) }));
    });

    // ★ 整次请求超时：覆盖「连接 + 发送 + 接收」全程（见上方语义说明）★
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => {
      req.destroy();
      settle({ status: 0, text: '', error: `请求超时（${ms}ms）` });
    }, ms);

    req.on('error', (e) => {
      settle({ status: 0, text: '', error: String((e && e.message) || e) });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 创建 HTTP 传输对象（符合 `exec-runner.js:9` 的契约 `{ send(op,args) }`）。
 *
 * @param {Object} a
 * @param {string} [a.bridgeUrl] 显式 Bridge URL（缺则退 env `FGUI_BRIDGE_URL`，再退 `http://127.0.0.1:7531/`）
 * @param {number} [a.timeoutMs=30000]
 * @param {Function} [a.post] 注入的 POST 实现（测试用，**不联网**）；默认 `defaultPost`
 * @returns {{send:Function, bridgeUrl:string, timeoutMs:number}}
 */
function createHttpTransport(a = {}) {
  const timeoutMs = Number.isFinite(a.timeoutMs) && a.timeoutMs > 0
    ? Math.floor(a.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const bridgeUrl = (typeof a.bridgeUrl === 'string' && a.bridgeUrl.trim())
    ? a.bridgeUrl.trim()
    : (process.env.FGUI_BRIDGE_URL || `http://127.0.0.1:${DEFAULT_PORT}/`);
  // ★ P0-2 第一道闸：**构造时**校验回环 —— 拒绝发生在任何请求之前，
  //   连 post 注入点都到不了（测试据此断言「post 零调用」）★
  assertLoopbackUrl(bridgeUrl);
  const post = typeof a.post === 'function' ? a.post : defaultPost;

  /**
   * 发一条 Bridge 命令。
   *
   * @param {string} op 命令名（如 `ping` / `create_component` / `insert_object`）
   * @param {Object} [args] 命令参数
   * @returns {Promise<{ok:boolean, data?:*, error?:string}>}
   */
  async function send(op, args) {
    if (!op || typeof op !== 'string') {
      return { ok: false, transportError: true, error: 'send(op, args) 的 op 必须是非空字符串' };
    }
    const body = JSON.stringify({ cmd: op, args: (args && typeof args === 'object') ? args : {} });

    let res;
    try {
      res = await post(bridgeUrl, body, timeoutMs);
    } catch (e) {
      // post 若违反「不抛异常」的约定，这里兜住，绝不让裸异常冲出 Runner
      return {
        ok: false,
        transportError: true,
        error: `Bridge 请求异常（${op}）：${String((e && e.message) || e)}`,
      };
    }
    if (!res || typeof res !== 'object') {
      return {
        ok: false,
        transportError: true,
        error: `Bridge 响应格式错误（${op}）：post() 未返回 {status,text}`,
      };
    }
    // 超时 / 连接错误：post 约定用 error 字段表达
    if (res.error) {
      return {
        ok: false,
        transportError: true,
        error: `Bridge 请求失败（${op}）：${res.error}`,
      };
    }

    // ★ 只解析 body，不看 HTTP 状态码（插件恒用 200 承载 ok:false）★
    let json = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch (e) {
      json = null;
    }
    if (!json || typeof json !== 'object' || typeof json.ok !== 'boolean') {
      const tail = String(res.text || '').slice(0, 200);
      return {
        ok: false,
        transportError: true,
        error: `Bridge 响应不是协议 JSON（${op}，HTTP ${res.status}）：${tail || '(空 body)'}`,
      };
    }
    if (json.ok) return { ok: true, data: json.data === undefined ? null : json.data };
    return { ok: false, error: (json.error !== undefined && json.error !== null)
      ? String(json.error) : '插件未给出 error 字段' };
  }

  return { send, bridgeUrl, timeoutMs };
}

module.exports = {
  createHttpTransport,
  defaultPost,
  assertLoopbackUrl,
  LOOPBACK_HOSTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PORT,
};
