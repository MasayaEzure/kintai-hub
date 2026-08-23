// 勤怠ハブ サーバー(MVP_SPEC.md §2, §6, §7)
// - 127.0.0.1 のみに bind
// - 起動時生成の乱数トークンを UI に埋め込み、全変更系 API でカスタムヘッダ必須
// - Origin / Host 検証
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { loadConfig, ROOT } from './config.mjs';
import { Store, ValidationError } from './store.mjs';
import { JobRunner } from './jobs.mjs';
import { LoginFlow } from './login.mjs';
import { defaultTargetMonth } from './plan.mjs';
import { audit } from './audit.mjs';
import { startLevtechImport, startTypeformRetry } from './flows.mjs';
import { parseXls } from './excel.mjs';

const config = loadConfig();
const store = new Store();
const runner = new JobRunner();
const login = new LoginFlow(config, runner);
const TOKEN = randomBytes(24).toString('hex');
const PORT = config.port ?? 5678;

const app = express();
app.use(express.json());

// ---- セキュリティ層(§7)----
const ALLOWED_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const ALLOWED_ORIGINS = ALLOWED_HOSTS.map((h) => `http://${h}`);
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.includes(req.headers.host ?? '')) {
    return res.status(403).json({ error: 'Host ヘッダが不正です' });
  }
  if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    return res.status(403).json({ error: 'Origin が不正です' });
  }
  if (req.method !== 'GET' && req.path.startsWith('/api/') && req.headers['x-kintai-token'] !== TOKEN) {
    return res.status(403).json({ error: 'トークンが不正です' });
  }
  next();
});

// ---- UI 配信(index.html にトークンを埋め込む)----
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace('__KINTAI_TOKEN__', TOKEN));
});
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message, code: err.code ?? null });
  }
};

// ---- 状態 ----
app.get('/api/state', wrap(async (req, res) => {
  res.json({
    workHours: config.workHours,
    defaultMonth: defaultTargetMonth(),
    problems: config.problems,
    exceptions: store.list(),
    levtechRuns: store.levtechRuns(),
    job: runner.current(),
    login: login.status(),
  });
}));

// ---- 送信済み台帳 ----
// 未送信(none / failed)レコードの取り消し(論理削除)。
// Typeform を手動で取り消し連絡した後の台帳整理にも使う
app.post('/api/exceptions/:id/cancel-direct', wrap(async (req, res) => {
  const rec = store.cancelDirect(req.params.id);
  audit('exception.cancel-direct', { recordId: rec.id });
  res.json(rec);
}));

// Typeform のみ再実行: failed / none からは通常導線(§3-3)
app.post('/api/exceptions/:id/retry-typeform', wrap(async (req, res) => {
  const rec = store.get(req.params.id);
  if (rec.cancelled) throw new ValidationError('取り消し済みレコードは送信できません');
  // none も許可(P1-2): 質問文言変更などクリック前の失敗では submitting へ遷移する前に終わり、
  // 未送信のまま none で残る。none は未送信確定なので二重送信リスクはない
  if (!['none', 'failed'].includes(rec.statuses.typeform)) {
    throw new ValidationError(`送信できるのは未送信(none)または失敗(failed)のみです(現在: ${rec.statuses.typeform})。unknown は到達確認の導線から操作してください`);
  }
  const job = startTypeformRetry(runner, store, config, rec);
  res.json({ job });
}));

// unknown の解決(§3-3): 到達を目視確認した場合のみ、手動確定 or 再送信
app.post('/api/exceptions/:id/resolve-unknown', wrap(async (req, res) => {
  const { action, verified } = req.body; // action: 'confirm-submitted' | 'resubmit'
  if (!verified) {
    throw new ValidationError('メール通知等で申請の到達(または未到達)を目視確認した旨のチェックが必要です');
  }
  const rec = store.get(req.params.id);
  if (rec.statuses.typeform !== 'unknown') {
    throw new ValidationError(`unknown 状態ではありません(現在: ${rec.statuses.typeform})`);
  }

  if (action === 'confirm-submitted') {
    store.transitionTypeform(rec.id, 'submitted');
    audit('typeform.manual-confirm', { recordId: rec.id });
    res.json({ record: store.get(rec.id) });
  } else if (action === 'resubmit') {
    audit('typeform.verified-resubmit', { recordId: rec.id });
    const job = startTypeformRetry(runner, store, config, rec);
    res.json({ job });
  } else {
    throw new ValidationError(`action が不正です: ${action}`);
  }
}));

// ---- フロー①: 月末一括(勤怠入力+Typeform申請) ----
// Excel取込: 作業実績表(.xls)を raw ボディで受け取り、同期パース(失敗は 400)→
// 取込ジョブを開始する。年月はファイル(D2/F2)から自動判定。manualUrl はクエリで受ける
app.post('/api/levtech/import', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
  if (runner.isBusy()) {
    throw Object.assign(new Error('別のジョブが実行中です。完了後にやり直してください'), { status: 409 });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw Object.assign(new Error('ファイルの内容が空です。作業実績表(.xls)を指定してください'), { status: 400 });
  }
  const parsed = parseXls(req.body, config.workHours); // ExcelParseError は status=400 を持つ
  const manualUrl = typeof req.query.manualUrl === 'string' && req.query.manualUrl.trim() ? req.query.manualUrl.trim() : null;
  const job = startLevtechImport(runner, store, config, { parsed, buffer: req.body, manualUrl });
  res.json({ job, month: parsed.month });
}));

// ---- ジョブ ----
app.get('/api/jobs/:id', wrap(async (req, res) => {
  res.json(runner.get(req.params.id));
}));

app.post('/api/jobs/:id/confirm', wrap(async (req, res) => {
  runner.confirm(req.params.id, { approve: !!req.body.approve, data: req.body.data });
  res.json(runner.get(req.params.id));
}));

// ---- ログイン導線 ----
app.post('/api/login/start', wrap(async (req, res) => {
  res.json(login.start());
}));
app.get('/api/login/status', wrap(async (req, res) => {
  res.json(login.status());
}));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`勤怠ハブ: http://127.0.0.1:${PORT}/`);
  if (config.problems.length > 0) {
    console.warn('設定の警告:');
    for (const p of config.problems) console.warn(`  - ${p}`);
  }
});
