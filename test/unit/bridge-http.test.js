'use strict';
/**
 * test/unit/bridge-http.test.js —— Bridge HTTP 传输层单测
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 绝不联网（两条路都堵死）★
 *   ①~⑩ 全部通过**注入 post** 完成：`createHttpTransport({ post })`，
 *      测试进程不建任何套接字、不发任何请求 —— 传输逻辑被完整真测；
 *   ⑪~⑭ 有一组 **loopback** 测试直测 `defaultPost` 本身（生产默认路径，
 *      否则它一行测试都没有）：服务器只听 127.0.0.1 的临时端口，
 *      数据不出本机 —— 不触碰 PRD K1「素材禁止外发」红线
 *      （net-guard 也本就和测试目录无关，只扫 src/）。
 *
 * ★ 契约依据（docs/BRIDGE-TRANSPORT.md，源码行号取证）★
 *   · POST `<bridgeUrl>`，body `{"cmd":<op>,"args":{...}}`
 *   · 响应 `{"ok":true,"data":...}` / `{"ok":false,"error":"..."}`
 *   · **HTTP 状态恒 200 —— 成败只看 body 里的 ok，绝不按状态码判成败**
 *     （插件把命令异常也包成 fail() 用 200 返回）
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  createHttpTransport, defaultPost, DEFAULT_TIMEOUT_MS, DEFAULT_PORT,
} = require('../../src/create/bridge-http');

/** 记录调用参数的假 post：绝不联网，只按剧本返回。 */
function fakePost(responder) {
  const calls = [];
  const post = async (url, body, timeoutMs) => {
    calls.push({ url, body, timeoutMs });
    return responder(url, body, timeoutMs);
  };
  post.calls = calls;
  return post;
}

/** 把假 post 的 body 记录解析出来（断言请求形状用）。 */
function sentBody(post, i = 0) {
  return JSON.parse(post.calls[i].body);
}

// ════════════════════════════════════════════════════════════════════════════
// ① 成功：body 里 ok:true → send() 得 {ok:true,data}（原样透传 data）
// ════════════════════════════════════════════════════════════════════════════

test('① 成功：{"ok":true,"data":{...}} → {ok:true,data}，且请求形状符合契约', async () => {
  const post = fakePost(() => ({ status: 200, text: '{"ok":true,"data":{"version":"9.9.9","port":7531}}' }));
  const t = createHttpTransport({ bridgeUrl: 'http://127.0.0.1:7531/', timeoutMs: 30000, post });

  const r = await t.send('ping');
  assert.deepEqual(r, { ok: true, data: { version: '9.9.9', port: 7531 } });

  // 请求形状：POST 到 bridgeUrl，body {"cmd","args"}
  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].url, 'http://127.0.0.1:7531/');
  assert.equal(post.calls[0].timeoutMs, 30000);
  assert.deepEqual(sentBody(post), { cmd: 'ping', args: {} });
});

