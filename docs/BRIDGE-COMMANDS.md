# Bridge 命令词表（CREATE Executor 地基）

> **来源**：`docs/plugin_main.js.baseline`（插件层，`COMMANDS.*` + `ASYNC_STARTERS`）与
> `docs/mcp_server.mjs.baseline`（MCP tool 层，`TOOLS`）。**逐条以源码为准**，不做推断。
> 交叉印证：朋友工程的 `.cursor/skills/fgui-ai-assembly/SKILL.md`（只用于印证用法，不用于补全参数）。
>
> ★ 两条通道的差别（重要）★
> · **插件层**：`plugin_main.js` 里 `COMMANDS[cmd]` 是真正的执行体；`ASYNC_STARTERS` 里是跨帧异步命令。
> · **MCP 层**：`mcp_server.mjs` 的 `TOOLS` 是暴露给 AI 的 tool；未出现在 `TOOLS` 的插件命令**调不到**。
> · 所有 MCP tool（除 `discover_projects`）都会自动追加三个**路由参数**：`project`（推荐，绝对路径/.fairy）、
>   `port`、`bridge_url`。下表不重复列出。

## 概览

- 插件层命令：**26 个**（`COMMANDS` 25 个 + `ASYNC_STARTERS.publish` 1 个）
- MCP 暴露 tool：**26 个**
- **插件有、MCP 没暴露**：`write_component`（→ 经 MCP **不可用**；SKILL.md 亦明令「不要调用 write_component」）
- **MCP 有、插件 COMMANDS 没有**：`discover_projects`（MCP 本地实现，读本机在线工程列表）、`publish`（插件侧是异步 starter）

## 一、只读 / 探测类

| 命令 | 参数（必填 **粗体**） | 作用 | 写盘 | 需编辑器 |
|---|---|---|---|---|
| `discover_projects` | 无 | 列出本机在线的 FairyGUI 工程（路径 + 端口） | 否 | **否**（MCP 本地） |
| `ping` | 无 | 探活 + 版本 + 工程是否打开（`projectOpen`） | 否 | 是 |
| `project_info` | 无 | 当前工程名/包列表；未打开工程直接抛 `no project open` | 否 | 是 |
| `list_packages` | 无 | 包列表 `{id, name, basePath}` | 否 | 是 |
| `list_items` | **pkg**, depth（默认 3，1=顶层） | 包内资源树（组件/图片/字体 + id/path）；itemUrl 形如 `ui://<pkgId><itemId>` | 否 | 是 |
| `read_component` | **pkg**, **name** | 返回组件 XML 原文 `{name, url, xml}` | 否 | 是 |
| `list_children` | **pkg**, **name** | 打开组件并列出舞台子节点 `{name, id, objType}` | 否 | 是 |
| `open_doc` | **pkg**, **name** | 打开组件文档 | 否（编辑器状态变化） | 是 |
| `close_doc` | **pkg**, **name** | 关闭组件文档（外部改 XML 前必须先关，否则 `save_all` 会用内存态覆盖） | 否 | 是 |
| `bridge_log` | tail（默认 40） | 插件日志尾部（调试） | 否 | 是 |

## 二、建资源 / 改资源类

| 命令 | 参数（必填 **粗体**） | 作用 | 写盘 | 需编辑器 |
|---|---|---|---|---|
| `create_package` | **name** | `FProject.CreatePackage`；编辑器分配 8 位包 id（非 8 位会抛错） | 是（`project.Save`） | 是 |
| `create_component` | **pkg**, **name**, **width**, **height**；path, extention, exported | `CreateComponentItem`；width/height 必须 >0；name 已存在会抛错；extention ∈ Button/Label/ComboBox/ProgressBar/Slider/ScrollBar/List/Tree（或省略=普通组件）。成功后**会 ensureDocOpen** 并返回 `{id,name,url,file,openable:true}` | 是（`pkg.Save`） | 是 |
| `write_component` | **xml**（完整 `<component>`）, **name**；pkg, width, height, path, extention, exported | 一次写入整份组件 XML（不存在则先建组件项）。写前会 `CloseDocument` 防覆盖。**不在 MCP 词表内** | 是（直接写 .xml） | 是 |
| `delete_item` | **pkg**, **name** | `pkg.DeleteItem` | 是 | 是 |
| `set_image_scale9` | **pkg**, **name**；scale9grid（`l,t,w,h`）, left/top/width/height（=中心矩形）, overwrite | 把**库内图片资源**标为九宫格：改 `package.xml` 的 `scale="9grid" scale9grid="…"` 并 `RefreshProject`。已切过且 `overwrite!==true` 时原样返回 `already:true`。省略切格参数时按三等分。越界直接抛错 | 是（改 package.xml） | 是 |

## 三、舞台编辑类（写组件内容）

