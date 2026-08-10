// レバテックアダプタ(PoC 03 / スパイク 06 流用)。
// persistent context + 実 Chrome。ライフサイクルは呼び出し側(ジョブ)が
// withLevtech() で管理し、エラー時も必ず context を閉じる。
import { chromium } from 'playwright';
import { PROFILE_DIR } from '../config.mjs';
import { sameTime, toMinutes } from '../plan.mjs';

export class SessionExpiredError extends Error {
  constructor() {
    super('レバテックのセッションが切れています。ログインし直してください');
    this.code = 'session-expired';
  }
}

export async function withLevtech(fn) {
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: null,
    });
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|browser is already in use/i.test(err.message)) {
      throw Object.assign(
        new Error('プロファイルが他の Chrome に使用中です。ログイン用に開いた Chrome を完全終了(Cmd+Q)してください'),
        { code: 'profile-locked' }
      );
    }
    throw err;
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

// セッションのプリフライトチェック(全レバテックジョブの前段で必須)
export async function assertSession(page, config) {
  await page.goto(config.levtech.topUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // SPA の描画待ち
  if ((await page.getByText('Googleでログイン').count()) > 0) throw new SessionExpiredError();
}

// 一覧から対象月の作業報告 id を解決する(§10-1 で確定した方式)
// 戻り値: { id, status, rowText }
export async function resolveReportId(page, config, month) {
  const [y, m] = month.split('-');
  const periodHead = `${y}/${m}/01`; // 行内の期間テキスト YYYY/MM/01~YYYY/MM/DD
  await page.goto(config.levtech.listUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const rows = await page.evaluate(() => {
    const trim = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('a')]
      .map((a) => ({
        href: a.getAttribute('href') || '',
        rowText: trim(a.closest('tr, li, [class*="item"], [class*="card"], [class*="row"]')?.textContent),
      }))
      .filter((r) => /\/p\/workreport\/\d+\//.test(r.href));
  });
  const hit = rows.find((r) => r.rowText.includes(periodHead));
  if (!hit) {
    throw Object.assign(
      new Error(`一覧に ${y}年${Number(m)}月 の行が見つかりませんでした。URL の手動入力で続行できます`),
      { code: 'url-unresolved' }
    );
  }
  const id = /\/p\/workreport\/(\d+)\//.exec(hit.href)[1];
  const status = /要対応/.test(hit.rowText) ? '要対応' : /確認待ち/.test(hit.rowText) ? '確認待ち' : /完了/.test(hit.rowText) ? '完了' : '不明';
  return { id, status, rowText: hit.rowText };
}

// 月照合ガード(F1 手順3): 詳細ページの「報告月 YYYY年MM月」を読み取り、対象月と突合
export async function assertMonthMatches(page, id, month) {
  const [y, m] = month.split('-').map(Number);
  await page.goto(`https://platform.levtech.jp/p/workreport/${id}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const body = await page.evaluate(() => document.body.innerText);
  const found = /報告月[\s::]*([0-9]{4})\s*年\s*([0-9]{1,2})\s*月/.exec(body.replace(/\s+/g, ' '));
  if (!found) {
    throw new Error(`詳細ページから「報告月」を読み取れませんでした(id=${id})。画面構造が変わった可能性があります`);
  }
  const pageMonth = `${found[1]}年${Number(found[2])}月`;
  if (Number(found[1]) !== y || Number(found[2]) !== m) {
    throw new Error(`月照合ガード: ページの報告月(${pageMonth})が対象月(${y}年${m}月)と一致しません。中断します`);
  }
  return pageMonth;
}

// 入力ページの全行をスクレイプし、既存値を返す(読み取りのみ)
// 戻り値: Map<label, {start, end, rest}>
export async function scrapeRows(page, inputUrl, days) {
  if (page.url() !== inputUrl) {
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('text=保存する', { timeout: 15000 });
  const existing = new Map();
  for (const day of days) {
    const row = page.locator('tr', { hasText: day.label }).first();
    if ((await row.count()) === 0) continue; // 行が無い日(月によっては存在しない)は対象外
    const inputs = row.locator('input[type="text"], input:not([type])');
    if ((await inputs.count()) < 3) continue;
    existing.set(day.label, {
      start: (await inputs.nth(0).inputValue()).trim(),
      end: (await inputs.nth(1).inputValue()).trim(),
      rest: (await inputs.nth(2).inputValue()).trim(),
    });
  }
  return existing;
}

// 期待値照合(F1 手順4): 各行のアクションを決定する
// action: 'match'(一致) | 'fill'(空欄→入力) | 'skip'(両方空欄) | 'mismatch'(要承認) | 'absent'(行なし)
export function classifyRows(days, existing) {
  return days.map((day) => {
    const ex = existing.get(day.label) ?? null;
    const expected = day.expected;
    let action;
    if (!ex) {
      action = 'absent';
    } else {
      const expectedEmpty = !expected.start && !expected.end && !expected.rest;
      const existingEmpty = !ex.start && !ex.end && !ex.rest;
      if (expectedEmpty && existingEmpty) action = 'skip';
      else if (existingEmpty) action = 'fill';
      else if (sameTime(ex.start, expected.start) && sameTime(ex.end, expected.end) && sameTime(ex.rest, expected.rest)) action = 'match';
      else action = 'mismatch';
    }
    return { ...day, existing: ex, action };
  });
}

// 承認済みの計画をフォームへ反映する(fill + 承認された mismatch のみ)
export async function applyRows(page, rows, approvedDates) {
  const applied = [];
  for (const row of rows) {
    const write = row.action === 'fill' || (row.action === 'mismatch' && approvedDates.includes(row.date));
    if (!write) continue;
    const tr = page.locator('tr', { hasText: row.label }).first();
    const inputs = tr.locator('input[type="text"], input:not([type])');
    await inputs.nth(0).fill(row.expected.start);
    await inputs.nth(1).fill(row.expected.end);
    await inputs.nth(2).fill(row.expected.rest);
    await inputs.nth(2).blur(); // 作業時間の自動計算を発火
    applied.push(row);
  }
  return applied;
}

// 保存前の最終突合(F1 手順6): 全行を再スクレイプし、最終期待状態と比較
export function finalExpectedState(rows, approvedDates) {
  return rows.map((row) => {
    const overwritten = row.action === 'fill' || (row.action === 'mismatch' && approvedDates.includes(row.date));
    const finalValues = overwritten ? row.expected : (row.existing ?? { start: '', end: '', rest: '' });
    return { ...row, finalValues };
  });
}

export function verifyAgainst(finalRows, rescraped) {
  const diffs = [];
  for (const row of finalRows) {
    if (row.action === 'absent') continue;
    const now = rescraped.get(row.label);
    if (!now) {
      diffs.push(`${row.label}: 再取得で行が見つかりません`);
      continue;
    }
    const f = row.finalValues;
    if (!sameTime(now.start, f.start) || !sameTime(now.end, f.end) || !sameTime(now.rest, f.rest)) {
      diffs.push(`${row.label}: 期待 ${f.start || '空'}-${f.end || '空'}/${f.rest || '空'} 実際 ${now.start || '空'}-${now.end || '空'}/${now.rest || '空'}`);
    }
  }
  return diffs;
}

// 保存(F1 手順7): a.btnSaveReport → 「更新しました。」のアサート
export async function saveAndAssert(page) {
  await page.locator('a.btnSaveReport').first().click();
  await page.waitForSelector('text=更新しました', { timeout: 20000 });
}

// サマリ用: 入力日数と合計時間(分)
export function summarize(finalRows) {
  let days = 0;
  let minutes = 0;
  for (const row of finalRows) {
    const f = row.finalValues;
    if (f && f.start && f.end) {
      days++;
      minutes += toMinutes(f.end) - toMinutes(f.start) - (toMinutes(f.rest) ?? 0);
    }
  }
  return { days, minutes, hours: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` };
}
