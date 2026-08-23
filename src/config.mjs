// 設定ローダ。config.json(Git 管理外)を読み込む。
// 初回起動時に config.json が無ければ config.example.json をベースに自動生成する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROFILE_DIR = path.join(ROOT, 'profile');
export const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'jobs');

const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const base = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2) + '\n');
    console.log(`config.json を新規作成しました: ${CONFIG_PATH}`);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const problems = [];
  if (!/^ENG\d+$/.test(config.typeform?.personalId ?? '')) {
    problems.push('typeform.personalId に本人特定 ID(ENG…)を設定してください');
  }
  config.problems = problems; // 起動は止めず、UI で警告表示する
  return config;
}
