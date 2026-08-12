// セッション切れ対応の導線(MVP_SPEC.md §6)。
// サーバーが素の Chrome を直接 spawn(--user-data-dir + --use-mock-keychain。
// open -a は既存 Chrome に引数を無視されるため使わない)→ ユーザーが手動ログイン
// → Chrome 完全終了を検知 → セッションチェックを自動再実行。
import { spawn } from 'node:child_process';
import { PROFILE_DIR } from './config.mjs';
import { withLevtech, assertSession, SessionExpiredError } from './adapters/levtech.mjs';

export class LoginFlow {
  constructor(config, runner) {
    this.config = config;
    this.runner = runner;
    this.state = { phase: 'idle', message: null, checkJobId: null }; // idle | chrome-running | checking-queued
  }

  start() {
    if (this.state.phase === 'chrome-running') {
      throw Object.assign(new Error('ログイン用 Chrome は起動済みです'), { status: 409 });
    }
    if (this.runner.isBusy()) {
      throw Object.assign(new Error('ジョブ実行中はログインを開始できません'), { status: 409 });
    }
    const proc = spawn(
      this.config.chromePath,
      [
        `--user-data-dir=${PROFILE_DIR}`,
        '--use-mock-keychain', // Playwright と Cookie 暗号鍵を揃える(PoC の知見)
        '--no-first-run',
        '--no-default-browser-check',
        this.config.levtech.topUrl,
      ],
      { stdio: 'ignore' }
    );
    this.state = {
      phase: 'chrome-running',
      message: 'Chrome でログインし、完了したら Chrome を完全終了(Cmd+Q)してください。終了を検知すると自動でセッションを再チェックします',
      checkJobId: null,
    };
    proc.on('exit', () => {
      if (this.state.phase !== 'chrome-running') return;
      this.#runCheck();
    });
    proc.on('error', (err) => {
      this.state = { phase: 'idle', message: `Chrome の起動に失敗しました: ${err.message}`, checkJobId: null };
    });
    return this.state;
  }

  #runCheck() {
    try {
      const job = this.runner.start('session-check', {}, async (ctx) => {
        ctx.log('Chrome の終了を検知。セッションを再チェックします');
        let result;
        try {
          result = await withLevtech(async (page) => {
            try {
              await assertSession(page, this.config);
              ctx.log('セッション OK: 再ログインなしで到達できました');
              return { session: 'ok' };
            } catch (err) {
              if (err instanceof SessionExpiredError) {
                ctx.log('セッション NG: まだログイン画面に戻されます');
                return { session: 'expired' };
              }
              throw err;
            }
          });
        } catch (err) {
          this.state = { phase: 'idle', message: `セッションチェックに失敗しました: ${err.message}`, checkJobId: null };
          throw err;
        }
        // チェック完了後は checkJobId を残さない(P1-6): 完了済みチェックジョブの再監視が
        // 実行中ジョブの表示を乗っ取るのを防ぐ。回復済みなら残留メッセージも消す
        this.state = result.session === 'ok'
          ? { phase: 'idle', message: null, checkJobId: null }
          : { phase: 'idle', message: 'まだログインできていません。もう一度ログインをやり直してください', checkJobId: null };
        return result;
      });
      this.state = { phase: 'idle', message: 'セッションを再チェック中です', checkJobId: job.id };
    } catch (err) {
      this.state = { phase: 'idle', message: `セッションチェックを開始できませんでした: ${err.message}`, checkJobId: null };
    }
  }

  status() {
    return this.state;
  }
}
