import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'scholar-clipboard-'));
try {
  await fs.mkdir(path.join(root,'dist')); await fs.writeFile(path.join(root,'dist/index.html'),'');
  const electron=path.join(root,'electron.mjs'),service=path.join(root,'service.mjs');
  await fs.writeFile(electron,`export const app={getAppPath:()=>${JSON.stringify(root)}}; export const BrowserWindow={fromWebContents:s=>s.window}; export const ipcMain={handle:(name,fn)=>globalThis.handlers.set(name,fn)}; export const clipboard={writeText:text=>globalThis.writes.push(text)};`);
  await fs.writeFile(service,'export const chatService=()=>({});');
  globalThis.handlers=new Map(); globalThis.writes=[];
  const outfile=path.join(root,'ipc.mjs');
  await build({entryPoints:['electron/chat/ipc.ts'],outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'mock',setup(b){
    b.onResolve({filter:/^electron$/},()=>({path:electron}));
    b.onResolve({filter:/^\.\/service\.js$/},()=>({path:service}));
  }}]});
  const {registerChatIpc}=await import(pathToFileURL(outfile)); registerChatIpc();
  const frame={},sender={mainFrame:frame,isDestroyed:()=>false,window:{},getURL:()=>pathToFileURL(path.join(root,'dist/index.html')).href,once:()=>{}};
  const copy=globalThis.handlers.get('chat:copyText');
  copy({sender,senderFrame:frame},'A 3 ms, B 5 ms');
  assert.deepEqual(globalThis.writes,['A 3 ms, B 5 ms']);
  assert.throws(()=>copy({sender,senderFrame:{}},'blocked'),/无权/);
  assert.throws(()=>copy({sender:{...sender,getURL:()=> 'https://example.com'},senderFrame:frame},'blocked'),/无权/);
  assert.throws(()=>copy({sender,senderFrame:frame},{}),/无效/);
  assert.throws(()=>copy({sender,senderFrame:frame},'x'.repeat(1000001)),/过长/);
  assert.equal(globalThis.writes.length,1);
  console.log('Chat clipboard: trusted main-frame write, input bounds, no read endpoint passed.');
} finally { await fs.rm(root,{recursive:true,force:true}); }