test('①-b 带参数：args 原样进 body；data 缺省按 null', async () => {
  const post = fakePost(() => ({ status: 200, text: '{"ok":true}' }));
  const t = createHttpTransport({ post });
  const r = await t.send('create_component', { pkg: 'Mail', name: 'Demo', width: 400, height: 300 });
  assert.deepEqual(r, { ok: true, data: null });
  assert.deepEqual(sentBody(post), {
    cmd: 'create_component',
    args: { pkg: 'Mail', name: 'Demo', width: 400, height: 300 },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ② 插件明确失败：{"ok":false,"error":"x"} → 原样传 {ok:false,error:'x'}
//    （不是 transportError —— 这是我们和 Bridge 打通了，是插件说不行）
// ════════════════════════════════════════════════════════════════════════════

test('② ok:false → 原样传 error，且不标 transportError（Bridge 是通的）', async () => {
  const post = fakePost(() => ({ status: 200, text: '{"ok":false,"error":"组件已存在"}' }));
  const t = createHttpTransport({ post });
  const r = await t.send('create_component', { pkg: 'Mail', name: 'Demo' });
  assert.deepEqual(r, { ok: false, error: '组件已存在' });
  assert.notEqual(r.transportError, true,
    '★ 插件回的 ok:false 不能标成传输错误 —— 调用方靠这个区分「不存在」与「没打通」');
});

test('②-b ok:false 但插件没给 error → 兜底文案（不传 undefined）', async () => {
  const post = fakePost(() => ({ status: 200, text: '{"ok":false}' }));
  const t = createHttpTransport({ post });
  const r = await t.send('read_component', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, '插件未给出 error 字段');
});

// ════════════════════════════════════════════════════════════════════════════
// ③ ★ HTTP 500 但 body 是 {"ok":true,...} → 判成功 ★
//    这条专门守「不按 HTTP 状态码判成败」：插件恒用 200 承载 ok:false，
//    反向 proxy / 编辑器侧若回 5xx 但 body 仍合法，也不能误判成失败。
// ════════════════════════════════════════════════════════════════════════════

test('③ HTTP 500 + {"ok":true,...} → 判成功（绝不按状态码判成败）', async () => {
  const post = fakePost(() => ({ status: 500, text: '{"ok":true,"data":{"saved":true}}' }));
  const t = createHttpTransport({ post });
  const r = await t.send('save_all', {});
  assert.deepEqual(r, { ok: true, data: { saved: true } });
});

test('③-b HTTP 404 / 302 同样只看 body（状态码无关）', async () => {
  for (const status of [404, 302, 503]) {
    const post = fakePost(() => ({ status, text: '{"ok":true,"data":null}' }));
    const t = createHttpTransport({ post });
    assert.deepEqual(await t.send('ping'), { ok: true, data: null }, `HTTP ${status} 不该影响判定`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 超时 → {ok:false} 且 error 含超时原因
// ════════════════════════════════════════════════════════════════════════════

test('④ post 报超时 → {ok:false,transportError}，error 含超时原因', async () => {
  const post = fakePost(() => ({ status: 0, text: '', error: '请求超时（30000ms）' }));
  const t = createHttpTransport({ bridgeUrl: 'http://127.0.0.1:7531/', timeoutMs: 30000, post });
  const r = await t.send('ping');
  assert.equal(r.ok, false);
  assert.equal(r.transportError, true);
  assert.match(r.error, /超时/);
  assert.match(r.error, /30000/);
  assert.match(r.error, /ping/, 'error 里应点名是哪个命令超时');
});

test('④-b post 报连接错误（ECONNREFUSED 等）→ {ok:false,transportError}', async () => {
  const post = fakePost(() => ({ status: 0, text: '', error: 'connect ECONNREFUSED 127.0.0.1:7531' }));
  const t = createHttpTransport({ post });
  const r = await t.send('ping');
  assert.equal(r.ok, false);
  assert.equal(r.transportError, true);
  assert.match(r.error, /ECONNREFUSED/);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 非法 JSON / 空 body → {ok:false}（协议外内容，不当成功也不当插件失败）
// ════════════════════════════════════════════════════════════════════════════

test('⑤ 非法 JSON（HTML 错误页）→ {ok:false,transportError}，error 带原文尾部', async () => {
  const post = fakePost(() => ({ status: 200, text: '<html><body>502 Bad Gateway</body></html>' }));
  const t = createHttpTransport({ post });
  const r = await t.send('ping');
  assert.equal(r.ok, false);
  assert.equal(r.transportError, true);
  assert.match(r.error, /不是协议 JSON/);
  assert.match(r.error, /502 Bad Gateway/);
});

test('⑤-b 空 body → {ok:false}', async () => {
  const post = fakePost(() => ({ status: 200, text: '' }));
  const t = createHttpTransport({ post });
  const r = await t.send('ping');
  assert.equal(r.ok, false);
  assert.equal(r.transportError, true);
  assert.match(r.error, /空 body/);
});

test('⑤-c 合法 JSON 但缺 ok 字段 / 是数组 → {ok:false}', async () => {
  for (const text of ['{"foo":1}', '[1,2,3]', 'null', '"str"']) {
    const post = fakePost(() => ({ status: 200, text }));
    const t = createHttpTransport({ post });
    const r = await t.send('ping');
    assert.equal(r.ok, false, `body=${text} 不得判成功`);
    assert.equal(r.transportError, true);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ send 抛异常不得裸冲出（Runner 期望 send() 只返回 {ok,...}）
// ════════════════════════════════════════════════════════════════════════════

test('⑥ post 抛异常 → send 不 reject，转成 {ok:false,transportError}', async () => {
  const post = fakePost(() => { throw new Error('boom'); });
  const t = createHttpTransport({ post });
  const r = await t.send('ping');
  assert.deepEqual(r, {
    ok: false, transportError: true, error: 'Bridge 请求异常（ping）：boom',
  });
});

test('⑥-b post 返回非对象（null/字符串）→ {ok:false}', async () => {
  for (const bad of [null, undefined, 'ok', 42]) {
    const post = fakePost(() => bad);
    const t = createHttpTransport({ post });
    const r = await t.send('ping');
    assert.equal(r.ok, false, `post 返回 ${JSON.stringify(bad)} 不得判成功`);
    assert.equal(r.transportError, true);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 其它边界：op 非法 / URL 解析顺序 / 超时值兜底
// ════════════════════════════════════════════════════════════════════════════

test('⑦ op 为空或非字符串 → {ok:false}（不发请求）', async () => {
  const post = fakePost(() => ({ status: 200, text: '{"ok":true}' }));
  const t = createHttpTransport({ post });
  for (const op of [undefined, null, '', 42, {}]) {
    const r = await t.send(op);
    assert.equal(r.ok, false);
    assert.equal(r.transportError, true);
  }
  assert.equal(post.calls.length, 0, '★ op 非法时一次都不该发请求');
});

test('⑦-b bridgeUrl 优先序：显式参数 > env > 默认 localhost:7531', () => {
  const prev = process.env.FGUI_BRIDGE_URL;
  try {
    // 默认
    delete process.env.FGUI_BRIDGE_URL;
    assert.equal(createHttpTransport({}).bridgeUrl, `http://127.0.0.1:${DEFAULT_PORT}/`);
    assert.equal(DEFAULT_PORT, 7531);
    // env
    process.env.FGUI_BRIDGE_URL = 'http://127.0.0.1:7599/';
    assert.equal(createHttpTransport({}).bridgeUrl, 'http://127.0.0.1:7599/');
    // 显式参数压过 env
    assert.equal(createHttpTransport({ bridgeUrl: 'http://127.0.0.1:7531/' }).bridgeUrl,
      'http://127.0.0.1:7531/');
  } finally {
    if (prev === undefined) delete process.env.FGUI_BRIDGE_URL;
    else process.env.FGUI_BRIDGE_URL = prev;
  }
});

test('⑦-c timeoutMs 非法（0/负/非数）→ 兜底 DEFAULT_TIMEOUT_MS', () => {
  const post = fakePost(() => ({ status: 200, text: '{"ok":true}' }));
  for (const bad of [0, -1, NaN, 'abc', undefined]) {
    const t = createHttpTransport({ timeoutMs: bad, post });
    assert.equal(t.timeoutMs, DEFAULT_TIMEOUT_MS, `timeoutMs=${String(bad)} 应兜底`);
  }
  assert.equal(DEFAULT_TIMEOUT_MS, 30000, '默认 30s（依据朋友脚本 request(URL,name,args,30000)）');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑧~⑫ loopback：直测 defaultPost 本身（生产默认路径，注入 post 覆盖不到它）
//   只听 127.0.0.1 临时端口，数据不出本机。
// ════════════════════════════════════════════════════════════════════════════

/** 起一个只听 127.0.0.1 的假 Bridge；handler 可返回或（Promise）resolve 出 {status?, ok, data?, error?}。 */
function startFakeBridge(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    // 客户端提前断开（超时用例）时，不许把服务器炸掉
    res.on('error', () => {});
    req.on('error', () => {});
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let msg = null;
      try { msg = JSON.parse(body); } catch (e) { msg = { __parseError: String(e) }; }
      received.push({ method: req.method, url: req.url, msg });
      let r = null;
      try {
        r = await handler(msg, received.length);
      } catch (e) {
        r = { ok: false, error: `fake bridge handler threw: ${e && e.message}` };
      }
      if (!r) r = { ok: true, data: null };
      try {
        res.statusCode = Number.isFinite(r.status) ? r.status : 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: r.ok, data: r.data === undefined ? null : r.data, error: r.error }));
      } catch (e) { /* 客户端已断开，无可回写 */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        received,
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

test('⑧ defaultPost 真链路：POST / + {"cmd","args"} → 解出 {ok,data}', async () => {
  const bridge = await startFakeBridge((msg) => ({
    ok: true,
    data: {
      echo: msg, version: '1.0.0', editor: 'FairyGUI', projectOpen: true,
    },
  }));
  try {
    const t = createHttpTransport({ bridgeUrl: bridge.url }); // 不注入 post → 走 defaultPost
    const r = await t.send('ping');
    assert.deepEqual(r, {
      ok: true,
      data: {
        echo: { cmd: 'ping', args: {} }, version: '1.0.0', editor: 'FairyGUI', projectOpen: true,
      },
    });
    // 服务器侧看到的事实：方法 POST、路径 /、body 形状正确
    assert.equal(bridge.received.length, 1);
    assert.equal(bridge.received[0].method, 'POST');
    assert.equal(bridge.received[0].url, '/');
    assert.deepEqual(bridge.received[0].msg, { cmd: 'ping', args: {} });
  } finally {
    await bridge.close();
  }
});

test('⑨ defaultPost 真链路：HTTP 500 + {"ok":true} → 仍判成功（状态码无关）', async () => {
  const bridge = await startFakeBridge(() => ({ status: 500, ok: true, data: { saved: true } }));
  try {
    const t = createHttpTransport({ bridgeUrl: bridge.url });
    assert.deepEqual(await t.send('save_all'), { ok: true, data: { saved: true } });
  } finally {
    await bridge.close();
  }
});

test('⑩ defaultPost 真链路：整次请求超时 → {ok:false}，error 含「请求超时」', async () => {
  // 服务器故意拖 400ms 才回；客户端 60ms 整次超时
  const bridge = await startFakeBridge(() => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, data: null }), 400);
  }));
  try {
    const t = createHttpTransport({ bridgeUrl: bridge.url, timeoutMs: 60 });
    const r = await t.send('ping');
    assert.equal(r.ok, false);
    assert.equal(r.transportError, true);
    assert.match(r.error, /请求超时（60ms）/);
  } finally {
    await bridge.close();
  }
});

test('⑪ defaultPost：连接被拒（没人在听）→ resolve {status:0,error}，绝不 reject', async () => {
  // 先占一个端口再放开，得到一个「一定没人听」的 loopback 端口
  const bridge = await startFakeBridge(() => ({ ok: true }));
  const port = new URL(bridge.url).port;
  await bridge.close();
  const r = await defaultPost(`http://127.0.0.1:${port}/`, '{}', 5000);
  assert.equal(r.status, 0);
  assert.ok(r.error && r.error.length > 0, '必须带上错误原因');
});

test('⑫ defaultPost：非法 URL → resolve {status:0,error}，绝不 reject', async () => {
  const r = await defaultPost('not-a-url', '{}', 5000);
  assert.equal(r.status, 0);
  assert.match(r.error, /不是合法 URL/);
});
