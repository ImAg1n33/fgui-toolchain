'use strict';
/** 第二轮 · ★主动 hunt 新的静默错误（沿用第一轮方法：不报错、不崩溃、结果错） */
const fs=require('fs'),path=require('path'),os=require('os');
const shim=require('../src/psd/canvas-shim');
shim.installCanvasShim();
const agpsd=require('ag-psd');
const {readPsdFile,compositeImageData,MODE}=require('../src/psd/reader');
const {IrBuilder}=require('../src/psd/ir-builder');
const {deriveGroupBox}=require('../src/psd/ir-builder');
let pass=0,fail=0,silent=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
function silent_(n,e){silent++;console.log(`  [SILENT BUG] ${n}${e?':: '+e:''}`);}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa2-hunt-'));
function solid(w,h,fn){const im=shim.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);const i=(y*w+x)*4;
    im.data[i]=r;im.data[i+1]=g;im.data[i+2]=b;im.data[i+3]=a;}return im;}

console.log('=== H1 ★组内子层的层序：bbox 与合并合成是否一致？===');
// 组内两层部分重叠，且子层顺序影响谁在上
const mk=(inner)=>[{name:'外组',left:0,top:0,right:200,bottom:200,children:inner,opacity:1,blendMode:'normal'}];
const A=mk([
  {name:'上红',left:10,top:10,right:120,bottom:120,imageData:solid(110,110,()=>[255,0,0,255]),opacity:1,blendMode:'normal'},
  {name:'下蓝',left:80,top:80,right:190,bottom:190,imageData:solid(110,110,()=>[0,0,255,255]),opacity:1,blendMode:'normal'},
]);
const p1=path.join(tmp,'ord1.psd');
fs.writeFileSync(p1, agpsd.writePsdBuffer({width:200,height:200,children:A,imageData:shim.composeImageData(200,200,A)}));
const r1=readPsdFile(p1,{mode:MODE.FULL});
const ir1=new IrBuilder({withPhash:false}).build({psd:r1.psd,psdPath:p1,sha256:'x',slices:[]});
const g1=ir1.layers.find(l=>l.name==='外组');
console.log('  外组 bbox='+JSON.stringify(g1.bbox)+' (期望 {0,0,190x190})');
ok('组 bbox 含两个重叠子层的并集', g1.bbox.x===10&&g1.bbox.y===10&&g1.bbox.w===180&&g1.bbox.h===180, JSON.stringify(g1.bbox));
const c1=compositeImageData(r1.psd);
const at1=(c,x,y)=>{const i=(y*200+x)*4;return [c.data[i],c.data[i+1],c.data[i+2]];};
console.log('  合成图 (100,100) 重叠区='+JSON.stringify(at1(c1,100,100))+'（应=红=children[0] 在上）');
ok('★重叠区红色在上（层序正确）', at1(c1,100,100)[0]===255, JSON.stringify(at1(c1,100,100)));

console.log('\n=== H2 ★隐藏层是否参与合成与 bbox（两者应一致）===');
const B=[{name:'可见',left:0,top:0,right:50,bottom:50,imageData:solid(50,50,()=>[200,50,50,255]),opacity:1,blendMode:'normal'},
         {name:'隐藏',left:100,top:100,right:150,bottom:150,imageData:solid(50,50,()=>[50,200,50,255]),opacity:1,hidden:true,blendMode:'normal'}];
const p2=path.join(tmp,'hid.psd');
fs.writeFileSync(p2, agpsd.writePsdBuffer({width:200,height:200,children:B,imageData:shim.composeImageData(200,200,B)}));
const r2=readPsdFile(p2,{mode:MODE.FULL});
const c2=compositeImageData(r2.psd);
const hiddenVisible = at1(c2,120,120).some(v=>v!==0);
console.log('  隐藏层在合成图里可见? '+hiddenVisible+'  色='+JSON.stringify(at1(c2,120,120)));
const ir2=new IrBuilder({withPhash:false}).build({psd:r2.psd,psdPath:p2,sha256:'x',slices:[]});
const hidL=ir2.layers.find(l=>l.name==='隐藏');
console.log('  IR 中隐藏层 visible='+hidL.visible+' bbox='+JSON.stringify(hidL.bbox));
if(hiddenVisible && hidL.visible===false) console.log('  ⚠ 合成图里有隐藏层像素，但 IR 标 visible=false —— 两者不一致');
ok('隐藏层不出现在合成图', !hiddenVisible, `隐藏层在(120,120)有像素 ${JSON.stringify(at1(c2,120,120))}`);

console.log('\n=== H3 ★opacity<1 的层：bbox 用它但像素要不要乘opacity？===');
const C=[{name:'半透明',left:0,top:0,right:50,bottom:50,imageData:solid(50,50,()=>[255,255,255,255]),opacity:0.5,blendMode:'normal'}];
const c3=shim.composeImageData(50,50,C);
console.log('  opacity=0.5 的白层 -> 合成后 alpha='+c3.data[3]+'（期望≈128）');
ok('★composeImageData 尊重 layer.opacity', Math.abs(c3.data[3]-128)<=3, `alpha=${c3.data[3]}`);

