'use strict';
/**
 * src/cli/cmd-gen-xml.js —— [P1 桩] 生成 FGUI 组件 XML
 *
 * ★ 本轮（P0）不实现，只明确边界 ★（ARCHITECTURE 决策 12 / §9.4）
 *
 * 为什么不实现：
 *   开发者本机**没有 FairyGUI / Unity / C# 环境**（PRD K2）。
 *   写出来的 XML 没有任何办法验证 —— 不能跑通、不能对账、不能回归。
 *   与其写一堆无法验证的代码，不如把**契约与纯函数**（lint 规则、FGUI 常量）先定死，
 *   M4 时小 Q 一提供 FGUI 工程副本就能直接开工。
 *
 * P1 的实现路线（ARCHITECTURE §5.2 选 C：离线生成 XML + lint + 事务写盘）：
 *   ① 读 change_plan.json（可人工编辑）
 *   ② 生成候选 XML 到内存
 *   ③ lintComponentXml(候选)     ── 有 error ─→ 退出码 3，不动磁盘
 *   ④ 写 <target>.tmp
 *   ⑤ 复检 tmp 内容               ── 有 error ─→ 删 tmp，退出码 3
 *   ⑥ 目标已存在 ─→ 复制 <target> → <target>.bak.<ts>
 *   ⑦ fs.rename(tmp, target)      —— 原子替换
 *   ⑧ 任一步失败 ─→ 用 .bak 恢复，返回 { applied:false }，退出码 5
 *
 * ★ 上游踩坑硬约束（P1 实现时必须遵守，见 src/fgui/constants.js）★
 *   · 颜色只用 6 位 + alpha="0.x" 属性（8 位 #RRGGBBAA 运行时只取后 6 位 → 纯蓝）
 *   · `ui://` 包 id 必须 8 位（6 位会吃掉 itemId 首字符）
 *   · **不使用 OpenDocument**（静默返回 null / 被 unity 裁剪）
 *   · **不使用 screenshot**（truthy 但不可调用，必须 try/catch 实调）
 *   · 编辑器开着时**不手写 package.xml**（会被内存态覆盖）
 *   · 字段名拼写就是 `extention`（不是 extension）
 */

const { EXIT } = require('../core/errors');

/**
 * 桩实现：诚实上报「未实现 + 需要什么」。
 * @param {Object} ctx
 * @returns {Promise<number>}
 */
async function run(ctx) {
  const { logger } = ctx;
  logger.warn('gen-xml 在 P0 未实现', { reason: '需 FGUI 工程副本才能验证' });

  const payload = {
    command: 'gen-xml',
    ok: false,
    implemented: false,
    status: 'P1_STUB',
    reason: '本轮（P0）不实现 XML 生成：本机无 FairyGUI/Unity/C# 环境，'
      + '写出的 XML 无法验证（PRD K2 / ARCHITECTURE 决策 12）。',
    whatIsReady: [
      'src/fgui/constants.js   —— 10 种合法 displayList 标签 / 8 种 extention / 8 位包 id 等硬约束（纯常量，P0 已定死）',
      'src/fgui/lint-rules.js  —— 纯函数 lint（入参 XML 字符串，不碰文件系统），P0 即可完整单测',
      'src/core/atomic.js      —— 原子写 + .bak 备份 + 回滚（now 可注入，便于 B9 验证）',
      'change_plan.json        —— 已产出且人可读可改，可直接作为 gen-xml 的输入',
    ],
    blockedBy: [
      { id: 'Q1', question: 'FairyGUI 编辑器具体版本号？', owner: '小Q' },
      { id: 'Q2', question: 'package.xml 包 id 是否稳定 8 位？', owner: '小Q' },
      { id: 'Q3', question: '能否提供脱敏 FGUI 工程副本（包结构 + 2~3 组件）？', owner: '小Q' },
      { id: 'Q4', question: '组件 XML 的实际缩进/换行风格？', owner: '小Q' },
      { id: 'Q5', question: '编辑器开着时手改组件 XML 会不会被内存态覆盖？', owner: '小Q' },
      { id: 'Q6', question: 'OpenDocument 是否可用？', owner: '需脚本实测，禁止凭记忆回答' },
    ],
    nextStep: 'M4：小Q 提供 Q1~Q5 答案 + Q3 工程副本后，按 ARCHITECTURE §4.3 的 8 步序列实现。',
    upstreamPitfalls: [
      '#RRGGBBAA 运行时只取后 6 位 → 纯蓝（颜色必须 6 位 + alpha 属性）',
      'ui:// 包 id 非 8 位会吃掉 itemId 首字符',
      'OpenDocument 静默失败 / 被 unity 裁剪 → 不使用',
      'screenshot truthy 但不可调用 → 不使用，改 OS 级截屏',
      'package.xml 编辑器开着时手写会被内存态覆盖 → 写盘前必须关编辑器',
      'extention 是上游拼写（不是 extension）',
    ],
    hint: '当前可做的：node bin/fgui-rb.js selftest 跑通 P0 全链路；'
      + '打开 change_plan.md 与 ir_overlay.*.html 人工核对解析结果。',
  };

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return EXIT.USAGE; // 2 = 参数错误/功能未就绪，语义上最接近
}

module.exports = { run };
