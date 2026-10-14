'use strict';
const g=require('../src/core/net-guard');
console.log('=== 第一轮我报的 5 个盲区，现在是否被捕获？ ===');
const blind=[
  ['ESM import http',"import http from 'http';"],
  ['globalThis.fetch','globalThis.fetch("http://x")'],
  ['require undici',"const {request}=require('undici');"],
  ['process.dlopen','process.dlopen(module,"x.node")'],
  ['动态 require 变量',"const m='ht'+'tp';require(m);"],
];
for(const [n,src] of blind){
  const hits=g.scanContent('e.js',src);
  const errs=hits.filter(h=>h.severity==='error');
  const warns=hits.filter(h=>h.severity==='warn');
  console.log('  '+n.padEnd(20)+' error='+errs.length+' warn='+warns.length+'  '+(errs.length?'[拦截]':warns.length?'[仅告警]':'[漏网]'));
  hits.forEach(h=>console.log('       ['+h.severity+'] '+h.label));
}
console.log('');
console.log('=== ALLOWED_BUILTINS 真判断验证 ===');
console.log('  白名单:',[...g.ALLOWED_BUILTINS].join(', '));
const inL=g.scanContent('e.js',"require('sharp');");
const outL=g.scanContent('e.js',"require('some-unknown-lib');");
console.log("  require('sharp')          -> "+inL.length+" 命中");
console.log("  require('some-unknown-lib') -> "+outL.length+" 命中"+(outL.length?" ["+outL[0].severity+"] "+outL[0].label:""));
console.log('');
console.log('=== ★分级是否会让「真违规」被放过？ ===');
console.log('  src/ 扫描结果:');
const path=require('path');
const hits=g.scanSourceTree(path.join(__dirname,'..','src'));
const errs=hits.filter(h=>h.severity==='error');
const warns=hits.filter(h=>h.severity==='warn');
console.log('    error='+errs.length+' warn='+warns.length);
warns.slice(0,10).forEach(h=>console.log('    [warn] '+h.file+':'+h.line+' '+h.label));
console.log('');
console.log('  assertNoNetwork 是否把 warn 也当失败？');
try{ g.assertNoNetwork(path.join(__dirname,'..','src')); console.log('    -> 通过（0 error）'); }
catch(e){ console.log('    -> 抛错:',e.message.slice(0,100)); }
console.log('');
console.log('=== require 全部内置模块是否被白名单放过（关键：白名单太宽会成漏洞）===');
const risky=['http','https','net','dns','tls','dgram','child_process','worker_threads','inspector','repl','vm','module','cluster','http2','querystring','zlib','fs','path','crypto','os','util','stream','url'];
for(const m of risky){
  const h=g.scanContent('e.js',"require('"+m+"');");
  const e=h.filter(x=>x.severity==='error').length;
  const w=h.filter(x=>x.severity==='warn').length;
  const state=e?'ERROR拦截':w?'仅warn':'漏网/白名单';
  console.log('  '+m.padEnd(16)+' error='+e+' warn='+w+'  '+state);
}
