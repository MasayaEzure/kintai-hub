// ジョブ実行モデル(MVP_SPEC.md §6): グローバル直列・同時1件。
// 実行中の新規投入は 409。ジョブは「確認待ち(awaiting_confirmation)」で中断でき、
// UI からの承認/中止で再開する(レバテック保存前プレビューに使う)。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCREENSHOT_DIR } from './config.mjs';

const CONFIRM_TIMEOUT_MS = 15 * 60 * 1000; // 確認待ちで放置されたら中止する

export class JobAbortedError extends Error {
  constructor(message = 'ジョブは中止されました') {
    super(message);
    this.aborted = true;
  }
}

export class JobRunner {
  constructor() {
    this.job = null; // 直近ジョブ(実行中 or 完了済み)
    this.history = [];
  }

  isBusy() {
    return !!this.job && ['running', 'awaiting_confirmation'].includes(this.job.state);
  }

  // runFn(ctx) を直ちに開始する。ctx: { log, screenshot, waitConfirmation, jobId }
  start(type, meta, runFn) {
    if (this.isBusy()) {
      throw Object.assign(new Error(`別のジョブ(${this.job.type})が実行中です`), { status: 409 });
    }
    const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
    const screenshotDir = path.join(SCREENSHOT_DIR, id); // jobId ごとに分離、上書きしない(F3)
    const job = {
      id,
      type,
      meta,
      state: 'running',
      log: [],
      preview: null, // 確認待ち時にUIへ見せる内容
      result: null,
      error: null,
      errorCode: null,
      screenshots: [],
      startedAt: new Date().toISOString(),
      endedAt: null,
      _confirm: null, // { resolve, reject, timer }
    };
    this.job = job;

    const ctx = {
      jobId: id,
      log: (msg) => {
        job.log.push({ at: new Date().toISOString(), msg });
        console.log(`[job ${id}] ${msg}`);
      },
      screenshot: async (page, name) => {
        fs.mkdirSync(screenshotDir, { recursive: true });
        const p = path.join(screenshotDir, `${name}.png`);
        await page.screenshot({ path: p, fullPage: true });
        job.screenshots.push(p);
        return p;
      },
      // プレビューを提示して承認を待つ。戻り値は confirm() に渡された data
      waitConfirmation: (preview) =>
        new Promise((resolve, reject) => {
          job.state = 'awaiting_confirmation';
          job.preview = preview;
          const timer = setTimeout(() => {
            job._confirm = null;
            reject(new JobAbortedError('確認待ちがタイムアウトしました(15分)。何も保存していません'));
          }, CONFIRM_TIMEOUT_MS);
          job._confirm = {
            resolve: (data) => {
              clearTimeout(timer);
              job._confirm = null;
              job.state = 'running';
              resolve(data);
            },
            reject: (err) => {
              clearTimeout(timer);
              job._confirm = null;
              reject(err);
            },
          };
        }),
    };

    (async () => {
      try {
        job.result = await runFn(ctx);
        job.state = 'succeeded';
      } catch (err) {
        job.state = err instanceof JobAbortedError ? 'cancelled' : 'failed';
        job.error = err.message;
        job.errorCode = err.code ?? null;
        if (job.state === 'failed') console.error(`[job ${id}] 失敗:`, err);
      } finally {
        job.endedAt = new Date().toISOString();
        this.history.unshift(this.publicView(job));
        this.history = this.history.slice(0, 20);
      }
    })();

    return this.publicView(job);
  }

  confirm(jobId, { approve, data }) {
    const job = this.job;
    if (!job || job.id !== jobId) {
      throw Object.assign(new Error('対象のジョブが見つかりません'), { status: 404 });
    }
    if (job.state !== 'awaiting_confirmation' || !job._confirm) {
      throw Object.assign(new Error('このジョブは確認待ちではありません'), { status: 409 });
    }
    if (approve) job._confirm.resolve(data ?? {});
    else job._confirm.reject(new JobAbortedError('ユーザーが中止しました。何も保存していません'));
  }

  get(jobId) {
    if (this.job?.id === jobId) return this.publicView(this.job);
    const past = this.history.find((j) => j.id === jobId);
    if (!past) throw Object.assign(new Error('ジョブが見つかりません'), { status: 404 });
    return past;
  }

  current() {
    return this.job ? this.publicView(this.job) : null;
  }

  publicView(job) {
    const { _confirm, ...view } = job;
    return JSON.parse(JSON.stringify(view));
  }
}
