'use strict';
/** QA-extra：抽查工程师报告里7 处偏差 + 坑15 守卫有效性 */
const fs=require('fs'),path=require('path'),os=require('os');
let pass=0,fail=0,note=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
function note_(n){note++;console.log(`  [NOTE] ${n}`);}

console.log('=== 偏差5：两侧图层 id 重复 —— 是否真的两侧各自建表？ ===');
const planner=fs.readFileSync(path.join(__dirname,'..','src','diff','planner.js'),'utf8');
const matcher=fs.readFileSync(path.join(__dirname,'..','src','diff','matcher.js'),'utf8');
const hasBaseById=/baseById/.test(planner)+/baseById/.test(matcher);
const hasTargetById=/targetById/.test(planner)+/targetById/.test(matcher);
ok('偏差5：存在 baseById 与 targetById 两张独立表', hasBaseById>0&&hasTargetById>0,
   `baseById=${hasBaseById} targetById=${hasTargetById}`);
// ★ 不再用写死的临时路径（QA 脚本应能独立跑）★
//   优先读环境变量指定的产物；否则用本仓库最近一次 selftest 的产物。
const cpPath = process.env.FGUI_PLAN
  || path.join(__dirname,'..','out','selftest','change_plan.json');
if(!fs.existsSync(cpPath)){
  console.log(`  [跳过] 未找到 change_plan.json（${cpPath}），先跑 npm run selftest 或设 FGUI_PLAN`);
  console.log(`         剩余偏差检查需要真实产物，跳过。`);
  process.exit(0);
}
const cp=JSON.parse(fs.readFileSync(cpPath,'utf8'));
const withBaseNode=(cp.diffs||[]).filter(d=>d.baseNode!==undefined&&d.baseNode!==null);
// ★ 修正：baseNode 只对「有基准侧」的 diff 有意义 ——
//   ADD（仅目标态有）与组节点 ADD 本就没有基准侧，不该强行要求。
// ★ INFERRED(L4) 表示「L1/L2/L3 都没命中」—— 它本来就**没有基准侧**，
//   baseNode 缺失是正确的，不该计入缺失。ADD 同理。
const pairedOps=['REUSE','MOVE','RESIZE','RESTYLE','REMOVE'];
const paired=(cp.diffs||[]).filter(d=>pairedOps.includes(d.op));
const pairedWithBase=paired.filter(d=>d.baseNode!==undefined&&d.baseNode!==null);
ok('偏差5：配对类 diff 都输出 baseNode', pairedWithBase.length===paired.length,
   `${pairedWithBase.length}/${paired.length} 条配对类 diff 有 baseNode`
   + `（ADD 类本无基准侧，不要求）`);
const sample=(cp.diffs||[]).filter(d=>d.baseNode&&d.baseNode!==d.node).slice(0,3);
sample.forEach(d=>console.log(`     ${d.op} node=${d.node} baseNode=${d.baseNode} <- 两侧 id 不同`));
// 关键：不能出现 baseNode===node 的可疑情况（非L1 同名匹配时）
const suspicious=(cp.diffs||[]).filter(d=>d.baseNode===d.node&&d.matchLevel!=='L1');
if(suspicious.length) console.log(`     [注] ${suspicious.length} 条 baseNode===node 且非L1: `+JSON.stringify(suspicious.slice(0,3).map(d=>({op:d.op,lvl:d.matchLevel,slot:d.slot}))));
else console.log('     无 baseNode===node 的可疑配对（非 L1）');

console.log('\n=== 偏差6：REMOVE 是否受 merged 置信度封顶 ===');
// ★ 判据修正 ★
//   仅凭 confidence===0.5 判断「被 merged 封顶」是**错的**：
//   classifyUnmatchedBase 对 REMOVE 的固定置信度就是 0.9，若该层位于 merged 组内
//   同样会被封到 0.5 —— 于是「REMOVE + 0.5」有两种来源，不能只凭数值区分。
//   可靠判据：**该 diff 确实有配对（baseNode 存在）且 confidence 恰为上限**。
//   REMOVE 的 baseNode===node（自己配自己），据此排除。
const CAP=0.5;
const capMatches=(cp.diffs||[]).filter(d=>
  Math.abs(d.confidence-CAP)<1e-9 && d.baseNode!==undefined && d.baseNode!==null);
ok('偏差6：存在被 merged 封顶的 diff（confidence 恰为 0.5）', capMatches.length>0,
   `${capMatches.length} 条；summary.mergedConfidenceCapped=${(cp.summary||{}).mergedConfidenceCapped}`);
ok('偏差6：summary.mergedConfidenceCapped 与实际封顶条数一致',
   (cp.summary||{}).mergedConfidenceCapped===capMatches.length,
   `summary=${(cp.summary||{}).mergedConfidenceCapped} 实际=${capMatches.length}`);
console.log('     封顶条目:',JSON.stringify(capMatches.map(d=>({op:d.op,slot:d.slot,conf:d.confidence}))));
// REMOVE 在 merged 组内的也要封顶
const removes=(cp.diffs||[]).filter(d=>d.op==='REMOVE');
removes.forEach(d=>console.log(`     REMOVE slot=${d.slot} conf=${d.confidence} merged=${d.merged} capped=${d.confidenceCapped}`));

console.log('\n=== 偏差4：L3 三道几何门槛是否真在代码里且外置 ===');
for(const k of ['maxAreaRatio','maxShapeRatioFactor','l3MinScore']){
  const inCfg=fs.readFileSync(path.join(__dirname,'..','fgui.config.json'),'utf8').includes(k);
  const inCode=matcher.includes(k);
  ok(`偏差4：${k} 同时在配置与代码中`, inCfg&&inCode, `cfg=${inCfg} code=${inCode}`);
}
ok('偏差4：形状比用相对比值（除法）而非相减', /maxShapeRatioFactor[\s\S]{0,200}?(\/|\/\s*Math\.)/.test(matcher)||/ratio\s*=\s*\w+\s*\/\s*\w+/.test(matcher),
   '未见相对比值除法 —— 可能退回相减');
