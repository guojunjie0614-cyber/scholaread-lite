import type { Block, Note } from '../shared/types.js';

/** Reparse may change block IDs and paragraph boundaries. Never reuse an offset merely because an ID matches. */
export function reanchorNotes(previous: Block[], next: Block[], notes: Note[]): Note[] {
  const old = new Map(previous.map((b) => [b.id, b]));
  return notes.filter((n) => n.blockId).map((note) => {
    const source = old.get(note.blockId!);
    const selected = source && note.startOffset != null && note.endOffset != null
      ? source.text.slice(note.startOffset, note.endOffset) : note.quote || source?.text;
    // A previously flattened algorithm is now an image: retain its note at the panel,
    // but drop character offsets because there is no rendered text to highlight.
    const panels = source?.bbox ? next.filter(b => b.kind === 'algorithm' && b.page === source.page && b.bbox &&
      source.bbox![0] >= b.bbox[0] - 2 && source.bbox![2] <= b.bbox[2] + 2 &&
      source.bbox![1] >= b.bbox[1] - 2 && source.bbox![3] <= b.bbox[3] + 2) : [];
    if (panels.length === 1) return { ...note, blockId: panels[0].id, startOffset: null, endOffset: null };
    const candidates = next.filter((b) => b.page === (note.page ?? source?.page) && !['math', 'figure', 'table', 'algorithm'].includes(b.kind));
    const exact = source && candidates.filter((b) => b.text === source.text);
    if (exact?.length === 1) return { ...note, blockId: exact[0].id };
    // Merging wrapped titles/author blocks retains the complete old text. Use that
    // larger context before a short quote such as "of", which can occur many times.
    if (source?.text) {
      const containers = candidates.flatMap(b => {
        const start = b.text.indexOf(source.text);
        if (start < 0) return [];
        return [{ b, start, repeated: b.text.indexOf(source.text, start + 1) >= 0 }];
      });
      if (containers.length === 1 && !containers[0].repeated) {
        const { b, start } = containers[0];
        return { ...note, blockId: b.id,
          startOffset: note.startOffset == null ? null : start + note.startOffset,
          endOffset: note.endOffset == null ? null : start + note.endOffset };
      }
    }
    if (selected) {
      const matches = candidates.flatMap((b) => {
        const occurrences: Array<{ b: Block; start: number }> = [];
        let start = b.text.indexOf(selected);
        while (start >= 0) {
          occurrences.push({ b, start });
          start = b.text.indexOf(selected, start + 1);
        }
        return occurrences;
      });
      if (matches.length === 1) {
        const { b, start } = matches[0];
        return { ...note, blockId: b.id,
          startOffset: note.startOffset == null ? null : start,
          endOffset: note.endOffset == null ? null : start + selected.length };
      }
    }
    // Keep quote/page/body; unresolved notes stay visible without highlighting unrelated text.
    return { ...note, blockId: null, startOffset: null, endOffset: null };
  });
}
