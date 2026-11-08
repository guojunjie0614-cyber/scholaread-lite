import type { Block } from './types';

/** Reject damaged parser output before replacing stored blocks and note anchors. */
export function assertReflowBlocks(blocks: Block[]): void {
  for (const block of blocks) {
    const fail = (reason: string): never => {
      throw new Error(`第 ${block.page} 页重排结果无效（${block.kind} ${block.eqNo || block.id}）：${reason}。已保留上一版内容，请查看原页。`);
    };
    for (const key of ['crop', 'recognitionCrop'] as const) {
      const box = block[key];
      if (box && (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]))
        fail(`${key} 裁剪区域为空或倒置`);
    }
    if (block.textRuns && block.textRuns.map(run => run.text).join('') !== block.text)
      fail('文字与选择范围不一致');
    const groups = new Set<string>();
    let previousGroup: string | undefined;
    for (const run of block.textRuns ?? []) {
      const position = run.mathPosition;
      if (position && (!position.group || ![position.x, position.y, position.width, position.size].every(Number.isFinite) ||
        position.width < 0 || position.size <= 0)) fail('行内公式位置无效');
      if (position && position.group !== previousGroup) {
        if (groups.has(position.group)) fail('同一行内公式被其他文字切断');
        groups.add(position.group);
      }
      previousGroup = position?.group;
    }
  }
}
