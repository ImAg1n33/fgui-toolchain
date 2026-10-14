'use strict';
/** QA-3x 嵌套组 bbox bug 复现 —— 用工程师自己的黄金样本证明他���测试为何漏掉 */
const fs=require('fs'), path=require('path');
const { installCanvasShim } = require('../src/psd/canvas-shim');
installCanvasShim();
const agpsd=require('ag-psd');
const { IrBuilder, deriveGroupBox, boxOfLayer } = require('../src/psd/ir-builder');

console.log('=== 根因定位 ===');
const childGroupLike={name:'嵌套组内层', left:0,top:0,right:0,bottom:0, children:[{left:5,top:5,right:35,bottom:35}]};
console.log('  boxOfLayer(嵌套组) =', JSON.stringify(boxOfLayer(childGroupLike)));
console.log('  -> w=0,h=0 => deriveGroupBox 里被 skipped++ 丢弃。子组的孩子根本没参与并集。');
console.log('  代码注释声称「子层是组 -> 递归」，但实现里没有任何递归调用。');

console.log('\n=== 复现步骤（最小） ===');
const g={name:'外层组', children:[
  {name:'内层组', children:[{left:0,top:0,right:10,bottom:10}]},
  {left:500,top:400,right:520,bottom:420,name:'独叶'},
]};
console.log('  deriveGroupBox(外层组.children) =', JSON.stringify(deriveGroupBox(g.children)));
console.log('  期望: {x:0,y:0,w:520,h:420}  实际: {x:500,y:400,w:20,h:20}');

console.log('\n=== 工程师黄金样本：bug 为何没被测出来 ===');
const p=path.resolve(__dirname,'..','test','fixtures','golden','state_A.psd');
if(!fs.existsSync(p)){console.log('  黄金样本不存在，跳过');process.exit(1);}
const psd=agpsd.readPsd(fs.readFileSync(p),{skipLayerImageData:true,useImageData:true});
const ir=new IrBuilder({withPhash:false}).build({psd,psdPath:p,sha256:'x',slices:[]});
// 手工独立算一遍正确的递归并集
function correctUnion(nodeId, nodes){
  const n=nodes.find(x=>x.id===nodeId);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const ch of nodes.filter(x=>x.parent===nodeId)){
    let bx;
    if(ch.type==='group'){ const r=correctUnion(ch.id,nodes); if(!r) continue; bx=r; }
    else { if(ch.bbox.w<=0||ch.bbox.h<=0) continue; bx=ch.bbox; }
    minX=Math.min(minX,bx.x); minY=Math.min(minY,bx.y);
    maxX=Math.max(maxX,bx.x+bx.w); maxY=Math.max(maxY,bx.y+bx.h);
  }
  if(minX===Infinity) return null;
  return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};
}
console.log('  层idtype name                 parent  实现bbox                递归正确并集             一致?');
let mismatch=0;
for(const l of ir.layers.filter(x=>x.type==='group')){
  const correct=correctUnion(l.id, ir.layers);
  const got=l.bbox;
  const norm=correct||{x:0,y:0,w:0,h:0};
  const same=got.x===norm.x&&got.y===norm.y&&got.w===norm.w&&got.h===norm.h;
  if(!same)mismatch++;
  console.log(`  ${l.id}  ${String(l.name).padEnd(22)} ${String(l.parent).padEnd(6)} ${JSON.stringify(got).padEnd(22)} ${JSON.stringify(norm).padEnd(24)} ${same?'✅':'❌ 不一致'}`);
}
console.log(`\n  黄金样本中不一致的组: ${mismatch} 个`);
console.log('  => 若为 0，说明工程师的 fixture 恰好让内层组的孩子落在其他子层并集内，bug 被掩盖（覆盖不足）。');
console.log('  => 一旦真实 PSD 出现「内层组是组 bbox 的唯一来源」或「内层组比兄弟节点更外扩」，bbox 就会静默偏小。');

console.log('\n=== 影响面：bbox 偏小会污染什么 ===');
const irA=ir;
for(const l of irA.layers.filter(x=>x.type==='group')){
  const c=correctUnion(l.id, irA.layers);
  if(c && (c.w!==l.bbox.w||c.h!==l.bbox.h)){
    console.log(`  ⚠ ${l.name}: 实现 ${l.bbox.w}x${l.bbox.h} vs 正确 ${c.w}x${c.h} —— `);
    console.log(`     L2尺寸校验会用错的w/h；positionTolerance/IoU 全部失准；ir_overlay 会画错框。`);
  }
}