console.log('\n=== H4 ★clipped / blendMode 非 normal 是否被静默当成 normal ===');
const D=[{name:'正片叠底',left:0,top:0,right:40,bottom:40,imageData:solid(40,40,()=>[200,100,50,255]),opacity:1,blendMode:'multiply'}];
const c4=shim.composeImageData(40,40,D);
console.log('  单层 multiply -> '+JSON.stringify([c4.data[0],c4.data[1],c4.data[2],c4.data[3]]));
console.log('  注：单层时 multiply 与 normal 结果相同，无法区分 —— 属已知简化，需记录');

console.log('\n=== H5★组内为空但组合并集非0：空子组是否被误算 ===');
const E=[{name:'空组',children:[],opacity:1,blendMode:'normal'},
         {name:'有内容',left:30,top:30,right:90,bottom:90,imageData:solid(60,60,()=>[9,9,9,255]),opacity:1,blendMode:'normal'}];
const d=deriveGroupBox(E);
console.log('  deriveGroupBox([空组, 60x60叶]) = '+JSON.stringify(d.box)+' skipped='+d.skipped+' used='+d.used);
ok('空组被跳过、有内容层被计入', d.box.w===60&&d.skipped===1&&d.used===1, JSON.stringify(d));

console.log('\n=== H6 ★★关键：IR 的 _derive.skippedChildren 是否有人看？===');
console.log('  第一轮我发现「组并集为 0 时没有 EMPTY_LAYER 告警」，本轮复查：');
const irEmptyG=new IrBuilder({withPhash:false}).build({psd:{width:100,height:100,children:[
  {name:'空组A',children:[],opacity:1,blendMode:'normal'}]},
  psdPath:'x',sha256:'x',slices:[]});
const ea=irEmptyG.layers.find(l=>l.name==='空组A');
const warned=irEmptyG.warnings.filter(w=>w.layer===ea.id);
console.log('  空组的 bbox='+JSON.stringify(ea.bbox)+' _derive='+JSON.stringify(ea._derive));
console.log('  针对该层的 warnings 数='+warned.length+(warned.length?' -> '+JSON.stringify(warned):' -> 无告警'));
if(warned.length===0) console.log('  ⚠ 第一轮的问题仍在：组 bbox 为 0 无告警（叶子层有 EMPTY_LAYER，组没有）');
ok('空组 bbox 为 0 时有告警', warned.length>0, '无告警 —— 人看不到这个组的 bbox 是空的');

console.log('\n=== H7 ★deriveGroupBox 对「组内含零尺寸叶子 + 非零叶子」===');
const F=[{name:'零',left:0,top:0,right:0,bottom:0},{name:'正常',left:10,top:10,right:40,bottom:40}];
const dF=deriveGroupBox(F);
ok('混合零/非零叶子正确', dF.box.w===30&&dF.skipped===1, JSON.stringify(dF));

console.log('\n=== H8★composeImageData 对超出画布的层（right>width）===');
const G=[{name:'越界',left:80,top:40,right:200,bottom:120,imageData:solid(120,80,()=>[120,30,200,255]),opacity:1,blendMode:'normal'}];
let cG;
try{ cG=shim.composeImageData(100,100,G);
  console.log('  越界层 (80,40)-(200,120) 写入 100x100 画布 -> 不崩');
  // 越界部分应被裁掉，且不越界写内存
  let bad=0;
  for(let y=0;y<100;y++)for(let x=0;x<100;x++){const i=(y*100+x)*4;
    const srcX=x-80, srcY=y-40;
    if(srcX>=0&&srcX<120&&srcY>=0&&srcY<80){const e=[120,30,200,255];
      if(cG.data[i]!==e[0])bad++;}}
  ok('★越界层被正确裁剪（不越界、不崩溃）', bad===0, `${bad} 像素错`);
}catch(e){ ok('越界层不崩', false, e.message); }

console.log('\n=== H9 ★负坐标图层（PSD 里图层可在画布外）===');
const I=[{name:'画布外',left:-50,top:-30,right:20,bottom:25,imageData:solid(70,55,()=>[200,50,120,255]),opacity:1,blendMode:'normal'}];
try{
  const cI=shim.composeImageData(100,100,I);
  console.log('  负坐标层 -> 不崩，可见区(0,0)='+JSON.stringify([cI.data[0],cI.data[1],cI.data[2],cI.data[3]]));
  ok('负坐标层的可见部分正确合成', cI.data[0]===200&&cI.data[1]===50&&cI.data[2]===120&&cI.data[3]===255,
     JSON.stringify([cI.data[0],cI.data[1],cI.data[2],cI.data[3]]));
}catch(e){ ok('负坐标层不崩', false, e.message); }

console.log(`\nH 结果: pass=${pass} fail=${fail} silent=${silent}`);
try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
process.exit(fail>0?1:0);
