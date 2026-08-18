// 勤怠ハブ サーバー(MVP_SPEC.md §2, §6, §7)
// - 127.0.0.1 のみに bind
// - 起動時生成の乱数トークンを UI に埋め込み、全変更系 API でカスタムヘッダ必須
// - Origin / Host 検証
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { loadConfig, ROOT } from './config.mjs';
import { Store, ValidationError, REQUEST_KINDS } from './store.mjs';
import { JobRunner } from './jobs.mjs';
import { LoginFlow } from './login.mjs';
import { buildMonthPlan, defaultTargetMonth } from './plan.mjs';
import { audit } from './audit.mjs';
import { registerRecordToCalendar } from './adapters/calendar.mjs';
import { startLevtechFill, startLevtechImport, startRequestFlow, startTypeformRetry, startCancellationFlow } from './flows.mjs';
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

app.get('/api/plan', wrap(async (req, res) => {
  const month = req.query.month ?? defaultTargetMonth();
  const workHours = {
    start: req.query.start || config.workHours.start,
    end: req.query.end || config.workHours.end,
    rest: req.query.rest || config.workHours.rest,
  };
  res.json(buildMonthPlan(month, workHours, store));
}));

// ---- 例外日レコード ----
app.post('/api/exceptions', wrap(async (req, res) => {
  // フロー①からの追加は custom のみ。休暇等は要申請のためフロー②(/api/requests)へ
  if (req.body.kind !== 'custom') {
    throw new ValidationError('この API で追加できるのは custom(申請不要の時間変更)のみです');
  }
  const rec = store.create(req.body);
  audit('exception.create', { recordId: rec.id, kind: rec.kind, date: rec.date });
  res.json(rec);
}));

app.put('/api/exceptions/:id', wrap(async (req, res) => {
  const rec = store.update(req.params.id, req.body);
  audit('exception.update', { recordId: rec.id });
  res.json(rec);
}));

// どこにも反映されていないレコードの取り消し(取り消し申請なし・論理削除)
app.post('/api/exceptions/:id/cancel-direct', wrap(async (req, res) => {
  const rec = store.cancelDirect(req.params.id);
  audit('exception.cancel-direct', { recordId: rec.id });
  res.json(rec);
}));

// 申請済みレコードの取り消し(Typeform で取り消し申請を送る)
app.post('/api/exceptions/:id/cancel-request', wrap(async (req, res) => {
  const rec = store.get(req.params.id);
  if (rec.cancelled) throw new ValidationError('すでに取り消し済みです');
  if (rec.statuses.typeform !== 'submitted') {
    throw new ValidationError('取り消し申請の対象は申請済み(submitted)のレコードのみです');
  }
  const job = startCancellationFlow(runner, store, config, rec, req.body.detail);
  res.json({ job });
}));

app.post('/api/exceptions/:id/cleanup-done', wrap(async (req, res) => {
  res.json(store.setCalendarCleanupDone(req.params.id, req.body.done ?? true));
}));

// ---- フロー②: 申請・登録 ----
app.post('/api/requests', wrap(async (req, res) => {
  const { kind } = req.body;
  if (!REQUEST_KINDS.includes(kind)) {
    throw new ValidationError('申請できる種別は お休み・遅参・早帰り のみです');
  }
  if (runner.isBusy()) {
    throw Object.assign(new Error('別のジョブが実行中です。完了後にやり直してください'), { status: 409 });
  }
  const rec = store.create(req.body); // ここで矛盾バリデーション
  audit('exception.create', { recordId: rec.id, kind: rec.kind, date: rec.date });
  const job = startRequestFlow(runner, store, config, rec);
  res.json({ record: rec, job });
}));

// カレンダーのみ再実行(冪等・キュー外)
app.post('/api/exceptions/:id/retry-calendar', wrap(async (req, res) => {
  // キュー外だが、実行中ジョブ(request フロー等)のカレンダー登録・ストア更新と競合させない(P2-1)
  if (runner.isBusy()) {
    throw Object.assign(new Error('別のジョブが実行中です。完了後にやり直してください'), { status: 409 });
  }
  const rec = store.get(req.params.id);
  if (rec.cancelled) throw new ValidationError('取り消し済みレコードはカレンダー登録できません');
  const result = await registerRecordToCalendar(config, store, rec, () => {});
  res.json({ result, record: store.get(rec.id) });
}));

// Typeform のみ再実行: failed / none からは通常導線(§3-3)
app.post('/api/exceptions/:id/retry-typeform', wrap(async (req, res) => {
  const rec = store.get(req.params.id);
  if (rec.cancelled) throw new ValidationError('取り消し済みレコードは送信できません');
  const target = rec.cancellation && rec.cancellation.typeform !== 'none' ? 'cancellation' : 'request';
  const status = target === 'cancellation' ? rec.cancellation.typeform : rec.statuses.typeform;
  // none も許可(P1-2): 質問文言変更などクリック前の失敗では submitting へ遷移する前に終わり、
  // 未送信のまま none で残る。none は未送信確定なので二重送信リスクはない
  if (!['none', 'failed'].includes(status)) {
    throw new ValidationError(`送信できるのは未送信(none)または失敗(failed)のみです(現在: ${status})。unknown は到達確認の導線から操作してください`);
  }
  const job = startTypeformRetry(runner, store, config, rec, { target });
  res.json({ job });
}));

// unknown の解決(§3-3): 到達を目視確認した場合のみ、手動確定 or 再送信
app.post('/api/exceptions/:id/resolve-unknown', wrap(async (req, res) => {
  const { action, verified } = req.body; // action: 'confirm-submitted' | 'resubmit'
  if (!verified) {
    throw new ValidationError('メール通知等で申請の到達(または未到達)を目視確認した旨のチェックが必要です');
  }
  const rec = store.get(req.params.id);
  const target = rec.cancellation && rec.cancellation.typeform === 'unknown' ? 'cancellation' : 'request';
  const status = target === 'cancellation' ? rec.cancellation.typeform : rec.statuses.typeform;
  if (status !== 'unknown') throw new ValidationError(`unknown 状態ではありません(現在: ${status})`);

  if (action === 'confirm-submitted') {
    store.transitionTypeform(rec.id, 'submitted', { target });
    if (target === 'cancellation') store.markCancelled(rec.id);
    audit('typeform.manual-confirm', { recordId: rec.id, target });
    res.json({ record: store.get(rec.id) });
  } else if (action === 'resubmit') {
    audit('typeform.verified-resubmit', { recordId: rec.id, target });
    const job = startTypeformRetry(runner, store, config, rec, { target });
    res.json({ job });
  } else {
    throw new ValidationError(`action が不正です: ${action}`);
  }
}));

// ---- フロー①: 月末勤怠入力 ----
app.post('/api/levtech/run', wrap(async (req, res) => {
  const { month, workHours, manualUrl } = req.body;
  const wh = {
    start: workHours?.start || config.workHours.start,
    end: workHours?.end || config.workHours.end,
    rest: workHours?.rest || config.workHours.rest,
  };
  const job = startLevtechFill(runner, store, config, { month, workHours: wh, manualUrl: manualUrl || null });
  res.json({ job });
}));

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
