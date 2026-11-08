import type { MathItem } from './math';
import { MATH_EXTENSION_FONT as EXTENSION } from './math-fonts';

export interface FormulaRule { x0: number; y0: number; x1: number; y1: number }
export interface FormulaStructure { latex?: string; warnings: string[] }
interface Atom extends MathItem { latex: string; composite?: boolean }

const ACCENT = /^[ˆ̂˙¯̸]$/;
const LEFT_BRACE = /^[{\uF8F1-\uF8F4]$/;
const SYMBOLS: Record<string, string> = {
  'α':'\\alpha','β':'\\beta','γ':'\\gamma','δ':'\\delta','ε':'\\varepsilon','ϵ':'\\epsilon',
  'ζ':'\\zeta','η':'\\eta','θ':'\\theta','κ':'\\kappa','λ':'\\lambda','μ':'\\mu',
  'ν':'\\nu','ξ':'\\xi','π':'\\pi','ρ':'\\rho','σ':'\\sigma','τ':'\\tau','φ':'\\varphi',
  'ϕ':'\\phi','χ':'\\chi','ψ':'\\psi','ω':'\\omega','∆':'\\Delta','Δ':'\\Delta',
  'Γ':'\\Gamma','Θ':'\\Theta','Λ':'\\Lambda','Π':'\\Pi','Σ':'\\Sigma','Φ':'\\Phi',
  'Ψ':'\\Psi','Ω':'\\Omega','ℓ':'\\ell','∑':'\\sum','∏':'\\prod','∫':'\\int',
  '−':'-','–':'-','·':'\\cdot','×':'\\times','∗':'\\ast','±':'\\pm','≤':'\\leq','≥':'\\geq',
  '≠':'\\neq','≈':'\\approx','∞':'\\infty','∈':'\\in','∉':'\\notin',
  '≐':'\\doteq',
  '⌈':'\\left\\lceil','⌉':'\\right\\rceil','⌊':'\\left\\lfloor','⌋':'\\right\\rfloor',
  '⟨':'\\langle','⟩':'\\rangle','∣':'\\vert','‖':'\\Vert','∂':'\\partial',
  '∇':'\\nabla','{':'\\{','}':'\\}','%':'\\%','&':'\\&','#':'\\#',
  '_':'\\_','$':'\\$','\\':'\\backslash',
};
const median = (values: number[]) => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)] ?? 10;
const right = (a: MathItem) => a.x + a.w;
const center = (a: MathItem) => a.x + a.w / 2;
const isAccent = (a: MathItem) => ACCENT.test(a.str.trim());
const fullBody = (a: Atom, size: number) => a.h >= size * .86 && !isAccent(a) && !EXTENSION.test(a.font);

