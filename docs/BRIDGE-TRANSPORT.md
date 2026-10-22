# Bridge 传输层：真实调用形状研究（只读取证，无推测）

> 研究时间：2026-10-22　研究者：engineer-2
> **纪律**：本文件每一条结论都给出 `文件:行号 + 原文`。不确定的部分标注「不确定 + 缺什么」，**不为了补全而推测**。
> 状态：**未入库**（`docs/*` 被 `.gitignore:50` 覆盖；等 team-lead 看过再定）。

---

## 0. 结论（一句话）

**请求形状可确认 —— `POST http://127.0.0.1:<port>/`，body `{"cmd":"<命令>","args":{...}}`，响应 `{"ok":true,"data":...}` / `{"ok":false,"error":"..."}`，无鉴权、无自定义头。**
但**客户端封装 `cli/instances.mjs` 不在我们手里**（仓库与朋友压缩包里都没有），所以「超时/重试/错误转换/多实例路由算法」这四项**不可从源码确认** —— 不影响我们写一个最小可用的 HTTP 适配器，但影响我们复刻官方 CLI 的全部行为。

| 项目 | 是否可确认 | 依据 |
|---|---|---|
| 传输方式（HTTP，非 WebSocket） | ✅ 可确认 | `docs/plugin_main.js.baseline:1136-1141` |
| 默认端口 7531 / `port.txt` 覆盖 / 冲突递增 | ✅ | `:47,:51,:1133` |
| URL 来源（env `FGUI_BRIDGE_URL`） | ✅ | `docs/mcp_server.mjs.baseline:14` |
| 方法 = POST，路径 = `/` | ✅ | `plugin_main.js.baseline:1213-1227`；`docs/UPSTREAM-README.md:96` |
| body 形状 `{"cmd","args"}` | ✅ | `plugin_main.js.baseline:1219-1227`（错误信息里直接写明） |
| 响应包装 `{ok,data}` / `{ok,error}` | ✅ | `plugin_main.js.baseline:56-57` |
| 无鉴权 / 无自定义头 | ✅（证据：插件端不校验任何头） | `plugin_main.js.baseline:1211-1227` |
| `ping` 的返回字段 | ✅ | `plugin_main.js.baseline:155-163` |
| registry 条目字段（`discover` 的数据源） | ✅ | `plugin_main.js.baseline:1086-1092` |
| `request()` 内部实现（超时/重试/错误转换） | ❌ **不可确认**（缺 `instances.mjs`） | 见 §4 |
| `route()` 的多实例选择算法 | ❌ 不可确认 | 见 §4 |
| `discover_projects` 的**确切**返回字段名 | ❌ 不可确认（但可自行实现，见 §4） | — |

---

## 1. 传输方式：HTTP（不是 WebSocket）

`docs/plugin_main.js.baseline:8-12`
```
// Threading model: strictly single-threaded. HttpListener.BeginGetContext
// Endpoint: http://localhost:<port>/   (default 7531, override via port.txt
```

`:1133-1148`
```
var maxTries = 21; // e.g. 7531..7551
var listener = new CS.System.Net.HttpListener();
listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
listener.Start();
Bridge.listener = listener;
Bridge.pendingAccept = listener.BeginGetContext(null, null);
plog("listening on http://127.0.0.1:" + port + "/ v" + VERSION
```

**端口来源**（`:44-51`）
```
var s = CS.System.IO.File.ReadAllText(PluginDir + "/port.txt").trim();
...
return 7531;
```
- 默认 **7531**；`plugins/agent-bridge/port.txt` 可覆盖（内容与 `UPSTREAM-README.md:58` 一致）；
- 冲突自动递增，最多试 21 个（7531..7551）；
- `UPSTREAM-README.md:129` 与 `:133`：`FGUI_BRIDGE_URL=http://localhost:7532/` 指定实例；
- **客户端侧 URL 来源**：`docs/mcp_server.mjs.baseline:14`
  ```
  const BASE = process.env.FGUI_BRIDGE_URL || "http://localhost:7531/";
  ```
- 朋友的真实脚本用的也是 127.0.0.1：`out/fb/ink-fgui - test2/.objs/_assemble_rest.mjs:3`
  ```
  const URL = 'http://127.0.0.1:7531/';
  ```
- 另可按**请求**选择实例（不依赖 env）：`mcp_server.mjs.baseline:310-314` 给每个工具（除 `discover_projects`）追加
  `project`（绝对路径/.fairy，推荐）/ `port` / `bridge_url` 三个选择器。

---

## 2. 调用形状

### 2.1 方法 / 路径 / body

