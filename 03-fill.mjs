// PoC ステップ3(仮説2の検証): 作業報告フォームへの自動入力 → 保存
//
// 実行例:
//   npm run fill -- --url https://platform.levtech.jp/p/workreport/input/1051841/
//       … ドライラン(入力するが「保存する」は押さない)
//   npm run fill -- --url https://platform.levtech.jp/p/workreport/input/1051841/ --save
//       … 実際に保存まで行う
//   --url を省略した場合は「作業報告 > 要対応 > 編集する」のUI遷移を試みる
import fs from 'node:fs';
import { chromium } from 'playwright';

const SAVE = process.argv.includes('--save');
const urlIdx = process.argv.indexOf('--url');
const REPORT_URL = urlIdx !== -1 ? process.argv[urlIdx + 1] : null;

// ---- 設定 ----------------------------------------------------------------
// 基本勤務時間
const TIMES = { start: '09:00', end: '18:00', rest: '01:00' };

// 入力しない日 (MM/DD): 祝日・休暇をここに足す(土日は自動でスキップ)
const SKIP_DATES = [
  '08/11', // 山の日
  '08/10', // 休暇
  '08/12', // 休暇
  '08/13', // 休暇
];

// 例外日の個別上書き(遅刻早退・半休など)
// 例: '08/15': { start: '13:00', end: '18:15', rest: '00:00' },
const OVERRIDES = {};
// --------------------------------------------------------------------------

const context = await chromium.launchPersistentContext('./profile', {
  headless: false,
  channel: 'chrome',
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
fs.mkdirSync('./screenshots', { recursive: true });

if (REPORT_URL) {
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
} else {
  // UI 遷移(手順4〜6)。要対応が複数ある場合は先頭を選ぶ
  await page.goto('https://platform.levtech.jp/p/', { waitUntil: 'domcontentloaded' });
  await page.getByText('作業報告').first().click();
  await page.getByText('要対応').first().click();
  await page.getByRole('button', { name: '編集する' }).click();
}
await page.waitForSelector('text=保存する');

// 対象月の平日を列挙して1行ずつ入力
const now = new Date();
const year = now.getFullYear();
const month = now.getMonth(); // 表示中の作業報告が当月である前提
const daysInMonth = new Date(year, month + 1, 0).getDate();

let filled = 0;
for (let d = 1; d <= daysInMonth; d++) {
  const dow = new Date(year, month, d).getDay();
  const label = `${String(month + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}`;

  if (dow === 0 || dow === 6) continue; // 土日
  if (SKIP_DATES.includes(label)) {
    console.log(`${label}: SKIP_DATES 指定のためスキップ`);
    continue;
  }

  const row = page.locator('tr', { hasText: label }).first();
  // 行内のテキスト入力のうち先頭3つが 開始・終了・休憩(列順に依存)
  const inputs = row.locator('input[type="text"], input:not([type])');

  const existing = (await inputs.nth(0).inputValue()).trim();
  if (existing !== '') {
    console.log(`${label}: 入力済み(開始 ${existing})のためスキップ`);
    continue;
  }

  const t = OVERRIDES[label] ?? TIMES;
  await inputs.nth(0).fill(t.start);
  await inputs.nth(1).fill(t.end);
  await inputs.nth(2).fill(t.rest);
  await inputs.nth(2).blur(); // 作業時間の自動計算を発火させる

  const rowText = await row.innerText();
  console.log(`${label}: ${t.start}-${t.end} 休憩${t.rest} → 行表示: ${rowText.replace(/\s+/g, ' ').trim()}`);
  filled++;
}

await page.screenshot({ path: './screenshots/after-fill.png', fullPage: true });
console.log(`\n${filled} 日分を入力しました。スクリーンショット: ./screenshots/after-fill.png`);

if (SAVE) {
  // 「保存する」は <a class="btnSaveReport" href="javascript:void(0);"> のためロール button では取れない
  await page.locator('a.btnSaveReport').first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: './screenshots/after-save.png', fullPage: true });
  console.log('「保存する」を押しました。スクリーンショット: ./screenshots/after-save.png');
  console.log('画面をリロードして値が残っていれば仮説2クリアです。');
} else {
  console.log('ドライラン: 「保存する」は押していません。画面で入力内容と作業時間の自動計算を確認してください。');
}

console.log('確認が終わったら Enter でブラウザを閉じます(ドライランの場合、入力値は保存されません)。');
process.stdin.once('data', async () => {
  await context.close();
  process.exit(0);
});