| 命令 | 参数（必填 **粗体**） | 作用 | 写盘 | 需编辑器 |
|---|---|---|---|---|
| `insert_object` | **pkg**, **name**；url **或** ref_pkg+ref_name；x, y, index, props | 把**库内已有**资源插到舞台。`url` 优先，否则用 `ref_pkg/ref_name` 按**资源名**查找；`index`=z 序；`props` 立即套属性 | 是（`SaveDocument`） | 是 |
| `insert_text` | **pkg**, **name**, **child**；text, x, y, width, height, fontSize, color, align, vAlign, autoSize, bold, strokeColor, strokeSize, singleLine, index, props | `CreateChild('text')` + `SaveDocument`。`child` = 新对象名 | 是 | 是 |
| `insert_loader` | **pkg**, **name**, **child**；url / refPkg+refName, x, y, width, height, align, vAlign, fill, index, props | 同上的 loader | 是 | 是 |
| `insert_list` | **pkg**, **name**, **child**；defaultItem（组件名或 ui://）, refPkg, layout(single_column/row/flow_hz/flow_vt), lineGap, colGap, lineItemCount, overflow, items[{title,icon}], x, y, width, height, index, props | 同上的 list | 是 | 是 |
| `add_controller` | **pkg**, **name**, **controller**, **pages**（字符串数组）；selected | `Document.AddController`（pages 写成 `0,name,1,name` 形式） | 是 | 是 |
| `set_gear` | **pkg**, **name**, **target**, **gear**（display/text/icon）, **controller**；pages, values, refPkg | `DocElement.UpdateGears`（display=gearDisplay / text=gearText / icon=gearIcon）；icon 的 values 可用资源名（内部会转 url） | 是 | 是 |
| `set_property` | **pkg**, **name**, **props**；target（缺省=组件根）, prop, value | 改**已在舞台上**的子节点属性（编辑器属性名：`xy`/`size`/`title`/`text`/`icon`/`fontSize`/`visible`…；向量类用 `"x,y"` 字符串） | 是 | 是 |
| `remove_object` | **pkg**, **name**, **target** | 从舞台移除子节点 | 是 | 是 |
| `save_all` | 无 | `SaveAllDocuments` | 是 | 是 |
| `refresh` | 无 | `RefreshProject`（拾取外部文件改动） | 否（刷新视图） | 是 |

## 四、发布 / 截图 / 其它

| 命令 | 参数（必填 **粗体**） | 作用 | 写盘 | 需编辑器 |
|---|---|---|---|---|
| `publish` | **pkg**；branch, out_path, timeout_ms | `FairyEditor.PublishHandler`，输出与编辑器点 Publish 逐字节一致。**异步跨帧**（`ASYNC_STARTERS`），超时默认 45s 级 | 是（发布目录） | 是 |
| `screenshot` | **path**（绝对 png 路径） | `UnityEngine.ScreenCapture`。★ 已知风险：被 Unity 裁剪的 API 在 Jint 里可能 truthy 但不可调用，故内部 try/catch 实调；失败会抛「API unavailable … use OS-level window capture」 | 是 | 是 |

## 五、CREATE 需要但我们**找不到**的命令

> 以下全部是「基线里没有」，**不是我编的名字**。每一条都直接影响 Executor 能走多远。

| 缺什么 | 影响 | 现状与替代 |
|---|---|---|
| **导入图片进包并登记**（import asset / add image to package） | ★★★ **最关键**：plan 里 `toImport` 的素材目前**无法**由 Bridge 落地 → 只能人工在编辑器里导入（或朋友侧另有工具） | 基线**没有**。`list_items` 只读、`set_image_scale9` 只改已登记图片的切格。**待朋友确认**是否另有导入通道 |
| **按资源 id 插入**（insert by short id） | ★★★ 真实工程里同包图片用**短资源 ID**（形如 `src="<itemId>"`），而 `insert_object` 只接受 `url`(`ui://…`) 或 `ref_pkg+ref_name`（按**资源名**查） | 基线**没有**按 id 插入的命令。可行做法：调用方额外提供 `pkgId`，由我们拼 `ui://<pkgId><itemId>` 走 `url`；否则只能退回按名字（`ref_name`） |
| **独立的新建 Page** | 若 `Page` 是独立概念就需要专用命令 | 基线**没有** `create_page`。但 SKILL.md 的做法是「`create_component` 建 `Comp`，再同样处理 `Page`」→ **Page 就是一个普通组件**；按此不需要新命令 |
| **设置层级 / 顺序**（独立命令，如 `set_index`/`bring_to_front`） | 只能在**插入时**用 `index` 定 z 序；插入后再调层级没有专用命令 | 基线**没有**独立层级命令。替代：`insert_*` 的 `index`，或 `set_property` 的 props（未在源码里验证 `index` 是否为合法属性名 → **待确认**） |
| **重命名资源/组件**（rename） | 改名需删了重建 | 基线**没有** |
| **删除 controller / gear** | 只能加不能删 | 基线**没有** `remove_controller` |
| **读取 package.xml 原文** | 想自己做登记对账时拿不到原文 | 基线**没有**；只有 `list_items` 的结构化结果（+ `read_component` 读组件 XML） |
| **批量/事务命令** | 多步操作没有原子性 | 基线**没有**；只能逐步调用，失败后人工回滚 |

### 对 Executor 的直接结论

1. **建容器**：`create_package`（如需）→ `create_component`（Page 与 Comp 都是组件）✅ 可用。
2. **插节点**：
   - 图片：`insert_object`（**必须有 `ui://` url** → 需要 `pkgId`）⚠️
   - 文本：`insert_text` ✅
   - 列表：`insert_list`（需先有项目组件作 defaultItem）✅
   - 层级：靠插入顺序 / `index` ✅（无独立改层级命令）
3. **素材导入**：❌ **没有命令** → plan 的 `toImport` 必须人工落地。这是 CREATE 链路**最大的外部依赖**。
4. **保存**：`save_all` ✅；外部改 XML 前要 `close_doc`。