`docs/plugin_main.js.baseline:1210-1228`（`handleRequest`）
```js
function handleRequest(ctx) {
    var req = ctx.Request;
    // simple CORS preflight support for browser consoles
    if (req.HttpMethod === "OPTIONS") {
        ctx.Response.Headers.Set("Access-Control-Allow-Origin", "*");
        ctx.Response.Headers.Set("Access-Control-Allow-Methods", "POST, OPTIONS");
        ctx.Response.Headers.Set("Access-Control-Allow-Headers", "Content-Type");
        writeResponse(ctx, 200, ok({ cors: true }));
        return;
    }
    var body = "";
    try { body = readBody(ctx); } catch (e) { writeResponse(ctx, 400, fail("bad body: " + e)); return; }
    var msg = null;
    try { msg = body ? JSON.parse(body) : {}; } catch (e) { }
    if (!msg || !msg.cmd) {
        writeResponse(ctx, 400, fail("body must be JSON like {\"cmd\":..., \"args\":{...}}"));
        return;
    }
    Bridge.queue.push({ ctx: ctx, cmd: String(msg.cmd), args: msg.args || {} });
}
```
→ **可确认**：
- 方法 **POST**（OPTIONS 只做 CORS 预检，且明确 `Allow-Methods: POST, OPTIONS`）；
- 路径 **`/`**（`Prefixes.Add("http://127.0.0.1:" + port + "/")`，:1141）；
- body 必须是 `{"cmd": <字符串>, "args": {...}}`，`args` 缺省为 `{}`（:1228）；
- body 读取用 `req.InputStream.CopyTo(ms)`，然后 `JSON.parse`（:1160-1170, :1220）→ **插件不校验 Content-Type**，但客户端应显式发送 `application/json`（与 curl 示例一致即可）。

`docs/UPSTREAM-README.md:96` 是同一结论的**独立第二来源**：
```
请求：`POST http://localhost:7531/`，body `{"cmd":"<命令>","args":{...}}`；响应 `{"ok":true,"data":...}` 或 `{"ok":false,"error":"..."}`。
```
curl 示例（`:65-67`）：
```bash
curl -X POST http://localhost:7531/ -d "{\"cmd\":\"list_packages\"}"
curl -X POST http://localhost:7531/ -d "{\"cmd\":\"create_component\",\"args\":{\"pkg\":\"common\",\"name\":\"Demo\",\"width\":400,\"height\":300}}"
```

### 2.2 鉴权 / 头信息

**可确认：无鉴权、无自定义头要求。** 证据：
- 插件 `handleRequest` 只读 `HttpMethod` 与 body，**不读任何请求头**（:1213-1227）；
- 响应侧只加 CORS 头：`Access-Control-Allow-Origin: *`、ContentType `application/json; charset=utf-8`（`:1173-1186`）；
- `UPSTREAM-README.md:43` 的验证方式就是裸 `curl -d`，无 token。

### 2.3 响应结构

`docs/plugin_main.js.baseline:56-57`（**定义处，最强证据**）
```js
function ok(data) { return { ok: true, data: data === undefined ? null : data }; }
function fail(msg) { return { ok: false, error: String(msg) }; }
```
→ 响应恒为 `{ok:true, data:<结果>}` 或 `{ok:false, error:"<消息>"}`。
- 命令**抛异常**时也会走 `fail(...)`（HTTP 200 + `ok:false`），不是 HTTP 4xx/5xx；
- 只有两种情形是 HTTP 非 200：body 读不了（400，:1218）与 body 缺 `cmd`（400，:1225）。

**客户端侧的判据也一致**：`mcp_server.mjs.baseline:384-392`
```js
out = { ok: false, error: String(e) + " (is the FairyGUI editor running with the plugin?)" };
...
isError: !out.ok,
```
以及朋友脚本 `out/fb/.../_assemble_rest.mjs:6-9`
```js
const r = await request(URL, name, args, 30000);
if (!r.ok) throw new Error(`${name}: ${r.error || JSON.stringify(r)}`);
```
→ `request(url, cmd, args, timeoutMs)` 的**签名可确认**（第 4 参是毫秒超时），返回 `{ok, data?, error?}`。

---

## 3. 两个自检命令的返回字段

### 3.1 `ping`（**这是我们要拿来做「Bridge 在线 / 工程已打开」的那个**）

`docs/plugin_main.js.baseline:155-163`
```js
COMMANDS.ping = function (a) {
    return ok({
        version: VERSION,
        editor: "FairyGUI",
        port: Bridge.port,
        projectPath: projectDirectory(),
        projectOpen: App.project != null,
        project: projectLabel()
    });
};
```
→ **实测可用字段**：`version`、`editor`、`port`、`projectPath`、**`projectOpen`（布尔）**、`project`。
→ ✅ **我们在 `src/create/exec-plan.js` 的 runtimeChecks 里写的「`ping.projectOpen === true`」是成立的**（此前是假设，现在有源码依据）。

`project_info`（`:165-176`）返回 `{port, packages, packageNames[], projectPath, name?, path?}`，取包列表可用。

### 3.2 `discover_projects`

- **不在插件里**：`docs/BRIDGE-COMMANDS.md:24-25` 记为「MCP 本地实现」；`mcp_server.mjs.baseline:320`：`if (cmd === 'discover_projects') return {ok: true, data: await discover()};`
- 它的数据源**可确认**：`plugin_main.js.baseline:1082-1095` 注册条目
  ```js
  var entry = {
      port: port,
      url: "http://127.0.0.1:" + port + "/",
      project: projectLabel(),
      projectPath: projectDirectory(),
      startedAt: new Date().toISOString()
  };
  ...
  CS.System.IO.File.WriteAllText(folder + '/' + port + '.json', JSON.stringify(entry));
  ```
  注册表路径 `~/.fgui-agent-bridge/registry.json`，另在 `instances/` 目录放 `<port>.json`（:1095 附近，注释说明「两个编辑器同时启动时避免丢注册」）。
  `mcp_server.mjs.baseline:26` 描述：「List all online FairyGUI editor projects with absolute paths and ports」。
- ❌ **确切返回字段名不可确认**（`discover()` 在 `instances.mjs` 里，我们没有）。但**字段内容**可确认就是 registry 那 5 个字段。

---

## 4. 不可确认项（要问朋友的清单）

1. **`cli/instances.mjs` 源码**（最关键）
   我们是这样知道它存在的：`mcp_server.mjs.baseline:12`
   ```js
   import { discover, route, request, stripSelector } from '../cli/instances.mjs';
   ```
   朋友脚本也是从它 import：`out/fb/ink-fgui - test2/.objs/_assemble_rest.mjs:1`
   ```js
   import { request } from '../../fairygui-agent-bridge/cli/instances.mjs';
   ```
   **该文件在本仓库与朋友的压缩包里都不存在**（`find` 全仓 + `out/fb` 均无命中）。因此无法确认：
   - `request(url, cmd, args, timeoutMs)` 的**超时实现**（是 HTTP 超时？还是命令队列超时？超时后返回 `{ok:false,error}` 还是抛异常？）
   - 是否内置**重试**；
   - `route(args)` 的**选择算法**（`project` / `port` / `bridge_url` 三者的优先级与匹配方式）；
   - `stripSelector(args)` 具体剥掉哪些字段（推测是剥 project/port/bridge_url/timeout_ms，**但这是推测，未证实**）。
2. **`discover_projects` 的返回字段名**（虽然我们能自己扫 registry 复刻，但对齐官方更好）。
3. **并发/排队语义**：插件是**严格单线程**队列（`plugin_main.js.baseline:8`、`:1228 Bridge.queue.push`），命令按队串行执行 —— 与 SKILL.md「同一组件上的编辑命令串行」一致；但**队列满/长时间未完成的判据**未确认（我们应自己做超时，不能依赖）。
4. **异步命令（如 `publish`）的返回约定**：`UPSTREAM-README.md` 命令表写「异步，完成才返回」，但**超时上限与 `timeout_ms` 的关系**未确认。
5. **是否需要 `Content-Type`**：插件不校验（已确认），但官方 CLI 是否显式发送无从确认（不影响我们：我们显式发 `application/json` 即可）。

---

## 5. 我们能先做到哪一步

**可以立刻写一个最小可用的 HTTP 适配器**（`transport.send(op, args)` → `POST` → 解 `{ok,data}`/`{ok,error}`），依据充分：

```
依据汇总：
  POST + 路径 /      → plugin_main.js.baseline:1141, :1213-1227；UPSTREAM-README.md:96
  body {cmd,args}    → plugin_main.js.baseline:1219-1227（错误信息原文写明）
  响应 {ok,data|error} → plugin_main.js.baseline:56-57（定义）
  端口/URL          → plugin_main.js.baseline:47,51,1133；mcp_server.mjs.baseline:14
  ping.projectOpen  → plugin_main.js.baseline:155-163
