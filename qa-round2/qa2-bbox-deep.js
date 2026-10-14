'use strict';
/** 第二轮 · BUG#1 独立深挖：递归修复的边界与 MAX_DEPTH 行为 */
const { deriveGroupBox, IrBuilder } = require('../src/psd/ir-builder');
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
const L=(x,y,w,h,n)=>({name:n||('L'+x),left:x,top:y,right:x+w,bottom:y+h});
const G=(children,n)=>({name:n||'G',children});

console.log('=== R2-1.1 基础嵌套（复现第一轮 BUG）===');
let d=deriveGroupBox([G([L(0,0,10,10,'内')]), L(500,400,20,20,'独叶')]);
ok('第一轮 bug 用例已修复', d.box.x===0&&d.box.y===0&&d.box.w===520&&d.box.h===420, JSON.stringify(d.box));
console.log('   ->',JSON.stringify(d.box));

console.log('\n=== R2-1.2 ★深层嵌套（3/4/5 层）===');
// 3 层：只有最深层叶子决定 bbox
let deep3=G([G([G([L(10,20,30,40,'deep')])])]);
d=deriveGroupBox([deep3]);
ok('3 层嵌套：最深层叶子决定 bbox (10,20,30x40)', d.box.x===10&&d.box.y===20&&d.box.w===30&&d.box.h===40, JSON.stringify(d.box));
// 5 层
let deep5=G([G([G([G([G([L(1,2,3,4,'d5')])])])])]);
d=deriveGroupBox([deep5]);
ok('5 层嵌套正确 (1,2,3x4)', d.box.x===1&&d.box.y===2&&d.box.w===3&&d.box.h===4, JSON.stringify(d.box));
// 深层 + 兄弟节点：深层应能突破兄弟的包围
let deepVsSibling=G([G([G([L(0,0,200,200,'deepWide')])]), L(600,600,10,10,'sib')]);
d=deriveGroupBox([deepVsSibling]);
ok('★深层子组比兄弟更外扩时正确 (0,0,610x610)', d.box.x===0&&d.box.y===0&&d.box.w===610&&d.box.h===610, JSON.stringify(d.box));

console.log('\n=== R2-1.3 ★只有子组的组（无任何叶子兄弟）===');
d=deriveGroupBox([G([G([L(50,60,70,80,'onlyNested')])])]);
ok('唯一来源是子组时也正确 (50,60,70x80)', d.box.x===50&&d.box.y===60&&d.box.w===70&&d.box.h===80, JSON.stringify(d.box));

console.log('\n=== R2-1.4 空组 / 全空组嵌套 ===');
d=deriveGroupBox([G([])]);
ok('空组 -> 0,0,0,0 used=0', d.box.w===0&&d.used===0, JSON.stringify(d));
d=deriveGroupBox([G([G([]),G([])])]);
ok('嵌套空组 -> 0,0,0,0', d.box.w===0&&d.used===0, JSON.stringify(d));
// 空组 + 有效叶子
d=deriveGroupBox([G([]), L(10,10,20,20,'ok')]);
ok('空组不干扰有效叶子', d.box.x===10&&d.box.w===20&&d.skipped===1, JSON.stringify(d));

console.log('\n=== R2-1.5★MAX_DEPTH=256 超限行为（静默截断 or 明确报错？）===');
// 造 300 层嵌套
let node=L(1,1,10,10,'bottom');
for(let i=0;i<300;i++) node=G([node]);
const t0=Date.now();
let res;
try{ res=deriveGroupBox([node]); }catch(e){ console.log('   抛错:',e.message.slice(0,80)); }
const dt=Date.now()-t0;
if(res){
  console.log(`   300 层嵌套: box=${JSON.stringify(res.box)} skipped=${res.skipped} used=${res.used} 耗时=${dt}ms`);
  ok('★超深嵌套不栈溢出崩溃（能返回）', true);
  if(res.box.w===0){
    // ★ 第二轮已修：deriveGroupBox 现在返回 depthTruncated 计数，
    //   使「因深度上限降级」与「本来就没有有效子层」在信号上可区分。
    //   空组：skipped=0 且 depthTruncated=0；超深降级：depthTruncated>0。
    console.log(`   超限降级：depthTruncated=${res.depthTruncated}（>0 即与空组可区分）`);
    ok('★超深嵌套的退化可被区分（有信号）', res.depthTruncated>0,
      `depthTruncated=${res.depthTruncated} —— 若为 0 则与空组确实无法区分`);
  } else {
    console.log('   300 层仍算出了 bbox —— 说明 MAX_DEPTH 判定基于 depth 而非节点数，未触发');
  }
}
// 恰好 256 层
let n256=L(2,2,5,5,'x'); for(let i=0;i<254;i++) n256=G([n256]);
res=deriveGroupBox([n256]);
console.log(`   256 层: box=${JSON.stringify(res.box)} used=${res.used}`);
ok('256 层（边界内）仍正确', res.box.w===5&&res.box.h===5, JSON.stringify(res.box));

