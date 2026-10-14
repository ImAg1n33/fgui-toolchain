'use strict';
/** QA-4.2b 修正：合成图必须用 skipCompositeImageData:false 才读 */
const fs=require('fs'),path=require('path'),os=require('os');
const shim=require('../src/psd/canvas-shim');
shim.installCanvasShim();
const agpsd=require('ag-psd');
const { readPsdFile, compositeImageData } = require('../src/psd/reader');
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa-shim2-'));
function solid(w,h,fn){const img=shim.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);const i=(y*w+x)*4;
    img.data[i]=r;img.data[i+1]=g;img.data[i+2]=b;img.data[i+3]=a;}return img;}

const CW=64,CH=64,W=8,H=4;
const expect=(x,y)=>[x*30+5,y*60+7,(x*y)%256,255];
const p=path.join(tmp,'c.psd');
// ★ 必须自己提供 psd.imageData ★
//   ag-psd 的 writer **不会自动合成图层**（psdWriter.js:218 只写你给的 imageData），
//   不给就读回一张全黑图。本项目已把该能力封装为
//   src/psd/canvas-shim.js 的 composeImageData() + checkComposite()，fixture 与
//   外部调用方共用同一份实现，避免两处逻辑漂移。
const layers=[{name:'L',left:10,top:20,right:10+W,bottom:20+H,imageData:solid(W,H,expect),opacity:1,blendMode:'normal'}];
const composite=shim.composeImageData(CW,CH,layers);
// 阈值说明：图层只占画布 32/4096=0.78%，故用 0.5% 作为下限（小图/小图层场景）
const chk=shim.checkComposite(composite,{minNonBlackRatio:0.005});
ok('★合成图自检非退化（全黑即造错了，不该放行）', chk.ok, chk.msg);
fs.writeFileSync(p, agpsd.writePsdBuffer({width:CW,height:CH,children:layers,imageData:composite}));

console.log('=== 合成图（skipCompositeImageData:false）===');
const rd=agpsd.readPsd(fs.readFileSync(p),{skipLayerImageData:false,skipCompositeImageData:false,useImageData:true});
console.log('  psd.imageData:', rd.imageData?`${rd.imageData.width}x${rd.imageData.height}`:'null');
console.log('  psd.canvas   :', rd.canvas?`${rd.canvas.width}x${rd.canvas.height} isShim=${!!rd.canvas.__isShim}`:'null');
let src='psd.imageData';
let comp = rd.imageData || (rd.canvas&&rd.canvas.__isShim?rd.canvas._getPixels():null);
ok('合成图可得（imageData 或 shim canvas 像素）', !!comp, '两者皆null');
if(comp){
  let bad=0,s=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=((20+y)*CW+(10+x))*4; const e=expect(x,y);
    for(let c=0;c<3;c++) if(comp.data[i+c]!==e[c]){bad++; if(s.length<5)s.push(`(${x},${y})c${c} 期望${e[c]} 实得${comp.data[i+c]}`);}
  }
  console.log('  差异样本:', s.length?s.join(' | '):'无');
  ok('★合成图内图层区域像素与写入值一致', bad===0, `${bad} 通道不匹配`);
}

console.log('\n=== 经 reader.js 的 compositeImageData 封装 ===');
const r=readPsdFile(p,{mode:'full'});
const viaReader=compositeImageData(r.psd);
ok('reader.compositeImageData 返回可用像素', !!viaReader && viaReader.width===CW, viaReader?`${viaReader.width}x${viaReader.height}`:'null');
if(viaReader){
  let bad=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=((20+y)*CW+(10+x))*4;const e=expect(x,y);
    for(let c=0;c<3;c++) if(viaReader.data[i+c]!==e[c])bad++;}
  ok('★reader 路径下合成图像素同样正确', bad===0, `${bad} 通道不匹配`);
}

console.log('\n=== 多层source-over 合成正确性（重叠区域应正确混合） ===');
// 底：纯红不透明 4x4；上：半透明蓝 2x2 叠在 (1,1)
// ★ 注意层序：ag-psd 的 children[0] = **最上层**（与 Photoshop 图层面板一致），
//   所以「上」层必须排在数组**前面**，否则会被「底」整块盖住（实测过）。
const base=solid(4,4,()=>[255,0,0,255]);
const top=solid(2,2,()=>[0,0,255,128]);
const p2=path.join(tmp,'m.psd');
// 同上：ag-psd 不会自动合成，必须自己给 psd.imageData
const layers2=[
  {name:'上',left:1,top:1,right:3,bottom:3,imageData:top,opacity:1,blendMode:'normal'},
  {name:'底',left:0,top:0,right:4,bottom:4,imageData:base,opacity:1,blendMode:'normal'}];
fs.writeFileSync(p2, agpsd.writePsdBuffer({width:8,height:8,children:layers2,
  imageData:shim.composeImageData(8,8,layers2)}));
const r2=agpsd.readPsd(fs.readFileSync(p2),{skipLayerImageData:false,skipCompositeImageData:false,useImageData:true});
const c2=r2.imageData||(r2.canvas&&r2.canvas.__isShim?r2.canvas._getPixels():null);
if(c2){
  const at=(x,y)=>{const i=(y*8+x)*4;return [c2.data[i],c2.data[i+1],c2.data[i+2],c2.data[i+3]];};
  console.log('  (0,0) 纯底区域  :',JSON.stringify(at(0,0)));
  console.log('  (2,2) 重叠区域  :',JSON.stringify(at(2,2)),' 期望约 [128,0,127,255]');
  console.log('  (7,7) 空白区域  :',JSON.stringify(at(7,7)));
  const ov=at(2,2);
  // 正确 source-over: out = src*a + dst*(1-a), a=128/255
  const a=128/255;
  const expR=Math.round(0*a+255*(1-a)), expB=Math.round(255*a+0*(1-a));
  ok('重叠区source-over 混合正确', Math.abs(ov[0]-expR)<=2 && Math.abs(ov[2]-expB)<=2, `实得 R=${ov[0]} B=${ov[2]} 期望≈R${expR} B${expB}`);
  ok('空白区alpha=0', at(7,7)[3]===0, JSON.stringify(at(7,7)));
} else ok('多层合成可得', false, '合成图 null');
console.log(`\nQA-4b 结果: pass=${pass} fail=${fail}`);
try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
process.exit(fail>0?1:0);
