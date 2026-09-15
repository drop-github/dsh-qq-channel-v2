// QQ Markdown 适配与分块（P2-1 / P2-4）。
// 分块**按码点**切（`Array.from`）：按 UTF-16 码元切会把 emoji / 代理对劈成乱码。
export const MAX_CONTENT_CHARS = 4000;

/** 转 QQ 可渲染的 markdown：代码块降级为引用、表格降级为引用行、标题最多 3 级。 */
export function toQQMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let prevWasText = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(`> ${line}`);
      prevWasText = true;
      continue;
    }
    if (line.includes('|') && !/^\s*>\s?/.test(line) && line.trim() !== '') {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      out.push(`> ${cells.join(' | ')}`);
      prevWasText = true;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(`${'#'.repeat(Math.min(3, heading[1].length))} ${heading[2].trim()}`);
      prevWasText = true;
      continue;
    }
    if (/^\s*(\*\*\*+|---+)\s*$/.test(line)) {
      out.push('***');
      prevWasText = false;
      continue;
    }
    const listItem = line.match(/^([-*+]|\d+\.)\s+(.*)$/);
    if (listItem) {
      if (prevWasText) out.push('');
      out.push(line);
      prevWasText = false;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push(line.trim());
      prevWasText = true;
      continue;
    }
    out.push(line.replace(/`([^`]+)`/g, '$1'));
    prevWasText = line.trim() !== '';
  }
  const compact = [];
  for (const line of out) {
    if (line === '' && compact[compact.length - 1] === '') continue;
    compact.push(line);
  }
  return compact.map((line) => (line === '' ? '\u200B' : line)).join('\n').trim();
}

/**
 * 按码点分块。**先算总块数再 slice**（P2-1：先 slice 会让"截断提示"永远是死代码）。
 * 返回 `{chunks, total, truncated}`。
 */
export function chunkByCodePoints(text, max, maxChunks) {
  const points = Array.from(String(text ?? ''));
  const size = Math.max(1, Math.floor(max) || 1);
  const total = points.length === 0 ? 0 : Math.ceil(points.length / size);
  const keep = Math.max(1, Math.floor(maxChunks) || 1);
  const chunks = [];
  for (let index = 0; index < Math.min(total, keep); index += 1) {
    chunks.push(points.slice(index * size, (index + 1) * size).join(''));
  }
  return { chunks, total, truncated: total > keep };
}
