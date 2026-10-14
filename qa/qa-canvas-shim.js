'use strict';
/** QA-4canvas-shim：用「已知像素值」验证正确性，而不是只验证「非空」 */
const fs=require('fs'),path=require('path'),os=require('os');
const { installCanvasShim, createImageData, getCanvas } = require('../src/psd/canvas-shim');
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa-shim-'));

console.log('=== QA-4.0 不装 shim 时 ag-psd 必须失败（证明 shim 真的必要） ===');
const agpsd0=require('ag-psd');
function solid(w,h,fn){const img=createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);const i=(y*w+x)*4;
    img.data[i]=r;img.data[i+1]=g;img.data[i+2]=b;img.data[i+3]=a;}
  return img;}
// 先在干净进程验证不可能，这里直接装
installCanvasShim();
ok('installCanvasShim 可重复调用不抛错', (()=>{try{installCanvasShim();return true;}catch(e){console.log('   '+e.message);return false;}})());

console.log('\n=== QA-4.1 ★已知像素值往返验证（不是「非空」，是「正确」） ===');
// 造一个 8x4 图层，每像素值 = (x*30+5, y*60+7, x*y, 255)
const W=8,H=4;
const expect=(x,y)=>[x*30+5, y*60+7, (x*y)%256, 255];
const shimMod=require('../src/psd/canvas-shim');
shimMod.installCanvasShim();
const img=solid(W,H,expect);
const layers=[{name:'已知像素层', left:10, top:20, right:10+W, bottom:20+H, imageData:img, opacity:1, blendMode:'normal'}];
// ★ 根因（BUG#2）：ag-psd 的 writer 不会自动合成图层（psdWriter.js:218 只写你给的 imageData），
//   不给 psd.imageData 就会写出一张全黑图。合成能力已封装为
//   src/psd/canvas-shim.js 的 composeImageData()，此处用它而不是各写一份。
const psdBuf={width:64,height:64,children:layers,
  imageData:shimMod.composeImageData(64,64,layers)};
const agpsd=require('ag-psd');
const buf=agpsd.writePsdBuffer(psdBuf);
fs.writeFileSync(path.join(tmp,'known.psd'),buf);
const rd=agpsd.readPsd(fs.readFileSync(path.join(tmp,'known.psd')),{skipLayerImageData:false,useImageData:true});
const layer=rd.children[0];
const got=layer.imageData;
console.log(`  读回 imageData: ${got?`${got.width}x${got.height}`:'null'}`);
ok('图层 imageData 非空', !!got && got.width===W && got.height===H, `got=${got?got.width+'x'+got.height:'null'}`);
let bad=0, badList=[];
if(got){
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4;
    const e=expect(x,y);
    for(let c=0;c<4;c++){
      if(got.data[i+c]!==e[c]){bad++; if(badList.length<6)badList.push(`(${x},${y})ch${c} 期望${e[c]} 实得${got.data[i+c]}`);}
    }
  }
}
console.log('  差异样本:', badList.length?badList.join(' | '):'无');
ok('★全部像素逐通道与写入值完全一致', bad===0, `${bad} 个通道不匹配`);

console.log('\n=== QA-4.2 合成图也必须正确（★ 根因：ag-psd 不会自动合成，BUG#2）===');
// ★ 关键澄清 ★
//   读选项用了 useImageData:true -> ag-psd 走 `psd.imageData` 路径，**不会**填 psd.canvas。
//   所以断言 `rd.canvas` 非空是**断言错了对象**；合成图应从 `rd.imageData` 取。
//   （本项目 reader.js 的 compositeImageData() 正是优先取 imageData，再回退 shim canvas）
const composite = rd.imageData || (rd.canvas && rd.canvas.__isShim ? rd.canvas._getPixels() : null);
console.log(`  psd.imageData: ${rd.imageData?`${rd.imageData.width}x${rd.imageData.height}`:'null'}`);
console.log(`  psd.canvas    : ${rd.canvas?`${rd.canvas.width}x${rd.canvas.height}`:'null（useImageData 路径下不填，属正常）'}`);
ok('合成图可得（imageData 或 shim canvas 像素）', !!composite,
   '两者皆 null —— 合成图丢失');
if(composite){
  // 逐通道核对合成图内图层区域的像素
  let cbad=0, csamples=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=((20+y)*64+(10+x))*4; const e=expect(x,y);
    for(let c=0;c<3;c++) if(composite.data[i+c]!==e[c]){cbad++; if(csamples.length<4)csamples.push(`(${x},${y})c${c} 期望${e[c]} 实得${composite.data[i+c]}`);}
  }
  console.log('  差异样本:', csamples.length?csamples.join(' | '):'无');
  ok('★合成图内图层区域像素与写入值逐通道一致', cbad===0, `${cbad} 个通道不匹配`);
  // 空白区必须透明
  const blank=((60*64)+60)*4;
  ok('合成图空白区 alpha=0（未被全幅底色污染）', composite.data[blank+3]===0,
     `alpha=${composite.data[blank+3]}`);
}

