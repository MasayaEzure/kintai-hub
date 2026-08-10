// Typeform アダプタ(PoC 04 流用): 例外日申請フォームの自動入力・送信。
// PoC で確立した流儀:
//   - アクティブ質問は data-qa-block="true" かつ data-qa-focused="true" で特定し、操作をその中に限定
//   - クリックは dispatchEvent('click')、テキストは fill + focus + Enter(ポインタ不使用)
//   - 完了判定は body テキスト「ありがとう」(実送信 2026-08-10 で確定した検出方法)
// write-ahead 原則(§3-3): 送信クリックの「前」に submitting を永続化するため、
// onBeforeSubmit コールバックを送信直前に await する。
import { chromium } from 'playwright';
import { pad2 } from '../plan.mjs';

export class TypeformStuckError extends Error {
  constructor(title) {
    super(`質問「${title}」から進めませんでした。フォームの文言変更の可能性があります`);
    this.code = 'typeform-stuck';
  }
}

// record → 回答セット
export function buildAnswers(record, { cancellation = false } = {}) {
  const md = (iso) => {
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
  };
  const dateText = record.endDate ? `${md(record.date)}〜${md(record.endDate)}` : md(record.date);
  const kindLabel = { vacation: 'お休み', late: '遅参', early: '早帰り' }[record.kind];
  if (cancellation) {
    const detail = record.cancellation?.detail
      ? record.cancellation.detail
      : `${dateText} の${kindLabel}のご連絡を取り消します`;
    return { type: '前回ご連絡の取り消し', date: dateText, start: '', end: '', reason: 'その他', detail, contacted: 'はい' };
  }
  return {
    type: kindLabel,
    date: dateText,
    start: record.kind === 'late' ? record.time : '',
    end: record.kind === 'early' ? record.time : '',
    reason: record.reason,
    detail: record.reasonDetail ?? '',
    contacted: record.contacted === false ? 'いいえ' : 'はい',
  };
}

// 全問回答 → onBeforeSubmit() → 送信 → 完了検出。
// 戻り値: { outcome: 'submitted' | 'unknown', detectedBy, bodyHead }
// 送信クリック前の失敗は throw(呼び出し側で failed 扱い)。クリック後は throw しない。
export async function submitTypeform(config, answers, { ctx, onBeforeSubmit, screenshotPrefix = 'typeform' }) {
  const rules = [
    { re: /種別/, kind: 'choice', value: answers.type },
    { re: /理由/, kind: 'choice', value: answers.reason },
    { re: /ご連絡済み/, kind: 'choice', value: answers.contacted },
    { re: /開始時刻/, kind: 'text', value: answers.start },
    { re: /終了時刻/, kind: 'text', value: answers.end },
    { re: /日にち|日時/, kind: 'text', value: answers.date },
    { re: /詳細|背景|コメント/, kind: 'text', value: answers.detail },
  ];
  const formUrl = `${config.typeform.formUrl}#id=${config.typeform.personalId}`;

  // ログイン不要のため素の起動(persistent context 不使用 = プロファイルロックと無縁)
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  try {
    const page = await browser.newPage();
    await page.goto(formUrl, { waitUntil: 'domcontentloaded' });
    const startBtn = page.locator('[data-qa="start-button"]');
    await startBtn.waitFor();
    await page.waitForTimeout(1500);
    await startBtn.dispatchEvent('click');

    let lastTitle = '';
    let stuckCount = 0;
    const answered = new Set();
    for (let step = 0; step < 25; step++) {
      await page.waitForTimeout(900);

      const block = page.locator('[data-qa-block="true"][data-qa-focused="true"]').first();
      if ((await block.count()) === 0) {
        if (await startBtn.isVisible().catch(() => false)) {
          ctx.log('開始画面のため「回答を始める」を再実行');
          await startBtn.dispatchEvent('click');
        } else {
          ctx.log('質問の表示待ち...');
        }
        continue;
      }
      const title = (await block.locator('[data-qa*="block-title"]').first().innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (!title) {
        ctx.log('質問の表示待ち...');
        continue;
      }

      const rule = rules.find((r) => r.re.test(title));
      const submitBtn = block.locator('[data-qa="submit-button"], button:has-text("送信")').first();
      const hasSubmit = (await submitBtn.count()) > 0 && (await submitBtn.isVisible().catch(() => false));

      if (hasSubmit && (!rule || answered.has(title))) {
        await ctx.screenshot(page, `${screenshotPrefix}-before-submit`);
        // ---- write-ahead: ここで submitting を永続化してから送信する ----
        await onBeforeSubmit();
        await submitBtn.dispatchEvent('click');
        // ---- ここから先は throw しない(結果は submitted / unknown のみ)----
        let detectedBy = '';
        const deadline = Date.now() + 20000;
        while (!detectedBy && Date.now() < deadline) {
          const body = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (body.includes('ありがとう')) detectedBy = 'body テキスト「ありがとう」';
          if (!detectedBy) await page.waitForTimeout(500);
        }
        await ctx.screenshot(page, `${screenshotPrefix}-after-submit`).catch(() => {});
        const bodyHead = (await page.evaluate(() => document.body.innerText).catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 200);
        if (detectedBy) {
          ctx.log(`完了画面を検出: ${detectedBy}`);
          return { outcome: 'submitted', detectedBy, bodyHead };
        }
        ctx.log('完了画面を検出できませんでした(送信自体は成立している可能性あり)');
        return { outcome: 'unknown', detectedBy: null, bodyHead };
      }

      if (title === lastTitle) {
        stuckCount++;
        if (stuckCount >= 3) throw new TypeformStuckError(title);
      } else {
        lastTitle = title;
        stuckCount = 0;
      }

      if (!rule) {
        ctx.log(`「${title}」: ルール該当なし → Enter で次へ`);
        await page.keyboard.press('Enter');
        continue;
      }

      answered.add(title);
      if (rule.kind === 'choice') {
        await block.locator('button', { hasText: rule.value }).first().dispatchEvent('click');
        ctx.log(`「${title}」→ 選択: ${rule.value}`);
      } else {
        const input = block.locator('input, textarea').first();
        if (rule.value) {
          await input.fill(rule.value);
          ctx.log(`「${title}」→ 入力: ${rule.value}`);
        } else {
          ctx.log(`「${title}」→ 空のまま次へ`);
        }
        await input.focus();
        await page.keyboard.press('Enter');
      }
    }
    throw new Error('25 ステップ以内に送信画面へ到達できませんでした');
  } finally {
    await browser.close().catch(() => {});
  }
}
