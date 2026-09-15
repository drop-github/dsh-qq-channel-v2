// 运行版本标签：package.json 的 version +（link/git 安装时）git commit 前 7 位。
// 切回/回退自检要靠它确认"当前加载的到底是哪一份"（CUTOVER-PLAN.md §3）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function buildVersionTag() {
  let version = '?';
  try {
    version = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '?';
  } catch (err) {
    version = `?(${String(err?.code ?? err?.message ?? 'unreadable')})`;
  }
  let commit = '';
  try {
    const head = fs.readFileSync(path.join(PKG_DIR, '.git', 'HEAD'), 'utf8').trim();
    const match = /^ref: (.+)$/.exec(head);
    const sha = (match ? fs.readFileSync(path.join(PKG_DIR, '.git', match[1]), 'utf8') : head).trim();
    commit = sha.slice(0, 7);
  } catch (err) {
    commit = '';   // npm 包安装没有 .git，属正常
  }
  return `v${version}${commit ? `+${commit}` : ''}`;
}

export const VERSION_TAG = buildVersionTag();
