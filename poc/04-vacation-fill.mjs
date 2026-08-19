// PoC ステップ4: 例外日申請フォーム(Typeform)への自動入力
//
// ログイン不要。回答は最後の「送信」を押すまでサーバーに記録されないため、
// デフォルトはドライラン(全問回答して送信ボタンの手前で停止)。
// 申請は提出後に取り下げできない(営業担当者への連絡が必要)ので、
// --submit は実際に申請したい内容のときだけ付けること。
//
// 実行例:
//   npm run vacation -- --type お休み --date 8/21 --reason 私用
//   npm run vacation -- --type 遅参 --date 8/22 --start 11:00 --reason 私用 --detail 通院のため
//   npm run vacation -- --type 早帰り --date 8/22 --end 15:00 --reason 私用 --contacted はい
//   (送信まで行う場合のみ --submit を追加)
import fs from 'node:fs';
import { chromium } from 'playwright';

const MY_ID = 'ENG0000907506';
const FORM_URL = `https://crmleverages.typeform.com/to/u67kvMSy#id=${MY_ID}`;

// ---- CLI 引数 ----
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};
const SUBMIT = process.argv.includes('--submit');
const answers = {
  type: arg('type', 'お休み'), // お休み | 遅参 | 早帰り | その他 | 前回ご連絡の取り消し
  date: arg('date'),           // 対象日 (例: 8/21)
  start: arg('start'),         // 遅参時の作業開始時刻目途
  end: arg('end'),             // 早帰り時の作業終了時刻目途
  reason: arg('reason', '私用'), // ご体調不良 | 私用 | その他
  detail: arg('detail'),       // 私用・その他の詳細 / 取り消しの背景 / コメント
  contacted: arg('contacted', 'はい'), // 参画先企業へ連絡済みか
};
if (!answers.date) {
  console.error('--date は必須です (例: --date 8/21)');
  process.exit(1);
}

// 質問タイトル(タブタイトル経由で取得)→ 回答のマッピング
const rules = [
  { re: /種別/, kind: 'choice', value: () => answers.type },
  { re: /理由/, kind: 'choice', value: () => answers.reason },
  { re: /ご連絡済み/, kind: 'choice', value: () => answers.contacted },
  { re: /開始時刻/, kind: 'text', value: () => answers.start },
  { re: /終了時刻/, kind: 'text', value: () => answers.end },
  { re: /日にち|日時/, kind: 'text', value: () => answers.date },
  { re: /詳細|背景|コメント/, kind: 'text', value: () => answers.detail },
];

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage();
fs.mkdirSync('./screenshots', { recursive: true });

await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
// クリックはオーバーレイに横取りされて完了しないことがあるため、イベントを直接発火する
const startBtn = page.locator('[data-qa="start-button"]');
await startBtn.waitFor();
await page.waitForTimeout(1500); // アプリの初期化待ち
await startBtn.dispatchEvent('click');

let lastTitle = '';
let stuckCount = 0;
const answered = new Set(); // 回答済みの質問タイトル
for (let step = 0; step < 25; step++) {
  await page.waitForTimeout(900); // 画面遷移アニメーション待ち

  // アクティブな質問ブロック(data-qa-focused="true")を DOM から直接特定する。
  // タブタイトルは更新されないことがあり、:visible は画面外の質問にも誤マッチするため使わない
  const block = page.locator('[data-qa-block="true"][data-qa-focused="true"]').first();
  if ((await block.count()) === 0) {
    // 開始画面に留まっている場合はもう一度開始を試みる
    if (await startBtn.isVisible().catch(() => false)) {
      console.log('開始画面のため「回答を始める」を再実行');
      await startBtn.dispatchEvent('click');
    } else {
      console.log('質問の表示待ち...');
    }
    continue;
  }
  const title = (
    await block
      .locator('[data-qa*="block-title"]')
      .first()
      .innerText()
      .catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) {
    console.log('質問の表示待ち...');
    continue;
  }

  const rule = rules.find((r) => r.re.test(title));

  // 送信判定はアクティブブロック内に限定する(ページ全体だと画面外の最終画面のボタンを誤検出する)。
  // ブロック内に送信ボタンがあり、かつその質問に回答済み(または回答不要)なら送信画面とみなす
  const submitBtn = block.locator('[data-qa="submit-button"], button:has-text("送信")').first();
  const hasSubmit =
    (await submitBtn.count()) > 0 && (await submitBtn.isVisible().catch(() => false));
  if (hasSubmit && (!rule || answered.has(title))) {
    await page.screenshot({ path: './screenshots/vacation-before-submit.png', fullPage: true });
    if (SUBMIT) {
      await submitBtn.dispatchEvent('click');
      // 完了画面の検出(MVP の submitted 判定に使うセレクタの実地調査を兼ねる)
      const indicators = [
        ['[data-qa="thank-you-screen"]', 'data-qa=thank-you-screen'],
        ['text=送信しました', 'テキスト「送信しました」'],
        ['text=ありがとう', 'テキスト「ありがとう」'],
      ];
      let detected = '';
      const deadline = Date.now() + 15000;
      while (!detected && Date.now() < deadline) {
        for (const [sel, name] of indicators) {
          if ((await page.locator(sel).count().catch(() => 0)) > 0) {
            detected = name;
            break;
          }
        }
        if (!detected) await page.waitForTimeout(500);
      }
      await page.screenshot({ path: './screenshots/vacation-after-submit.png', fullPage: true });
      console.log('送信しました。スクリーンショット: ./screenshots/vacation-after-submit.png');
      console.log(
        detected
          ? `完了画面を検出: ${detected}`
          : '完了画面を検出できませんでした。スクリーンショットで目視確認してください(送信自体は成立している可能性あり)。'
      );
      const bodyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300);
      console.log(`画面テキスト冒頭: ${bodyText}`);
      await browser.close();
      process.exit(0);
    } else {
      console.log('ドライラン: 送信ボタンの手前で停止しました(回答は送信されていません)。');
      console.log('スクリーンショット: ./screenshots/vacation-before-submit.png');
    }
    break;
  }

  // 同じ質問に3回続けて留まったら打ち切り(無限ループ防止)
  if (title === lastTitle) {
    stuckCount++;
    if (stuckCount >= 3) {
      console.log(`「${title}」から進めませんでした。必須項目の可能性があります。`);
      break;
    }
  } else {
    lastTitle = title;
    stuckCount = 0;
  }

  if (!rule) {
    // statement 等、回答不要の画面は Enter で送る
    console.log(`「${title}」: ルール該当なし → Enter で次へ`);
    await page.keyboard.press('Enter');
    continue;
  }

  const value = rule.value();
  answered.add(title);
  if (rule.kind === 'choice') {
    await block.locator('button', { hasText: value }).first().dispatchEvent('click');
    console.log(`「${title}」→ 選択: ${value}`);
    // 選択肢はクリックで自動的に次の質問へ進む
  } else {
    // fill はポインタを使わないため横取りの影響を受けない。フォーカスを当てて Enter で進む
    const input = block.locator('input, textarea').first();
    if (value) {
      await input.fill(value);
      console.log(`「${title}」→ 入力: ${value}`);
    } else {
      console.log(`「${title}」→ 空のまま次へ`);
    }
    await input.focus();
    await page.keyboard.press('Enter');
  }
}

console.log('確認が終わったら Enter でブラウザを閉じます。');
process.stdin.once('data', async () => {
  await browser.close();
  process.exit(0);
});