console.log('\n=== R2-1.6 ★skipped/used 语义在递归后是否仍可解释 ===');
// 子组有内容但被 MAX_DEPTH 跳过时，父层 used 会少算吗？
let shallow=G([L(0,0,10,10,'a')]);
let withDeep=[shallow, (()=>{let n=L(0,0,999,999,'far'); for(let i=0;i<300;i++)n=G([n]); return n;})()];
res=deriveGroupBox(withDeep);
console.log('   混合（浅组有内容 + 超深组）：box='+JSON.stringify(res.box)+' used='+res.used+' skipped='+res.skipped);
// ★ 修正期望 ★：999 那层**深埋在超深子组内**，被正确跳过后**本就不该**进入并集。
//   正确行为是 w=10（只有浅组的 10x10 进入）。
//   原断言期望 w===999，等于要求「跳过也要计入」—— 那正是我们要避免的语义混乱。
ok('超深组被跳过后浅组内容仍正确进入并集（被跳过的层不计入）',
   res.box.w===10&&res.box.h===10, JSON.stringify(res.box));
ok('★被跳过的超深组被如实计入 skipped（而非静默丢弃）', res.skipped===1,
   `skipped=${res.skipped}`);
ok('★超深降级可与空组区分（depthTruncated>0）', res.depthTruncated>0,
   `depthTruncated=${res.depthTruncated} —— 有它才能区分「因深度降级」与「本来就没内容」`);

console.log('\n=== R2-1.7★负坐标 / 越界坐标（真实 PSD 可能有）===');
d=deriveGroupBox([L(-50,-30,100,60,'neg'), L(10,10,20,20,'pos')]);
// ★ 修正期望值 ★：L(x,y,w,h) 的定义是 right=x+w，故 L(-50,-30,100,60) 的
//   并集宽应为 100（覆盖 x∈[-50,50]）而非 80。原断言的 80 是算错了。
ok('负坐标正确处理 (-50,-30,100x60)', d.box.x===-50&&d.box.y===-30&&d.box.w===100&&d.box.h===60, JSON.stringify(d.box));
// 极大坐标
d=deriveGroupBox([L(0,0,30000,20000,'big'), L(50000,40000,10,10,'far')]);
ok('大坐标正确 (0,0,50010x40010)', d.box.w===50010&&d.box.h===40010, JSON.stringify(d.box));
// Infinity/NaN 污染
d=deriveGroupBox([L(0,0,10,10,'a'),{name:'bad',left:NaN,top:0,right:10,bottom:10}]);
ok('NaN 坐标不污染并集', d.box.x===0&&d.box.w===10, JSON.stringify(d.box));
d=deriveGroupBox([{name:'inf',left:Infinity,top:0,right:10,bottom:10}, L(0,0,5,5,'ok')]);
ok('Infinity 坐标不污染并集', d.box.w===5, JSON.stringify(d.box));

console.log('\n=== R2-1.8 null / undefined / 非数组 children ===');
for(const [n,v] of [['null',null],['undefined',undefined],['空数组',[]],['非数组',123]]){
  let r; try{ r=deriveGroupBox(v); ok(`deriveGroupBox(${n}) 不崩且返回 0`, r&&r.box.w===0, JSON.stringify(r)); }
  catch(e){ ok(`deriveGroupBox(${n}) 不崩`, false, e.message); }
}
// children 含 null 元素
d=deriveGroupBox([null, L(0,0,5,5,'ok'), undefined]);
ok('children 含 null 元素被跳过', d.box.w===5&&d.skipped===2, JSON.stringify(d));

console.log('\n=== R2-1.9★IR 节点（已构建）混入 ag-psd 层时的正确性 ===');
// 场景：deriveGroupBox 拿到的是已构建 IR 节点（含 .bbox）而非裸 ag-psd 层
const irNodeGroup={name:'ir组',children:[{name:'ir叶',bbox:{x:100,y:100,w:50,h:50}}]};
d=deriveGroupBox([irNodeGroup]);
ok('★IR 节点（有 .bbox）走 bbox 分支而非坐标分支', d.box.x===100&&d.box.w===50, JSON.stringify(d.box));
// 混搭：IR 组 + 裸层
d=deriveGroupBox([irNodeGroup, L(0,0,10,10,'raw')]);
ok('IR 节点与裸层混搭正确 (0,0,150x150)', d.box.x===0&&d.box.w===150&&d.box.h===150, JSON.stringify(d.box));

console.log(`\nR2-1 结果: pass=${pass} fail=${fail}`);
process.exit(fail>0?1:0);
