import type { PDFPageProxy } from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
/** All rectangles use the scale-1 PDF viewport, including rotation and CropBox. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageRegion extends Rect {
  kind: 'figure' | 'table';
  parts: number;
  rules: {
    h: number;
    v: number;
  };
}

export interface Drawing extends Rect {
  kind: 'image' | 'path';
  horizontal: boolean;
  vertical: boolean;
}

export type Matrix = [number, number, number, number, number, number];
export function multiplyMatrices(m: number[], n: number[]): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function transformRect(m: number[], x0: number, y0: number, x1: number, y1: number): Rect {
  const points = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  return {
    x0: Math.min(...points.map(p => p[0])),
    y0: Math.min(...points.map(p => p[1])),
    x1: Math.max(...points.map(p => p[0])),
    y1: Math.max(...points.map(p => p[1]))
  };
}

export function unionRects(rects: Rect[]): Rect {
  return {
    x0: Math.min(...rects.map(r => r.x0)),
    y0: Math.min(...rects.map(r => r.y0)),
    x1: Math.max(...rects.map(r => r.x1)),
    y1: Math.max(...rects.map(r => r.y1))
  };
}

function intersection(a: Rect, b: Rect): Rect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 >= r.x0 && r.y1 >= r.y0 ? r : null;
}
async function collectDrawings(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 1 });
  const { fnArray, argsArray } = await page.getOperatorList();
  let matrix = [...viewport.transform] as Matrix;
  let lineWidth = 1;
  let clip: Rect = { x0: 0, y0: 0, x1: viewport.width, y1: viewport.height };
  const stack: Array<{
    matrix: Matrix;
    lineWidth: number;
    clip: Rect;
  }> = [];
  let path: Rect | null = null;
  let pendingClip = false;
  const drawings: Drawing[] = [];
  const fontNames = new Map<string, string>();
  const save = () => stack.push({ matrix: [...matrix], lineWidth, clip: { ...clip } });
  const restore = () => {
    const state = stack.pop();
    if (state) {
      matrix = state.matrix;
      lineWidth = state.lineWidth;
      clip = state.clip;
    }
  };
  const add = (bounds: Rect, kind: 'image' | 'path', stroke = false) => {
    const horizontal = bounds.y1 - bounds.y0 < 2 && bounds.x1 - bounds.x0 > 30;
    const vertical = bounds.x1 - bounds.x0 < 2 && bounds.y1 - bounds.y0 > 30;
    const pad = stroke ? Math.max(0.15, lineWidth * Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3])) / 2) : 0;
    const box = intersection({ x0: bounds.x0 - pad, y0: bounds.y0 - pad, x1: bounds.x1 + pad, y1: bounds.y1 + pad }, clip);
    if (box && (box.x1 - box.x0 > 0.2 || box.y1 - box.y0 > 0.2))
      drawings.push({ ...box, kind, horizontal, vertical });
  };
  const paints = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokes = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save)
      save();
    else if (fn === OPS.restore)
      restore();
    else if (fn === OPS.transform)
      matrix = multiplyMatrices(matrix, args);
    else if (fn === OPS.setLineWidth)
      lineWidth = Number(args[0]);
    else if (fn === OPS.setFont) {
      const id = String(args[0]);
      if (!fontNames.has(id)) {
        // getOperatorList resolves font dependencies before returning.
        if (page.commonObjs.has(id))
          fontNames.set(id, String(page.commonObjs.get(id)?.name ?? ''));
      }
    }
    else if (fn === OPS.paintFormXObjectBegin) {
      save();
      if (args[0])
        matrix = multiplyMatrices(matrix, args[0]);
      if (args[1])
        clip = intersection(clip, transformRect(matrix, ...args[1] as [number, number, number, number])) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    }
    else if (fn === OPS.paintFormXObjectEnd)
      restore();
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject)
      add(transformRect(matrix, 0, 0, 1, 1), 'image');
    else if (fn === OPS.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = args;
      for (let j = 0; j < positions.length; j += 2)
        add(transformRect(multiplyMatrices(matrix, [sx, 0, 0, sy, positions[j], positions[j + 1]]), 0, 0, 1, 1), 'image');
    }
    else if (fn === OPS.paintInlineImageXObjectGroup) {
      for (const entry of args[1])
        add(transformRect(multiplyMatrices(matrix, entry.transform), 0, 0, 1, 1), 'image');
    }
    else if (fn === OPS.paintImageMaskXObjectGroup) {
      for (const entry of args[0])
        add(transformRect(multiplyMatrices(matrix, entry.transform), 0, 0, 1, 1), 'image');
    }
    else if (fn === OPS.constructPath) {
      const mm = args[2];
      if (mm?.length >= 4) {
        const box = transformRect(matrix, mm[0], mm[1], mm[2], mm[3]);
        path = path ? unionRects([path, box]) : box;
      }
    }
    else if (fn === OPS.clip || fn === OPS.eoClip)
      pendingClip = true;
    else if (paints.has(fn) || fn === OPS.endPath) {
      if (path && paints.has(fn))
        add(path, 'path', strokes.has(fn));
      if (path && pendingClip)
        clip = intersection(clip, path) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      path = null;
      pendingClip = false;
    }
  }
  return { viewport, drawings, fontNames };
}

function cluster(drawings: Drawing[], pageW: number, pageH: number): PageRegion[] {
  const gap = Math.max(4, pageW * 0.012);
  const parent = drawings.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const cells = new Map<string, number[]>();
  const keys = (r: Rect, pad = 0) => {
    const out: string[] = [];
    for (let x = Math.floor((r.x0 - pad) / gap); x <= Math.floor((r.x1 + pad) / gap); x++)
      for (let y = Math.floor((r.y0 - pad) / gap); y <= Math.floor((r.y1 + pad) / gap); y++)
        out.push(`${x}:${y}`);
    return out;
  };
  drawings.forEach((r, i) => {
    const seen = new Set<number>();
    for (const key of keys(r, gap))
      for (const j of cells.get(key) ?? []) {
        if (seen.has(j))
          continue;
        seen.add(j);
        const q = drawings[j];
        if (Math.max(r.x0 - q.x1, q.x0 - r.x1, 0) <= gap && Math.max(r.y0 - q.y1, q.y0 - r.y1, 0) <= gap)
          parent[find(i)] = find(j);
      }
    for (const key of keys(r)) {
      const cell = cells.get(key) ?? [];
      cell.push(i);
      cells.set(key, cell);
    }
  });
  const groups = new Map<number, Drawing[]>();
  drawings.forEach((r, i) => {
    const key = find(i);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  });
  return [...groups.values()].map(parts => {
    const box = unionRects(parts), h = parts.filter(r => r.horizontal).length, v = parts.filter(r => r.vertical).length;
    return { ...box, kind: 'figure' as const, parts: parts.length, rules: { h, v } };
  }).filter(r => r.x1 - r.x0 >= 30 && r.y1 - r.y0 >= 24 && (r.x1 - r.x0) * (r.y1 - r.y0) >= 1800 && !(r.x1 - r.x0 > pageW * .96 && r.y1 - r.y0 > pageH * .9));
}

export async function extractPageRegions(page: PDFPageProxy): Promise<{
  regions: PageRegion[];
  drawings: Drawing[];
  sawInk: boolean;
  fontNames: Map<string, string>;
}> {
  const { viewport, drawings, fontNames } = await collectDrawings(page);
  // Retain thin rules separately: table reconstruction needs the top, middle and bottom rules.
  const visible = drawings.filter(r => r.kind === 'image' ||
    !(r.x1 - r.x0 > viewport.width * .96 && r.y1 - r.y0 > viewport.height * .9));
  return {
    regions: cluster(visible, viewport.width, viewport.height),
    drawings: visible,
    sawInk: visible.length > 0,
    fontNames
  };
}
