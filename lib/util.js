// 通用小工具：跨模块复用，避免各处重复实现（查重纪律）。
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 文件名净化：去掉路径分隔符与 Windows 非法字符，防止把收件箱写成任意路径。 */
export function safeFileName(name, fallback = 'file') {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}
