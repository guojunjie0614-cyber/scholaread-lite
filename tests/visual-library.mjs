import { build } from 'esbuild';
import { createParser, evaluateElementProps } from '@openuidev/lang-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir('.work/visual-prompt/check', {recursive:true});
await build({entryPoints:['renderer/src/chat/visuals/library.tsx','renderer/src/chat/visuals/examples.ts','renderer/src/chat/visuals/components/chart.tsx'],outdir:'.work/visual-prompt/check',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const { library } = await import('../.work/visual-prompt/check/library.js');
const examples = await import('../.work/visual-prompt/check/examples.js');
const { toSpec } = await import('../.work/visual-prompt/check/components/chart.js');
const parser = createParser(library.toJSONSchema(), library.root);
for (const [name, program] of Object.entries(examples)) {
 const result = parser.parse(program);
 console.log(name, result.meta.errors, result.meta.unresolved, result.meta.orphaned);
 assert.equal(result.meta.errors.length, 0); assert.ok(result.root);
 const html = renderToStaticMarkup(createElement(Renderer,{response:program,library,isStreaming:false,publishObservability:false}));
 assert.ok(html.length>200); console.log(name, html.length);
}
assert.equal(toSpec({type:'bar',data:[{x:'A',y:1},{x:'B'}],x:'x',series:['y']}),null);
assert.equal(toSpec({type:'bar',data:[{x:'A',y:'unknown'}],x:'x',series:['y']}),null);
assert.equal(toSpec({type:'pie',data:[{x:'A',y:-1}],x:'x',series:['y']}),null);
assert.ok(toSpec({type:'bar',data:[{x:'A',y:0}],x:'x',series:['y']}));
const schema=library.toJSONSchema(); const functions=Object.fromEntries(Object.entries(schema.functions).map(([name,s])=>[name,{...s,fn:library.functions[name].fn}]));
const p=parser.parse(examples.sliderExample);
function evaluateWith(value) {
 const errors=[]; const ctx={getState:name=>name==='$s'?value:p.stateDeclarations[name],resolveRef:()=>undefined,functions};
 const root=evaluateElementProps(p.root,{ctx,library,store:null,errors});
 assert.equal(errors.length,0);
 return root.props.children;
}
for(const value of [20,75]) {
 const children=evaluateWith(value);
 const chart=children.find(node=>node.typeName==='Chart');
 assert.equal(toSpec(chart.props).rows[1]['操作数'],100-value);
 assert.equal(children.find(node=>node.typeName==='Text').props.text,`剩余操作数：${100-value}`);
}
console.log('PASS examples, reactive values, missing-data rejection');
