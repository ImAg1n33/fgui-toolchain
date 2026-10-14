'use strict';
/** QA-3：组bbox 推导 —— 先自己造一份全新 PSD 验证前提，不信工程师的文档 */
const fs=require('fs'), path=require('path'), os=require('os');
const { installCanvasShim, createImageData } = require('../src/psd/canvas-shim');
installCanvasShim();
const agpsd = require('ag-psd');
const { deriveGroupBox, IrBuilder } = require('../src/psd/ir-builder');
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}

function solid(w,h,rgba){const img=createImageData(w,h);for(let i=0;i<w*h;i++){img.data[i*4]=rgba[0];img.data[i*4+1]=rgba[1];img.data[i*4+2]=rgba[2];img.data[i*4+3]=rgba[3];}return img;}
function raster(name,x,y,w,h,rgba,hidden){return {name,left:x,top:y,right:x+w,bottom:y+h,imageData:solid(w,h,rgba),opacity:1,hidden:!!hidden,blendMode:'normal'};}
function group(name,children,hidden){return {name,children,hidden:!!hidden,opacity:1,blendMode:'normal'};}

console.log('=== QA-3.1 自己造全新 PSD：验证「组自身 bbox 恒为 0」前提 ===');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa-bbox-'));
const myPsd = {
  width: 400, height: 300,
  children: [
    group('单层组', [ raster('叶A', 30, 40, 100, 60, [255,0,0,255]) ]),
    group('多层组', [
      raster('叶B', 10, 10, 50, 50, [0,255,0,255]),
      raster('叶C', 200, 150, 80, 40, [0,0,255,255]),
    ]),
    group('嵌套组外层', [
      group('嵌套组内层', [ raster('叶D', 5, 5, 30, 30, [1,2,3,255]) ]),
      raster('叶E', 300, 200, 20, 20, [9,9,9,255]),
    ]),
    group('空组', []),
    group('全隐藏子层组', [ raster('叶F', 50, 50, 40, 40, [5,5,5,255], true) ]),
    group('部分可见组', [
      raster('叶G_可见', 0, 0, 25, 25, [7,7,7,255], false),
      raster('叶H_隐藏', 350, 280, 10, 10, [8,8,8,255], true),
    ]),
  ],
};
const buf = agpsd.writePsdBuffer(myPsd);
const bufPath=path.join(tmp,'qa-my.psd');
fs.writeFileSync(bufPath, buf);
console.log(`  我造的 PSD: ${buf.length} bytes, canvas 400x300, 6 个顶层组`);

// 不装 shim 也读不了，所以先装
const readBack = agpsd.readPsd(fs.readFileSync(bufPath), { skipLayerImageData: true, useImageData: true });
console.log('\n  --- ag-psd 读回的组自身坐标（关键前提）---');
for (const ch of readBack.children) {
  const own = { left: ch.left, top: ch.top, right: ch.right, bottom: ch.bottom };
  const ownW = (ch.right??0)-(ch.left??0), ownH=(ch.bottom??0)-(ch.top??0);
  console.log(`   ${ch.name.padEnd(14)} children=${(ch.children||[]).length}  own bbox=(${ch.left},${ch.top})-(${ch.right},${ch.bottom}) => ${ownW}x${ownH}`);
}
const allZero = readBack.children.every(ch => (ch.left??0)===0 && (ch.top??0)===0 && (ch.right??0)===0 && (ch.bottom??0)===0);
ok('★前提验证：所有顶层组自身 left/top/right/bottom 全为 0', allZero,
   readBack.children.map(c=>`${c.name}:${c.left},${c.top},${c.right},${c.bottom}`).join(' '));
// 只对「子层里的组」断言 own bbox 为 0；叶子层坐标本就该非 0，混在一起断言会误报
ok('★前提验证：内层嵌套组（子层中的组）own bbox 也是 0',
   (readBack.children.find(c=>c.name==='嵌套组外层')?.children||[])
     .filter(ch=>(ch.children||[]).length>0)
     .every(ch=>(ch.left??0)===0&&(ch.top??0)===0&&(ch.right??0)===0&&(ch.bottom??0)===0),
   JSON.stringify((readBack.children.find(c=>c.name==='嵌套组外层')?.children||[]).map(c=>[c.name,c.left,c.top,c.right,c.bottom])));

