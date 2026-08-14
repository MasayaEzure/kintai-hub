// 監査ログ(MVP_SPEC.md F3): いつ・何を送ったかを append-only の JSONL で残す。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const AUDIT_PATH = path.join(DATA_DIR, 'audit.log');

export function audit(action, payload = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), action, ...payload });
  fs.appendFileSync(AUDIT_PATH, line + '\n');
}