function encoded(text: string, font: string, warnings: string[]): string {
  // Computer Modern's symbol font maps Latin capitals to its calligraphic alphabet.
  if (/CMSY\d|LMSymbols/.test(font) && /^[A-Z]+$/.test(text)) return `\\mathcal{${text}}`;
  if (/^(and|or|if|otherwise)$/i.test(text)) return `\\text{ ${text} }`;
  if (/^(sin|cos|tan|exp|log|ln|lim|max|min|det|mod)$/.test(text)) return `\\operatorname{${text}}`;
  if (/CMR|LMRoman/.test(font) && /^[A-Za-z][A-Za-z0-9]+$/.test(text)) return `\\mathrm{${text}}`;
  return Array.from(text).map(c => {
    if (SYMBOLS[c]) return SYMBOLS[c] + (/^\\[A-Za-z]+$/.test(SYMBOLS[c]) ? ' ' : '');
    if (/^[A-Za-z0-9=+*/(),.\[\]<>!:;|'-]$/.test(c)) return c;
    if (/\s/.test(c)) return ' ';
    warnings.push(`无法恢复字形 ${c}`);
    return '';
  }).join('').trim();
}

/** Keep roman words together, but expose math glyphs so scripts/accents attach to one symbol. */
function atomsOf(items: MathItem[], warnings: string[]): Atom[] {
  const widths = new Map<string, number>();
  for (const it of items) if (Array.from(it.str).length === 1 && it.w > 0) widths.set(`${it.font}:${it.str}`, it.w / it.h);
  return items.filter(it => it.str.trim()).flatMap(it => {
    if (isAccent(it) || EXTENSION.test(it.font)) return [{ ...it, str: it.str.trim(), latex: '' }];
    const tokens = /CMMI|LMMath|MathJax_Math/.test(it.font)
      ? Array.from(it.str)
      : (it.str.match(/[A-Za-z][A-Za-z0-9]*|\d+|[^\s]|\s+/g) ?? []);
    const weights = tokens.map(t => Array.from(t).reduce((n,c)=>n+(widths.get(`${it.font}:${c}`) ?? (/\s/.test(c) ? .3 : .5)),0));
    const total = weights.reduce((a,b)=>a+b,0) || 1;
    let x = it.x;
    return tokens.flatMap((str,i) => {
      const w = it.w * weights[i] / total;
      const atom = { ...it, str, x, w, latex: ACCENT.test(str) ? '' : encoded(str, it.font, warnings) };
      x += w;
      return str.trim() ? [atom] : [];
    });
  });
}

function groupedBaselines(atoms: Atom[], tolerance: number): number[] {
  const rows: Array<{y:number; count:number}> = [];
  for (const a of [...atoms].sort((a,b)=>a.y-b.y)) {
    const row = rows.find(r=>Math.abs(r.y-a.y)<=tolerance);
    if (row) { row.y=(row.y*row.count+a.y)/(row.count+1);row.count++; }
    else rows.push({y:a.y,count:1});
  }
  return rows.map(r=>r.y);
}

function lineLatex(input: Atom[], baseline: number, size: number, warnings: string[]): string {
  if (!input.length) return '';
  const atoms = input.map(a=>({...a}));
  const accents = atoms.filter(isAccent);
  const ordinary = atoms.filter(a=>!isAccent(a));
  // Attach nested accents from the glyph outward: dot below hat => hat(dot(f)).
  const accentOwners = new Map<Atom, Atom[]>();
  for (const accent of accents) {
    const candidates = ordinary.filter(a=>!a.composite && /[A-Za-zα-ω]/.test(a.str) && a.y >= accent.y-.2 && a.y-accent.y < Math.max(size, a.h)*.9 &&
      accent.x >= a.x-size*.15 && accent.x <= right(a)+size*.55);
    const owner = candidates.sort((a,b)=>Math.abs(center(a)-accent.x)-Math.abs(center(b)-accent.x))[0];
    if (accent.str === '̸') {
      const relation = ordinary.filter(a=>/[=<>]/.test(a.str) && Math.abs(a.x-accent.x)<size*.3 && Math.abs(a.y-accent.y)<size*.3)[0];
      if (relation) { relation.latex=`\\not ${relation.latex}`;continue; }
    }
    if (!owner) { warnings.push('重音符号缺少可定位的基字');continue; }
    const list = accentOwners.get(owner) ?? [];list.push(accent);accentOwners.set(owner,list);
  }
  for (const [owner, decorations] of accentOwners) {
    for (const accent of decorations.sort((a,b)=>b.y-a.y)) {
      const command = accent.str==='˙' ? 'dot' : accent.str==='¯' ? 'bar' : 'hat';
      owner.latex=`\\${command}{${owner.latex}}`;
    }
  }
  const roots = ordinary.filter(a=>a.composite || (a.h >= size*.86 && Math.abs(a.y-baseline) <= size*.28));
  const attached = new Map<Atom,{sub:Atom[];sup:Atom[]}>();
  for (const atom of ordinary.filter(a=>!roots.includes(a))) {
    const candidates=roots.filter(root=>root.x <= atom.x+size*.15 && right(root)<=atom.x+size*.5);
    const owner=candidates.sort((a,b)=>Math.abs(atom.x-right(a))-Math.abs(atom.x-right(b)))[0];
    if (!owner || Math.abs(atom.y-baseline)<size*.04 || atom.x-right(owner)>size*2.7) {
      warnings.push(`未定位的上下标 ${atom.str}`);continue;
    }
    const scripts=attached.get(owner)??{sub:[],sup:[]};
    scripts[atom.y>baseline?'sub':'sup'].push(atom);attached.set(owner,scripts);
  }
  const output=roots.sort((a,b)=>a.x-b.x).map(root=>{
    let latex=root.latex;
    const scripts=attached.get(root);
    for(const key of ['sub','sup'] as const){
      const group=scripts?.[key];if(!group?.length)continue;
      const scriptSize=Math.max(...group.map(a=>a.h));
      const main=group.filter(a=>a.h>=scriptSize*.86&&!isAccent(a));
      const scriptY=median(main.map(a=>a.y));
      latex+=`${key==='sub'?'_':'^'}{${lineLatex(group,scriptY,scriptSize,warnings)}}`;
    }
    return latex;
  });
  // TeX command boundaries must remain separated from adjacent alphabetic symbols.
  return output.join(' ').replace(/\.\s*\.\s*\./g,'\\ldots').replace(/\s+/g,' ').trim();
}

function makeOperators(input: Atom[], body: number, warnings: string[]): Atom[] {
  const atoms=[...input], removed=new Set<Atom>();
  const roots=atoms.filter(a=>fullBody(a,body));
  const baselines=groupedBaselines(roots,body*.25);
  const additions:Atom[]=[];
  for(const op of atoms.filter(a=>/^[∑∏∫]$/.test(a.str))){
    const y=roots.reduce((best,a)=>Math.abs(a.y-(op.y+body*.95))<Math.abs(best-(op.y+body*.95))?a.y:best,Infinity);
    if(!Number.isFinite(y)){warnings.push('大型运算符没有主基线');continue;}
    const limits=atoms.filter(a=>a!==op&&!removed.has(a)&&a.h<body*.86&&center(a)>=op.x-body*.55&&center(a)<=right(op)+body*.55&&Math.abs(a.y-y)<body*2.2&&
      Math.abs(baselines.reduce((best,b)=>Math.abs(b-a.y)<Math.abs(best-a.y)?b:best,baselines[0])-y)<body*.25);
    const upper=limits.filter(a=>a.y<y-body*.4),lower=limits.filter(a=>a.y>y+body*.4);
    let latex=SYMBOLS[op.str];
    for(const [list,mark] of [[lower,'_'],[upper,'^']] as const){
      if(!list.length)continue;
      const size=Math.max(...list.map(a=>a.h));
      const baseline=median(list.filter(a=>a.h>=size*.86).map(a=>a.y));
      latex+=`${mark}{${lineLatex(list,baseline,size,warnings)}}`;
      list.forEach(a=>removed.add(a));
    }
    removed.add(op);additions.push({...op,y,h:body,latex,composite:true});
  }
  return [...atoms.filter(a=>!removed.has(a)),...additions];
}

function makeFractions(input: Atom[], rules: FormulaRule[], body: number, warnings: string[]): Atom[] {
  let atoms=[...input];
  for(const rule of rules.filter(r=>r.y1-r.y0<1.6&&r.x1-r.x0>2).sort((a,b)=>(a.x1-a.x0)-(b.x1-b.x0))){
    const y=(rule.y0+rule.y1)/2;
    const inside=atoms.filter(a=>!EXTENSION.test(a.font)&&center(a)>=rule.x0-.6&&center(a)<=rule.x1+.6&&Math.abs(a.y-y)<body*1.8);
    const side=(upper:boolean)=>{
      const candidates=inside.filter(a=>upper?a.y<y-.5:a.y>y+.5);
      const main=candidates.filter(a=>fullBody(a,body)||a.composite);
      if(!main.length)return [];
      const baseline=upper?Math.max(...main.map(a=>a.y)):Math.min(...main.map(a=>a.y));
      // Neighbouring fractions may overlap in x; only the nearest numerator/denominator
      // baseline belongs to this rule. Scripts remain attached to that baseline.
      return candidates.filter(a=>Math.abs(a.y-baseline)<body*.65);
    };
    const above=side(true),below=side(false);
    if(!above.length||!below.length)continue;
    const child=(list:Atom[])=>{
      const size=Math.max(...list.filter(a=>!isAccent(a)).map(a=>a.h));
      const baseline=median(list.filter(a=>a.h>=size*.86&&!isAccent(a)).map(a=>a.y));
      return lineLatex(list,baseline,size,warnings);
    };
    const latex=`\\frac{${child(above)}}{${child(below)}}`;
    const used=new Set([...above,...below]);atoms=atoms.filter(a=>!used.has(a));
    atoms.push({str:'fraction',font:'',x:rule.x0,y:y+body*.25,w:rule.x1-rule.x0,h:body,latex,composite:true});
  }
  return atoms;
}

function collapseBars(input: Atom[], body: number): Atom[] {
  const bars=input.filter(a=>EXTENSION.test(a.font)&&a.str==='∣');
  const rest=input.filter(a=>!bars.includes(a));
  const groups:Atom[][]=[];
  for(const bar of bars){
    const group=groups.find(g=>Math.abs(g[0].x-bar.x)<.3);
    if(group)group.push(bar);else groups.push([bar]);
  }
  const bases=groupedBaselines(rest.filter(a=>fullBody(a,body)||a.composite),body*.25);
  for(const group of groups){
    const expected=median(group.map(a=>a.y))+body*.55;
    const y=bases.reduce((best,b)=>Math.abs(b-expected)<Math.abs(best-expected)?b:best,bases[0]??expected);
    rest.push({...group[0],str:'|',latex:'\\vert',y,h:body,composite:true});
  }
  for(const y of groupedBaselines(rest.filter(a=>a.str==='|'&&a.composite),body*.25)){
    const pair=rest.filter(a=>a.str==='|'&&a.composite&&Math.abs(a.y-y)<body*.25).sort((a,b)=>a.x-b.x);
    if(pair.length===2){pair[0].latex='\\left\\vert';pair[1].latex='\\right\\vert';}
  }
  return rest;
}

function lines(input: Atom[], body: number, warnings: string[]): {atoms:Atom[];y:number}[] {
  const roots=input.filter(a=>fullBody(a,body)||a.composite);
  const bases=groupedBaselines(roots,body*.25);
  if(!bases.length){warnings.push('公式缺少主基线');return [];}
  return bases.map(y=>({y,atoms:input.filter(a=>{
    const expected=EXTENSION.test(a.font)&&!isAccent(a)&&!a.composite?a.y+body*1.4:a.y;
    const nearby=bases.filter(b=>{
      const row=roots.filter(root=>Math.abs(root.y-b)<body*.25);
      return center(a)>=Math.min(...row.map(root=>root.x))-body*1.5&&center(a)<=Math.max(...row.map(right))+body*1.5;
    });
    const candidates=nearby.length?nearby:bases;
    return candidates.reduce((best,b)=>Math.abs(b-expected)<Math.abs(best-expected)?b:best,candidates[0])===y;
  })}));
}

function regular(input: Atom[], rules: FormulaRule[], body: number, warnings: string[]): string {
  let atoms=makeOperators(input,body,warnings);
  atoms=makeFractions(atoms,rules,body,warnings);
  atoms=collapseBars(atoms,body);
  const rows=lines(atoms,body,warnings);
  const mainEquation=(row:{atoms:Atom[];y:number})=>row.atoms.find(a=>a.str==='='&&Math.abs(a.y-row.y)<body*.25);
  const leadingLhs=rows.length>1&&!mainEquation(rows[0])&&rows.slice(1).some(row=>{
    const equation=mainEquation(row);
    return equation&&!row.atoms.some(a=>!isAccent(a)&&a.x<equation.x);
  });
  const output=rows.map(row=>{
    for(const atom of row.atoms.filter(a=>EXTENSION.test(a.font)&&!a.composite&&!isAccent(a))){
      if(!/^[⌈⌉⌊⌋()[\]{}∣]$/.test(atom.str)){warnings.push(`不支持的伸缩字形 ${atom.str}`);continue;}
      atom.latex=encoded(atom.str,atom.font,warnings);
      if(/^[([{}\])]$/.test(atom.str))atom.latex=(/^[(\[{]$/.test(atom.str)?'\\left':'\\right')+atom.latex;
      atom.y=row.y;
    }
    // An isolated LHS followed by “= ...” is a single left-aligned expression;
    // it must not span the opposing columns of an aligned equation pair.
    if(leadingLhs)return `& ${lineLatex(row.atoms,row.y,body,warnings)}`;
    const eq=mainEquation(row);
    if(rows.length>1&&eq){
      const left=row.atoms.filter(a=>a.x<eq.x),right=row.atoms.filter(a=>a.x>=eq.x);
      return `${lineLatex(left,row.y,body,warnings)} &= ${lineLatex(right.filter(a=>a!==eq),row.y,body,warnings)}`;
    }
    const plain=lineLatex(row.atoms,row.y,body,warnings);
    return rows.length>1&&rows[0].atoms.some(a=>a.str==='=')?`&\\quad ${plain}`:plain;
  });
  return output.length>1?`\\begin{aligned}${output.join(' \\\\ ')}\\end{aligned}`:output[0]??'';
}

/** Restore only observable PDF geometry; unsupported or unowned glyphs suppress the candidate. */
export function restoreFormula(items: MathItem[], drawings: FormulaRule[] = [], bodySize?: number): FormulaStructure {
  const warnings:string[]=[];
  // The region detector removes the actual equation-number anchor by identity.
  // A literal “(0)” or “(1)” inside an expression is meaningful input.
  const meaningful=items.filter(a=>a.str.trim());
  if(!meaningful.length)return {warnings:['没有原生公式字形']};
  const body=bodySize ?? Math.max(...meaningful.filter(a=>!isAccent(a)&&!EXTENSION.test(a.font)).map(a=>a.h));
  let atoms=atomsOf(meaningful,warnings);
  const leftBraces=atoms.filter(a=>EXTENSION.test(a.font)&&LEFT_BRACE.test(a.str));
  let latex:string;
  if(leftBraces.length&&!atoms.some(a=>EXTENSION.test(a.font)&&a.str==='}')){
    const braceX=Math.min(...leftBraces.map(a=>a.x));
    const prefix=atoms.filter(a=>right(a)<=braceX+.2&&!leftBraces.includes(a));
    const content=atoms.filter(a=>!prefix.includes(a)&&!leftBraces.includes(a));
    const branchAtoms=makeOperators(content,body,warnings);
    const branches=lines(branchAtoms,body,warnings);
    if(branches.length<2)warnings.push('分段大括号缺少多行分支');
    const rendered=branches.map(row=>{
      const sorted=row.atoms.filter(a=>a.h>=body*.86||a.composite).sort((a,b)=>a.x-b.x);
      let depth=0;
      const comma=sorted.find(a=>{if(/[([]/.test(a.str))depth++;if(/[)\]]/.test(a.str))depth--;return a.str===','&&depth===0;});
      if(!comma){warnings.push('分段条件缺少明确分隔');return '';}
      return `\\displaystyle ${lineLatex(row.atoms.filter(a=>a.x<=comma.x),row.y,body,warnings)} & ${lineLatex(row.atoms.filter(a=>a.x>comma.x),row.y,body,warnings)}`;
    });
    latex=`${regular(prefix,[],body,warnings)} \\begin{cases}${rendered.join(' \\\\ ')}\\end{cases}`;
  }else latex=regular(atoms,drawings,body,warnings);
  const unique=[...new Set(warnings)];
  return {latex:unique.length?undefined:latex,warnings:unique};
}
