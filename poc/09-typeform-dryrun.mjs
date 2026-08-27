// PoC ステップ6: Typeform ドライラン(月末一括化で新しく使う回答パターンの実地確認)。
// ※ 本実装(src/adapters/typeform.mjs の buildAnswers 日付書式)へ 2026-08-21 反映済み。検証記録として残置。
// 全問を回答して送信ボタンの「手前」で停止し、各質問のスクリーンショットを残す。
//
// !! このスクリプトには送信ボタンを押すコードが存在しない(--submit も無い)。
// !! 送信画面を検出したら撮影してブラウザを閉じるだけ。押し間違いの余地をゼロにする設計。
//
// 検証パターン(2026-08-19 グリル確定の初回導入分。ダミー8月ファイルの行に対応):
//   vacation-range … お休みの期間指定「8/12〜8/13」(連続休暇のまとめ)
//   late-halfday   … 遅参・出社13:00(午前休暇の対応先)
//   early-halfday  … 早帰り・退社12:00(午後休暇の対応先)
//
// 実行: npm run typeform-dryrun -- vacation-range
//       npm run typeform-dryrun -- late-halfday
//       npm run typeform-dryrun -- early-halfday
import fs from 'node:fs';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.mjs';

// フォーム URL と本人特定 ID は config.json(Git 管理外)から読む(ハードコード排除)
const config = loadConfig();
const FORM_URL = `${config.typeform.formUrl}#id=${config.typeform.personalId}`;

const PATTERNS = {
  // 期間の書式はフォーム側の記入ガイド「20YY/MM/DD〜20YY/MM/DD のようにご回答ください」に従う
  // (ドライラン 2026-08-20 で発見。単日は実送信実績のある M/D のまま)。
  // 詳細欄はフォーム上任意(必須*なし)のため空欄で送る(2026-08-20 決定)
  'vacation-range': {
    type: 'お休み', date: '2026/08/12〜2026/08/13', start: '', end: '',
    reason: '私用', detail: '', contacted: 'はい',
  },
  'late-halfday': {
    type: '遅参', date: '8/17', start: '13:00', end: '',
    reason: '私用', detail: '', contacted: 'はい',
  },
  'early-halfday': {
    type: '早帰り', date: '8/18', start: '', end: '12:00',
    reason: '私用', detail: '', contacted: 'はい',
  },
};

const patternName = process.argv[2];
const answers = PATTERNS[patternName];
if (!answers) {
  console.error(`パターンを指定してください: ${Object.keys(PATTERNS).join(' | ')}`);
  process.exit(1);
}

const shotDir = `./screenshots/typeform-dryrun-${patternName}`;
fs.mkdirSync(shotDir, { recursive: true });
let shotNo = 0;
const shot = async (page, name) => {
  await page.waitForTimeout(700); // 質問切り替えのフェードが残っていると空白/半透明で写るため静止を待つ
  const path = `${shotDir}/${String(++shotNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
};

// 質問タイトル → 回答のマッピング(アダプタ src/adapters/typeform.mjs と同一の rules)
const rules = [
  { re: /種別/, kind: 'choice', value: answers.type },
  { re: /理由/, kind: 'choice', value: answers.reason },
  { re: /ご連絡済み/, kind: 'choice', value: answers.contacted },
  { re: /開始時刻/, kind: 'text', value: answers.start },
  { re: /終了時刻/, kind: 'text', value: answers.end },
  { re: /日にち|日時/, kind: 'text', value: answers.date },
  { re: /詳細|背景|コメント/, kind: 'text', value: answers.detail },
];

console.log(`パターン: ${patternName}`);
console.log(`回答セット: ${JSON.stringify(answers)}`);

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage();

await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
const startBtn = page.locator('[data-qa="start-button"]');
await startBtn.waitFor();
await page.waitForTimeout(1500);
await startBtn.dispatchEvent('click');

let lastTitle = '';
let stuckCount = 0;
let reachedSubmit = false;
const answered = new Set();
for (let step = 0; step < 25; step++) {
  await page.waitForTimeout(900);

  const block = page.locator('[data-qa-block="true"][data-qa-focused="true"]').first();
  if ((await block.count()) === 0) {
    if (await startBtn.isVisible().catch(() => false)) {
      console.log('開始画面のため「回答を始める」を再実行');
      await startBtn.dispatchEvent('click');
    } else {
      console.log('質問の表示待ち...');
    }
    continue;
  }
  const title = (await block.locator('[data-qa*="block-title"]').first().innerText().catch(() => ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) {
    console.log('質問の表示待ち...');
    continue;
  }

  const rule = rules.find((r) => r.re.test(title));
  const submitBtn = block.locator('[data-qa="submit-button"], button:has-text("送信")').first();
  const hasSubmit = (await submitBtn.count()) > 0 && (await submitBtn.isVisible().catch(() => false));

  if (hasSubmit && (!rule || answered.has(title))) {
    // ドライランのゴール: 送信画面に到達したことを記録して終了(送信は押さない・押せない)
    const path = await shot(page, 'before-submit');
    console.log(`送信画面に到達しました(送信はしていません)。スクリーンショット: ${path}`);
    reachedSubmit = true;
    break;
  }

  if (title === lastTitle) {
    stuckCount++;
    if (stuckCount >= 3) {
      await shot(page, 'stuck');
      console.log(`FAIL 「${title}」から進めませんでした。フォームの文言変更か回答値の不受理の可能性があります。`);
      break;
    }
  } else {
    lastTitle = title;
    stuckCount = 0;
  }

  if (!rule) {
    console.log(`「${title}」: ルール該当なし → Enter で次へ`);
    await page.keyboard.press('Enter');
    continue;
  }

  answered.add(title);
  if (rule.kind === 'choice') {
    await block.locator('button', { hasText: rule.value }).first().dispatchEvent('click');
    await shot(page, `choice-${rule.value}`);
    console.log(`「${title}」→ 選択: ${rule.value}`);
  } else {
    const input = block.locator('input, textarea').first();
    if (rule.value) {
      await input.fill(rule.value);
      console.log(`「${title}」→ 入力: ${rule.value}`);
    } else {
      console.log(`「${title}」→ 空のまま次へ`);
    }
    await shot(page, `text-${rule.re.source.replace(/[^ぁ-んァ-ヶ一-龠a-zA-Z]/g, '')}`);
    await input.focus();
    await page.keyboard.press('Enter');
  }
}

if (!reachedSubmit) {
  console.log('FAIL 25 ステップ以内に送信画面へ到達できませんでした。');
}
await browser.close();
process.exit(reachedSubmit ? 0 : 1);