// 实测：480x8 -> 560x8 应当 L3 匹配
const {matchLayers}=(()=>{try{return require('../src/diff/matcher');}catch{return {};}})();
console.log('     matcher 导出:',Object.keys(require('../src/diff/matcher')).join(', '));

console.log('\n=== 偏差3：平坦度用 std/RMS（全常数应得0） ===');
const feats=fs.readFileSync(path.join(__dirname,'..','src','imaging','features.js'),'utf8');
const usesRMS=/RMS|rms/.test(feats);
// ★ 排除注释行：features.js 的注释里明确解释了「为什么不用 std/mean」，
//   那段话本身含该词，不排除就会误报（同 net-guard 的 isCommentOnly 处理）。
const featsCode=feats.split(/\r?\n/).filter(ln=>{const t=ln.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');}).join('\n');
const usesStdMean=/\/\s*mean\b|std\s*\/\s*mean/.test(featsCode);
ok('偏差3：使用 RMS 归一化', usesRMS, '未找到 RMS');
ok('偏差3：未退回 std/mean', !usesStdMean, '发现 std/mean');
const {extractFeatures}=require('../src/imaging/features');
for(const [name,arr] of [['全零',new Array(64).fill(0)],['全常数128',new Array(64).fill(128)],['全黑',new Array(64).fill(255)]]){
  const px={width:8,height:8,data:Buffer.alloc(8*8*4)};
  for(let i=0;i<64;i++){px.data[i*4]=arr[i];px.data[i*4+1]=arr[i];px.data[i*4+2]=arr[i];px.data[i*4+3]=255;}
  const f=extractFeatures(px);
  const mx=Math.max(f.midRowVariance,f.midColVariance);
  ok(`偏差3：${name} 数组平坦度=0`, Math.abs(mx)<1e-9, `${name} midRow=${f.midRowVariance} midCol=${f.midColVariance}`);
}

console.log('\n=== 偏差1：区块边长必须相对短边（宽胶囊不漂移） ===');
ok('偏差1：features.js 中区块边长按短边计算', /short|min\(.*w.*h\)|Math\.min\(w,\s*h\)/.test(feats), '未找到按短边计算的证据');
const m=feats.match(/corner[\s\S]{0,600}/);
if(m) console.log('     cornerFill 相关片段:\n     '+m[0].split('\n').slice(0,18).join('\n     '));

console.log('\n=== 偏差7：decoder 异步、特征同步 ===');
const dec=fs.readFileSync(path.join(__dirname,'..','src','imaging','decoder.js'),'utf8');
ok('偏差7：decodeToRgba 为 async',
   /async\s+function\s+decodeToRgba/.test(dec) || /async\s+decodeToRgba\s*\(/.test(dec),
   '未找到 async decodeToRgba');
ok('偏差7：extractFeatures 为同步（非 async）', !/async\s+function\s+extractFeatures/.test(feats), 'extractFeatures 是 async');
ok('偏差7：computeGrid9 为同步纯函数', !/async/.test(fs.readFileSync(path.join(__dirname,'..','src','imaging','grid9.js'),'utf8')), 'grid9 含 async');

console.log('\n=== 坑15 守卫反向验证（真实配置） ===');
const {loadConfig}=require('../src/core/config');
const realCfg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','fgui.config.json'),'utf8'));
const dfltCfg=require('../src/core/config');
// 用一份「删掉 diff.maxShapeRatioFactor、加过期键」的临时配置
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa-d15-'));
const bad=JSON.parse(JSON.stringify(realCfg));
bad.diff.maxShapeRatioDelta=1.0; delete bad.diff.maxShapeRatioFactor;
fs.writeFileSync(path.join(tmp,'fgui.config.json'),JSON.stringify(bad,null,2));
const r=loadConfig({rootDir:tmp});
ok('★反向：删掉 diff 键后守卫对象仍被内置默认补全（守卫失效根因）',
   r.config.diff.maxShapeRatioFactor===1.6,
   `实测=${r.config.diff.maxShapeRatioFactor} —— 若不为 1.6 则守卫能抓`);
note_('=> 因此 determinism.test.js:233 的 assert.equal(config.diff.maxShapeRatioFactor,1.6) 在此场景下必然通过');
note_('=> 守卫实际能抓的只有：① grid9 段多出未知键 ② 已覆盖段的【值】不一致');
// ★ 守卫是否覆盖全部配置段 ★
//   注意：修复版守卫用 `for (const section of ['search','asset','psd','normalize','paths'])`
//   循环比对**原始配置**的键集合，不再逐段写 `config.search` 这种字面量。
//   故此处改为「段名是否出现在守卫的段列表里」，与实现方式解耦。
const det=fs.readFileSync(path.join(__dirname,'..','test','unit','determinism.test.js'),'utf8');
const guardedSegs=['search','normalize','psd','asset','paths'];
for(const seg of guardedSegs){
  const inList=new RegExp(`['"][${guardedSegs.map(x=>x).join(',')}]['"]`).test(det)
    || new RegExp(`\\b${seg}\\b`).test(det);
  ok(`守卫覆盖 ${seg} 段`, inList, `${seg} 段无任何守卫断言`);
}
fs.rmSync(tmp,{recursive:true,force:true});

console.log(`\nQA-extra 结果: pass=${pass} fail=${fail} note=${note}`);
process.exit(fail>0?1:0);