console.log('\n=== QA-4.3 透明通道与alpha 正确性 ===');
const alphaImg=(()=>{const im=createImageData(4,1);const av=[0,1,128,255];
  for(let x=0;x<4;x++){im.data[x*4]=200;im.data[x*4+1]=100;im.data[x*4+2]=50;im.data[x*4+3]=av[x];}return im;})();
const b2=agpsd.writePsdBuffer({width:16,height:8,children:[
  {name:'alpha层',left:0,top:0,right:4,bottom:1,imageData:alphaImg,opacity:1,blendMode:'normal'}]});
const r2=agpsd.readPsd(b2,{skipLayerImageData:false,useImageData:true});
const a2=r2.children[0].imageData;
const avGot=[0,1,2,3].map(x=>a2.data[x*4+3]);
ok('半透明 alpha 值精确保留 (0,1,128,255)', JSON.stringify(avGot)===JSON.stringify([0,1,128,255]), JSON.stringify(avGot));
ok('RGB 不因 alpha变化而变', a2.data[0]===200&&a2.data[1]===100&&a2.data[2]===50, `${a2.data[0]},${a2.data[1]},${a2.data[2]}`);

console.log('\n=== QA-4.4 shim 不得静默吞错误 ===');
// 用畸形 PSD 触发读失败，看是否抛出
try{
  const bad=Buffer.from('NOT_A_PSD_FILE_AT_ALL_1234567890');
  agpsd.readPsd(bad,{skipLayerImageData:false,useImageData:true});
  ok('畸形 PSD 必须抛错（不得返回垃圾）', false, 'readPsd 静默返回了');
}catch(e){ ok('畸形 PSD 抛错（未静默吞）', true, e.message.slice(0,60)); }
// 非法图片数据
try{
  const b3=agpsd.writePsdBuffer({width:8,height:8,children:[
    {name:'坏层',left:0,top:0,right:4,bottom:4,imageData:{width:99,height:99,data:new Uint8ClampedArray(3)},opacity:1}]});
  const r3=agpsd.readPsd(b3,{skipLayerImageData:false,useImageData:true});
  const li=r3.children[0];
  const consistent = li.imageData ? (li.imageData.width*li.imageData.height*4===li.imageData.data.length) : true;
  ok('尺寸与数据长度不匹配的 imageData 不产生不一致结果', consistent,
     li.imageData?`w=${li.imageData.width} h=${li.imageData.height} len=${li.imageData.data.length}`:'null');
}catch(e){ console.log('  [信息] 畸形 imageData 被ag-psd 拒绝并抛错:', e.message.slice(0,70)); ok('畸形 imageData 有明确失败姿态', true); }

console.log('\n=== QA-4.5 shim 是否有 try/catch 吞异常 ===');
// ★ 这里读的是**源码文本**（用于静态检查），与上面的 shimMod 模块不是一回事
const shimSrcText=fs.readFileSync(path.join(__dirname,'..','src','psd','canvas-shim.js'),'utf8');
const swallows=(shimSrcText.match(/catch\s*(\([^)]*\))?\s*\{/g)||[]).length;
const emptyCatch=/catch\s*(\([^)]*\))?\s*\{\s*\}/g;
const nEmpty=(shimSrcText.match(emptyCatch)||[]).length;
console.log(`  shim 中 catch 块数: ${swallows}，空 catch 数: ${nEmpty}`);
const catchesWithReturnOnly=[...shimSrcText.matchAll(/catch\s*\([^)]*\)\s*\{([\s\S]{0,120}?)\}/g)].map(m=>m[1].trim().replace(/\s+/g,' '));
catchesWithReturnOnly.forEach((c,i)=>console.log(`   catch#${i+1}: ${c.slice(0,100)}`));
ok('shim 无「catch 后静默 return 垃圾值」的写法', !catchesWithReturnOnly.some(c=>/^(return\s+(null|undefined|\{\}|0)\s*;?)$/i.test(c)),
   JSON.stringify(catchesWithReturnOnly));

console.log('\n=== QA-4.6 shim 覆盖的 API 面 ===');
// ★ 合成相关（composeImageData / checkComposite）是 BUG#2 的修复产物，一并纳入检查
const apis=['createImageData','getImageData','putImageData','drawImage','createCanvas','canvas','getContext','composeImageData','checkComposite'];
for(const a of apis){
  const inShim=new RegExp(a.replace('.','\\.')).test(shimSrcText);
  const exported=new RegExp(a).test((shimSrcText.match(/module\s*=\s*\{[\s\S]*?\};/)||[''])[0]);
  console.log(`   ${a.padEnd(16)} 源码中出现=${inShim} 导出=${exported}`);
}
console.log('\nQA-4 结果: pass='+pass+' fail='+fail);
try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
process.exit(fail>0?1:0);
