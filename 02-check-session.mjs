// PoC ステップ2(仮説1の検証): 保存済みセッションで再ログインなしに勤怠画面へ到達できるか
// 実行: npm run check (01-login の翌日以降に実行するのが望ましい)
import fs from 'node:fs';
import { chromium } from 'playwright';

const context = await chromium.launchPersistentContext('./profile', {
  headless: false,
  channel: 'chrome',
  viewport: null,
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://platform.levtech.jp/p/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000); // SPA の描画待ち

fs.mkdirSync('./screenshots', { recursive: true });
await page.screenshot({ path: './screenshots/session-check.png', fullPage: true });

const needsLogin = (await page.getByText('Googleでログイン').count()) > 0;
if (needsLogin) {
  console.log('NG: ログイン画面に戻されました。セッションが維持されていません(仮説1不成立の可能性)。');
  console.log('    数日でセッションが切れるだけなら、有効期限を計測して運用でカバーできるか判断してください。');
} else {
  console.log('OK: 再ログインなしでログイン済み画面に到達しました(仮説1クリア)。');
  console.log('    続けて手動で「契約」>「作業報告」まで進み、フォームの DOM を確認できます。');
}
console.log('スクリーンショット: ./screenshots/session-check.png');
console.log('確認が終わったら Enter でブラウザを閉じます。');

process.stdin.once('data', async () => {
  await context.close();
  process.exit(0);
});
