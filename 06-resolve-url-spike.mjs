// MVP 着工前スパイク: 作業報告一覧から「月 → workreport/input/{id}」を自動解決できるかの調査
//
// 読み取り専用。フォームへの入力・保存・編集は一切行わない(画面遷移とDOM収集のみ)。
// 調査項目:
//   1. 一覧画面に月ラベルと workreport の URL(または編集リンク)が DOM 上で対になって存在するか
//   2. タブ(要対応/対応済み等)ごとに何が表示されるか。保存済みの月はどこに現れるか
//   3. 編集リンクの実体(<a href> か JS ナビゲーションか)
// 実行: node 06-resolve-url-spike.mjs
import fs from 'node:fs';
import { chromium } from 'playwright';

const context = await chromium.launchPersistentContext('./profile', {
  headless: false,
  channel: 'chrome',
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
fs.mkdirSync('./screenshots/spike', { recursive: true });

// 現在の画面から「月ラベル・リンク・行テキスト」を収集する
async function dumpPage(label) {
  await page.waitForTimeout(2000);
  const path = `./screenshots/spike/${label}.png`;
  await page.screenshot({ path, fullPage: true });

  const data = await page.evaluate(() => {
    const trim = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    // workreport を含むリンク全部
    const links = [...document.querySelectorAll('a')]
      .filter((a) => (a.getAttribute('href') || '').includes('workreport') || /編集|詳細|確認|報告/.test(a.textContent || ''))
      .map((a) => ({
        text: trim(a.textContent),
        href: a.getAttribute('href'),
        onclick: a.getAttribute('onclick'),
        rowText: trim(a.closest('tr, li, [class*="item"], [class*="card"], [class*="row"]')?.textContent),
      }));
    // ボタン類(JS ナビゲーションの可能性)
    const buttons = [...document.querySelectorAll('button')]
      .filter((b) => /編集|詳細|確認/.test(b.textContent || ''))
      .map((b) => ({
        text: trim(b.textContent),
        rowText: trim(b.closest('tr, li, [class*="item"], [class*="card"], [class*="row"]')?.textContent),
      }));
    // 月ラベルらしきテキスト
    const monthLabels = trim(document.body.innerText).match(/\d{4}年\s*\d{1,2}月|\d{1,2}月分/g) || [];
    return { url: location.href, links, buttons, monthLabels, bodyHead: trim(document.body.innerText).slice(0, 600) };
  });

  console.log(`\n===== [${label}] ${data.url}`);
  console.log(`スクリーンショット: ${path}`);
  console.log(`月ラベル候補: ${JSON.stringify(data.monthLabels)}`);
  console.log(`--- workreport/編集系リンク (${data.links.length}件) ---`);
  for (const l of data.links) console.log(JSON.stringify(l));
  console.log(`--- ボタン (${data.buttons.length}件) ---`);
  for (const b of data.buttons) console.log(JSON.stringify(b));
  console.log(`--- 画面テキスト冒頭 ---\n${data.bodyHead}`);
  return data;
}

try {
  await page.goto('https://platform.levtech.jp/p/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  if ((await page.getByText('Googleでログイン').count()) > 0) {
    console.log('NG: セッション切れ。npm run login でログインし直してください。');
    await context.close();
    process.exit(1);
  }
  await dumpPage('00-top');

  // 作業報告の一覧へ(サイドメニューは折りたたまれてクリック不可のため直接遷移)
  await page.goto('https://platform.levtech.jp/p/work-report/', { waitUntil: 'domcontentloaded' });
  await dumpPage('01-list');

  // タブ候補を順に開いて収集(存在するものだけ)
  const tabCandidates = ['要対応', '対応済み', '完了', '過去', '履歴'];
  for (const tab of tabCandidates) {
    const el = page.getByText(tab, { exact: false }).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click().catch(() => {});
      await dumpPage(`02-tab-${tab}`);
    } else {
      console.log(`\n===== [02-tab-${tab}] 見つからず(スキップ)`);
    }
  }
} catch (err) {
  console.error('調査中にエラー:', err.message);
  await page.screenshot({ path: './screenshots/spike/error.png', fullPage: true }).catch(() => {});
} finally {
  await context.close();
}
