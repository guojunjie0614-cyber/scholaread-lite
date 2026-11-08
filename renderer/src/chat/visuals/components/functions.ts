// Adapted from thesysdev/open-intelligent-ui (MIT); see THIRD_PARTY_NOTICES.md.
import { defineFunction } from '@openuidev/react-lang';
import { z } from 'zod/v4';
const finite = (value: number) => { if (!Number.isFinite(value)) throw new Error('结果不是有限数值'); return value; };
const Pow = defineFunction({name:'Pow',description:'base raised to exponent',params:z.object({base:z.number(),exponent:z.number()}),returns:z.number(),fn:({base,exponent})=>finite(Math.pow(base,exponent))});
const Sqrt = defineFunction({name:'Sqrt',description:'Square root; null for negative input',params:z.object({number:z.number()}),returns:z.number(),fn:({number})=>finite(Math.sqrt(number))});
const Clamp = defineFunction({name:'Clamp',description:'Bound a value between min and max',params:z.object({value:z.number(),min:z.number(),max:z.number()}),returns:z.number(),fn:({value,min,max})=>finite(Math.min(max,Math.max(min,value)))});
const Percent = defineFunction({name:'Percent',description:'part / total × 100; null if total is zero',params:z.object({part:z.number(),total:z.number()}),returns:z.number(),fn:({part,total})=>finite(part / total * 100)});
const Format = defineFunction({name:'Format',description:'Format a finite number with up to decimals digits; percent takes 45 for 45%',params:z.object({value:z.number(),kind:z.enum(['number','percent','compact']).optional(),decimals:z.number().optional()}),returns:z.string(),fn:({value,kind='number',decimals=2})=>`${finite(value).toLocaleString('zh-CN',{maximumFractionDigits:Math.min(10,Math.max(0,Math.trunc(decimals))),...(kind==='compact'?{notation:'compact'}:{})})}${kind==='percent'?'%':''}`});
export const functions = [Pow,Sqrt,Clamp,Percent,Format];