console.log('\n=== QA-3.2 deriveGroupBox 独立调用（不经过 IrBuilder）===');
// 单层组：叶A (30,40,100x60) => x=30,y=40,w=100,h=60
let d = deriveGroupBox([{left:30,top:40,right:130,bottom:100}]);
ok('单层组推导正确 (30,40,100x60)', d.box.x===30&&d.box.y===40&&d.box.w===100&&d.box.h===60, JSON.stringify(d));
// 多层组：叶B(10,10,50x50) 叶C(200,150,80x40) => 并集 x=10,y=10,maxX=280,maxY=190 => 10,10,270x180
d = deriveGroupBox([{left:10,top:10,right:60,bottom:60},{left:200,top:150,right:280,bottom:190}]);
ok('多层组并集正确 (10,10,270x180)', d.box.x===10&&d.box.y===10&&d.box.w===270&&d.box.h===180, JSON.stringify(d));
// 空组
d = deriveGroupBox([]);
ok('空组返回 0,0,0,0 且 used=0', d.box.x===0&&d.box.y===0&&d.box.w===0&&d.box.h===0&&d.used===0, JSON.stringify(d));
d = deriveGroupBox(null);
ok('deriveGroupBox(null) 不崩', d && d.box.w===0, JSON.stringify(d));
d = deriveGroupBox(undefined);
ok('deriveGroupBox(undefined) 不崩', d && d.box.w===0, JSON.stringify(d));
// 零尺寸子层被跳过
d = deriveGroupBox([{left:0,top:0,right:0,bottom:0},{left:5,top:5,right:25,bottom:25}]);
ok('零尺寸子层被跳过且记 skipped=1', d.used===1&&d.skipped===1&&d.box.x===5&&d.box.w===20, JSON.stringify(d));
// 负尺寸
d = deriveGroupBox([{left:50,top:50,right:10,bottom:10}]);
ok('right<left 的畸形层 w=0 被跳过', d.used===0, JSON.stringify(d));
// 部分可见 —— ★关键：隐藏子层是否参与并集？
d = deriveGroupBox([{left:0,top:0,right:25,bottom:25},{left:350,top:280,right:360,bottom:290}]);
console.log(`  [注] 部分可见组（隐藏层仍在children 里）: ${JSON.stringify(d.box)} —— 隐藏层也参与了并集`);

console.log('\n=== QA-3.3 经 IrBuilder 端到端（含 bboxSource 标记可靠性）===');
const full = agpsd.readPsd(fs.readFileSync(bufPath), { skipLayerImageData: false, useImageData: true });
const b = new IrBuilder({ withPhash:true });
const ir = b.build({ psd: full, psdPath: bufPath, sha256:'x'.repeat(64), slices: [] });
for (const l of ir.layers) {
  console.log(`   ${l.id} ${l.type.padEnd(6)} ${String(l.name).padEnd(14)} bbox=${JSON.stringify(l.bbox)} src=${l.bboxSource}${l._derive?' derive='+JSON.stringify(l._derive):''}`);
}

console.log('\n=== QA-3.4 ★尝试找出「标own 但实际为 0」的情况 ===');
// 场景1: 叶子图层自身坐标为 0（空图层）—— 标 own 但 bbox 0
const ownZero = ir.layers.filter(l=>l.bboxSource==='own' && l.bbox.w===0 && l.bbox.h===0);
console.log(`  标 own 且 bbox 为 0 的叶子: ${ownZero.length} 个 -> ${ownZero.map(l=>l.id+':'+l.name+':'+l.type).join(', ')||'无'}`);
// 有没有告警？
const warnedIds = new Set(ir.warnings.filter(w=>w.code==='EMPTY_LAYER').map(w=>w.layer));
const notWarned = ownZero.filter(l=>!warnedIds.has(l.id));
ok('★所有 own+零尺寸叶子都有 EMPTY_LAYER 告警（不得静默）', notWarned.length===0,
   `未告警: ${notWarned.map(l=>l.id+':'+l.name).join(', ')}`);
// 场景2: 组合并集推导后为 0 但标 derived
const derZero = ir.layers.filter(l=>l.bboxSource==='derived' && l.bbox.w===0 && l.bbox.h===0);
console.log(`  标 derived 且 bbox 为 0 的组: ${derZero.length} 个 -> ${derZero.map(l=>l.id+':'+l.name).join(', ')||'无'}`);
ok('★derived+零尺寸的组必须有可查的 _derive 记录（人能看到为什么空）',
   derZero.every(l=>l._derive && typeof l._derive.usedChildren==='number'),
   JSON.stringify(derZero.map(l=>({id:l.id,_derive:l._derive}))));
console.log(`  组合并集为 0 时是否有 EMPTY_LAYER 告警: ${derZero.filter(l=>warnedIds.has(l.id)).length}/${derZero.length}`);
// 场景3:组 bbox 边界 —— 子层都在组内但组自身坐标为 0，验证没有把 0 当作并集参与者
const nested = ir.layers.find(l=>l.name==='嵌套组外层');
const expectedOuter = (()=>{ // 手工算：内层组并集(5,5,30x30) ∪ 叶E(300,200,20x20)
  const a={x:5,y:5,w:30,h:30}, b={x:300,y:200,w:20,h:20};
  const minX=Math.min(a.x,b.x), minY=Math.min(a.y,b.y);
  const maxX=Math.max(a.x+a.w,b.x+b.w), maxY=Math.max(a.y+a.h,b.y+b.h);
  return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};})();
console.log(`  嵌套组外层: got=${JSON.stringify(nested.bbox)} 手工期望=${JSON.stringify(expectedOuter)}`);
ok('★嵌套组：外层并集必须包含「内层组的推导并集」而非内层的0',
   nested.bbox.x===expectedOuter.x&&nested.bbox.y===expectedOuter.y&&nested.bbox.w===expectedOuter.w&&nested.bbox.h===expectedOuter.h,
   `若内层组0被直接用，外层会是 (300,200,20x20)`);
const innerGroup = ir.layers.find(l=>l.name==='嵌套组内层');
ok('嵌套组内层 bbox 正确 (5,5,30x30)', innerGroup.bbox.x===5&&innerGroup.bbox.y===5&&innerGroup.bbox.w===30&&innerGroup.bbox.h===30, JSON.stringify(innerGroup.bbox));

console.log(`\nQA-3 结果: pass=${pass} fail=${fail}`);
try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
process.exit(fail>0?1:0);
