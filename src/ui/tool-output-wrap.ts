import stringWidth from 'string-width';
/** Wrap display text at grapheme boundaries; leave the stored record unchanged. */
export function wrapToolOutput(text: string, columns: number): string[] {
  if (!Number.isFinite(columns)) throw new Error('Invalid tool output width');
  const width = Math.max(2, Math.min(1000, Math.floor(columns))), segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const rows: string[] = [];
  for (const line of text.replace(/\t/g, '    ').split('\n')) {
    let row = '', used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const size = stringWidth(segment);
      if (used + size > width && row) { rows.push(row); row = ''; used = 0; }
      row += segment; used += size;
    }
    rows.push(row);
  }
  return rows;
}