```

最小可用伪码（**依据见上，不含任何推测字段**）：
```js
// 依据：plugin_main.js.baseline:1219-1227（body 形状）与 :56-57（响应包装）
async function send(op, args = {}, { url = process.env.FGUI_BRIDGE_URL || 'http://127.0.0.1:7531/' , timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);           // 超时由我们自己兜（instances.mjs 不可见）
  try {
    const res = await fetch(url, {                                    // POST /     (:1141, :1213)
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: op, args }),                        // {"cmd","args"}
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!json || typeof json.ok !== 'boolean') {                      // 插件只回 JSON
      return { ok: false, error: `bad response: HTTP ${res.status}` };
    }
    return json.ok ? { ok: true, data: json.data ?? null }             // {ok:true,data}
                   : { ok: false, error: json.error ?? 'unknown' };    // {ok:false,error}
  } catch (e) {
    return { ok: false, error: `bridge unreachable: ${e.message} (is the FairyGUI editor running with the plugin?)` };
  } finally {
    clearTimeout(timer);
  }
}
```
`ping` 自检（字段有源码依据，:155-163）：
```js
const r = await send('ping');
// r.ok && r.data.projectOpen === true && r.data.port && r.data.projectPath
```

**在拿到 `instances.mjs` 之前，以下三件事建议先不做**：
1. 复刻官方的多实例路由（`project`/`port`/`bridge_url` 优先级未知）—— 我们可以先只支持显式 `bridge_url` + env，这是**保守且不猜**；
2. 依赖 `discover_projects` 的字段名 —— 需要时改扫 `~/.fgui-agent-bridge/instances/*.json`（字段已确认，见 §3.2），不猜字段名；
3. 依赖内建重试 —— 我们自己实现「失败即停 + 显式报错」，与 SKILL.md「编辑命令串行、上一条成功再发下一条」一致。
