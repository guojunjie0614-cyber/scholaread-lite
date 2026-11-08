import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'scholarlite-import-ipc-'));
const handlers=new Map();
const calls=[];
globalThis.importIpc={handlers,pick:{canceled:false,filePaths:['/fixture']},calls};
try {
  await build({entryPoints:['electron/library-import-ipc.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(tmp,'ipc.mjs'),plugins:[{name:'isolated-ipc',setup(builder){
    builder.onResolve({filter:/^(electron|\.\/library-import\.js)$/},args=>({path:args.path,namespace:'mock'}));
    builder.onLoad({filter:/.*/,namespace:'mock'},args=>({loader:'js',contents:args.path==='electron' ? `export const ipcMain={handle:(name,fn)=>globalThis.importIpc.handlers.set(name,fn)}; export const BrowserWindow={fromWebContents:()=>null}; export const dialog={showOpenDialog:async()=>globalThis.importIpc.pick};` : `export const discoverLibraries=async()=>[{path:'/found',label:'Zotero',source:'zotero'}]; export const importDiscoveredLibraries=options=>new Promise(resolve=>{globalThis.importIpc.calls.push({source:'auto',...options,resolve});}); export const importLibrary=(source,path,options)=>new Promise(resolve=>{globalThis.importIpc.calls.push({source,path,...options,resolve});});`}));
  }}]});
  const {registerLibraryImportIpc}=await import(pathToFileURL(path.join(tmp,'ipc.mjs'))); registerLibraryImportIpc();
  const sender=id=>Object.assign(new EventEmitter(),{id,isDestroyed:()=>false,send:(channel,value)=>calls.at(-1).event={channel,value}});
  const a=sender(1),b=sender(2);
  const invoke=(name,s,...args)=>handlers.get('libraryImport:'+name)({sender:s},...args);
  assert.deepEqual(await invoke('discover',a),[{path:'/found',label:'Zotero',source:'zotero'}]);
  assert.equal(await invoke('choose',a),'/fixture');
  globalThis.importIpc.pick={canceled:true,filePaths:[]}; assert.equal(await invoke('choose',a),null);
  await assert.rejects(invoke('start',a,'bad','/fixture'),/来源/);
  await assert.rejects(invoke('start',a,'zotero',null),/目录/);
  for(const end of ['cancel','navigate','render-process-gone','destroyed','complete']) {
    const running=invoke('start',a,'zotero','/fixture');const call=calls.at(-1);
    await assert.rejects(invoke('start',b,'zotero','/fixture'),/已有/);
    invoke('cancel',b); assert.equal(call.signal.aborted,false);
    call.onProgress({processed:1});assert.equal(call.event.channel,'libraryImport:progress');
    if(end==='cancel') invoke('cancel',a);
    if(end==='navigate'){a.emit('did-start-navigation',{},'sub',false,false);assert.equal(call.signal.aborted,false);a.emit('did-start-navigation',{},'main',false,true);}
    if(end==='render-process-gone') a.emit(end);
    if(end==='destroyed') a.emit(end);
    assert.equal(call.signal.aborted,end!=='complete');
    call.resolve({cancelled:call.signal.aborted});await running;
    for(const event of ['destroyed','did-start-navigation','render-process-gone']) assert.equal(a.listenerCount(event),0);
  }
  const automatic=invoke('auto',a); const auto=calls.at(-1); assert.equal(auto.source,'auto');
  await assert.rejects(invoke('start',b,'folder','/fixture'),/已有/); invoke('cancel',a); assert.equal(auto.signal.aborted,true); auto.resolve({cancelled:true}); await automatic;
  console.log('PASS library import IPC: input checks, discovery, native picker, single job, owner cancellation, navigation/crash/close and cleanup');
} finally { delete globalThis.importIpc; await fs.rm(tmp,{recursive:true,force:true}); }
