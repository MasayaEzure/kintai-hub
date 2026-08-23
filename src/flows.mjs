// フロー本体(ジョブとして実行される一連の手順)。
// フロー①: 月末一括(Excel取込 → 確認 → レバテック入力 → Typeform 逐次送信)/ Typeform 単体再送
import fs from 'node:fs';
import path from 'node:path';
import { audit } from './audit.mjs';
import { DATA_DIR } from './config.mjs';
import { toPlanDays } from './excel.mjs';
import { buildSubmissionPlan, applyDecision, TYPE_TO_KIND } from './applications.mjs';
import {
  withLevtech,
  assertSession,
  resolveReportId,
  assertMonthMatches,
  scrapeRows,
  classifyRows,
  absentExpectedRows,
  applyRows,
  finalExpectedState,
  verifyAgainst,
  saveAndAssert,
  summarize,
} from './adapters/levtech.mjs';
import { submitTypeform, buildAnswers } from './adapters/typeform.mjs';
import { JobAbortedError } from './jobs.mjs';

// ---- フロー①: 月末一括(レバテック入力パート)-------------------------------
// スキャン → プレビュー(勤怠+申請一覧の確認待ち)→ 承認された入力のみ反映 →
// 再スクレイプ突合 → 保存アサート。安全機構(プレビュー承認・月照合ガード・
// 再スクレイプ突合・保存アサート)は従来のまま。
// 戻り値に sendList(承認済みの Typeform 送信リスト)を含め、送信は呼び出し側が
// レバテック用ブラウザを閉じた後に行う(可逆を先・不可逆を後)
async function fillLevtechReport(ctx, store, config, { month, days, workHours, manualUrl, applications }) {
  return await withLevtech(async (page) => {
    ctx.log('セッションのプリフライトチェック中...');
    await assertSession(page, config);

    let id;
    if (manualUrl) {
      const m = /workreport(?:\/input)?\/(\d+)/.exec(manualUrl);
      if (!m) throw new Error(`手動 URL から id を抽出できませんでした: ${manualUrl}`);
      id = m[1];
      ctx.log(`手動 URL 指定: id=${id}`);
    } else {
      ctx.log('作業報告一覧から対象月の URL を解決中...');
      const resolved = await resolveReportId(page, config, month);
      if (resolved.status !== '要対応') {
        throw new Error(
          `対象月のステータスが「${resolved.status}」のため入力対象外です(要対応のみ入力可)。行: ${resolved.rowText.slice(0, 80)}`
        );
      }
      id = resolved.id;
      ctx.log(`解決: id=${id}(${resolved.status})`);
    }

    const pageMonth = await assertMonthMatches(page, id, month);
    ctx.log(`月照合ガード OK: ${pageMonth}`);

    const inputUrl = `https://platform.levtech.jp/p/workreport/input/${id}/`;
    ctx.log('入力ページの既存値をスキャン中(この時点では何も入力しません)...');
    const existing = await scrapeRows(page, inputUrl, days);
    const rows = classifyRows(days, existing);
    await ctx.screenshot(page, '01-scan');

    // 期待値があるのに行が見つからない日は入力漏れになるため中断する(P2-2)
    const missing = absentExpectedRows(rows);
    if (missing.length > 0) {
      throw new Error(
        `入力が必要な日の行が見つかりませんでした: ${missing.map((r) => r.label).join(', ')}。` +
          '画面構造の変化や対象月のズレの可能性があるため、何も入力せず中断します'
      );
    }

    const counts = {
      fill: rows.filter((r) => r.action === 'fill').length,
      match: rows.filter((r) => r.action === 'match').length,
      mismatch: rows.filter((r) => r.action === 'mismatch').length,
    };
    ctx.log(`スキャン完了: 入力予定 ${counts.fill} 日 / 一致 ${counts.match} 日 / 不一致 ${counts.mismatch} 日`);

    const needLevtech = counts.fill > 0 || counts.mismatch > 0;
    const needTypeform = applications.planned.length > 0;
    if (!needLevtech && !needTypeform) {
      ctx.log('入力・変更が必要な行も、送信すべき申請もありません。何もせず終了します');
      return {
        month, saved: false, counts, sendList: [],
        message: '変更なし(すべて入力済み・一致、申請も送信済みかありません)',
      };
    }

    // 確認待ち: 勤怠(不一致は承認行のみ上書き)と Typeform 申請一覧を 1 回の承認にまとめる
    const decision = await ctx.waitConfirmation({
      kind: 'levtech-plan',
      source: 'excel',
      month,
      workHours,
      counts,
      levtechNeeded: needLevtech,
      rows: rows.map(({ date, label, dowLabel, note, expected, existing, action, unsubmitted, excelKind, warnings }) => ({
        date, label, dowLabel, note, expected, existing, action, unsubmitted, excelKind, warnings,
      })),
      applications,
    });
    // 承認直後・入力前に確認結果を検証する(壊れた承認データでレバテック保存だけ走る事故を防ぐ)
    const sendList = applyDecision(applications.planned, decision.applications);
    const approvedDates = decision.approvedDates ?? [];
    ctx.log(`承認されました(上書き承認 ${approvedDates.length} 件 / 申請送信 ${sendList.length} 件)`);

    if (!needLevtech) {
      ctx.log('レバテック側は変更なしのため、入力・保存をスキップします');
      return { month, saved: false, counts, sendList, message: '変更なし(すべて入力済み・一致)' };
    }

    const applied = await applyRows(page, rows, approvedDates);
    ctx.log(`${applied.length} 行を入力しました`);
    await ctx.screenshot(page, '02-after-fill');

    ctx.log('保存前の最終突合: 全行を再スクレイプして計画と比較します');
    const finalRows = finalExpectedState(rows, approvedDates);
    const rescraped = await scrapeRows(page, inputUrl, days);
    const diffs = verifyAgainst(finalRows, rescraped);
    if (diffs.length > 0) {
      await ctx.screenshot(page, '03-verify-failed');
      throw new Error(`最終突合で不一致が見つかったため保存せず中断しました: ${diffs.join(' / ')}`);
    }
    ctx.log('最終突合 OK。「保存する」をクリックします');

    await saveAndAssert(page);
    await ctx.screenshot(page, '04-after-save');
    const summary = summarize(finalRows);
    ctx.log(`保存成功: 「更新しました。」を確認(${summary.days} 日 / ${summary.hours})`);

    audit('levtech.save', {
      jobId: ctx.jobId,
      source: 'excel',
      month,
      workHours,
      applied: applied.map((r) => ({ date: r.date, values: r.expected })),
      approvedOverwrites: approvedDates,
      summary,
    });
    store.recordLevtechRun(month, {
      jobId: ctx.jobId,
      state: 'succeeded',
      filledDays: summary.days,
      totalHours: summary.hours,
      appliedCount: applied.length,
    });
    return { month, saved: true, counts, applied: applied.length, summary, sendList };
  });
}

// ---- フロー①: 月末一括(Typeform 逐次送信パート)----------------------------
// レバテック保存の成功後にのみ呼ばれる(失敗時は throw 済みで申請は 1 件も送らない)。
// 1 件ずつ: 台帳レコード作成 → write-ahead(submitting)→ 送信 → submitted で続行。
// 途中失敗(failed / unknown)は系統的失敗の可能性が高いためそこで中断する(設計決定9)。
// 再実行時は送信済みが reconcile でスキップされ、残りだけが送られる
async function submitApplications(ctx, store, config, sendList) {
  const result = { planned: sendList.length, sent: 0 };
  if (sendList.length === 0) return result;

  for (const [i, app] of sendList.entries()) {
    const label = `${app.dateText} ${app.type}`;
    ctx.log(`Typeform 申請 ${i + 1}/${sendList.length}: ${label}`);

    // 同じ日に残った未送信レコード(none / failed)は論理削除して作り直す
    // (1 レコード = 1 回の送信試行系列。重複バリデーションとも整合する)
    for (const staleId of app.staleRecordIds) {
      store.cancelDirect(staleId);
      audit('exception.auto-cancel-stale', { jobId: ctx.jobId, recordId: staleId, date: app.date });
    }
    const rec = store.create({
      kind: TYPE_TO_KIND[app.type],
      date: app.date,
      endDate: app.endDate,
      time: app.time,
      reason: app.reason,
      reasonDetail: null, // 詳細欄はフォーム上任意のため空欄で送る(備考はプレビュー表示のみ)
      contacted: true,
    });
    audit('exception.create', { jobId: ctx.jobId, recordId: rec.id, kind: rec.kind, date: rec.date });

    const answers = buildAnswers(rec);
    audit('typeform.attempt', { jobId: ctx.jobId, recordId: rec.id, answers });
    let res;
    try {
      res = await submitTypeform(config, answers, {
        ctx,
        screenshotPrefix: `typeform-${rec.date}`, // 複数件送るためスクショ名を日付で分離
        onBeforeSubmit: async () => {
          store.transitionTypeform(rec.id, 'submitting'); // write-ahead(§3-3)
        },
      });
    } catch (err) {
      // 送信クリック前の失敗のみここに来る(クリック後は throw しない設計)
      if (store.get(rec.id).statuses.typeform === 'submitting') store.transitionTypeform(rec.id, 'failed');
      audit('typeform.result', { jobId: ctx.jobId, recordId: rec.id, outcome: 'failed', error: err.message });
      throw new Error(
        `Typeform 送信に失敗したため中断しました(${label} / 送信完了 ${result.sent}/${result.planned} 件)。` +
          `残りは未送信です。同じ Excel を再実行すると送信済みはスキップされます: ${err.message}`
      );
    }
    store.transitionTypeform(rec.id, res.outcome); // submitted | unknown
    audit('typeform.result', { jobId: ctx.jobId, recordId: rec.id, outcome: res.outcome });
    if (res.outcome === 'submitted') {
      store.setSnapshot(rec.id, { answers, detectedBy: res.detectedBy, submittedAt: new Date().toISOString() });
      result.sent += 1;
      continue;
    }
    // unknown: 到達を確定できないまま次を送ると二重送信のリスクがあるため中断する
    throw new Error(
      `申請の送達を確認できなかったため中断しました(${label} / 送信完了 ${result.sent}/${result.planned} 件)。` +
        '送信済み台帳の「送達不明」導線で到達を確認してから、同じ Excel を再実行してください'
    );
  }
  ctx.log(`Typeform 申請の送信が完了しました(${result.sent}/${result.planned} 件)`);
  return result;
}

// Excel取込からの月末一括: パース済みの作業実績表(唯一の情報源)を素通しで入力し、
// レバテック保存の成功後に Typeform 申請を逐次送信する。
// parsed は API 層で同期パース済み(失敗は 400 でジョブ自体が始まらない)。
// 受領した .xls はジョブの証跡として data/uploads/<jobId>.xls に保存する
export function startLevtechImport(runner, store, config, { parsed, buffer, manualUrl }) {
  const { month } = parsed;
  const days = toPlanDays(parsed.days);
  // 送信計画はジョブ開始前に組み立てる(ジョブは直列なので実行中に台帳は変わらない)
  const applications = buildSubmissionPlan(parsed.days, store.list());

  return runner.start('levtech-import', { month }, async (ctx) => {
    const uploadDir = path.join(DATA_DIR, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploadPath = path.join(uploadDir, `${ctx.jobId}.xls`);
    fs.writeFileSync(uploadPath, buffer);
    ctx.log(`Excel 読み取り OK: ${month}(実働合計 ${Math.floor(parsed.totalMinutes / 60)}:${String(parsed.totalMinutes % 60).padStart(2, '0')})。ファイルを保存: ${uploadPath}`);
    audit('levtech.import.upload', { jobId: ctx.jobId, month, path: uploadPath, bytes: buffer.length });
    ctx.log(
      `申請の照合: 送信予定 ${applications.planned.length} 件 / 送信済みスキップ ${applications.skipped.length} 件` +
        ` / ⚠食い違い ${applications.mismatched.length + applications.orphans.length} 件 / 対象外 ${applications.excluded.length} 件`
    );

    const { sendList, ...levtech } = await fillLevtechReport(ctx, store, config, {
      month,
      days,
      workHours: config.workHours, // 分類の判定基準(表示用)。送信値は Excel の F/G/H 素通し
      manualUrl,
      applications,
    });
    // ここでレバテック用ブラウザは閉じている。以降が不可逆パート(Typeform 送信)
    const typeform = await submitApplications(ctx, store, config, sendList);
    return { ...levtech, typeform };
  });
}

// Typeform のみ再実行(failed / none からの通常送信、unknown からの検証済み再送)
export function startTypeformRetry(runner, store, config, record) {
  return runner.start('typeform-retry', { recordId: record.id }, async (ctx) => {
    const answers = buildAnswers(record);
    audit('typeform.attempt', { jobId: ctx.jobId, recordId: record.id, answers });
    const res = await submitTypeform(config, answers, {
      ctx,
      onBeforeSubmit: async () => {
        store.transitionTypeform(record.id, 'submitting');
      },
    }).catch((err) => {
      const rec = store.get(record.id);
      if (rec.statuses.typeform === 'submitting') store.transitionTypeform(record.id, 'failed');
      audit('typeform.result', { jobId: ctx.jobId, recordId: record.id, outcome: 'failed', error: err.message });
      throw err;
    });
    store.transitionTypeform(record.id, res.outcome);
    if (res.outcome === 'submitted') {
      store.setSnapshot(record.id, { answers, detectedBy: res.detectedBy, submittedAt: new Date().toISOString() });
    }
    audit('typeform.result', { jobId: ctx.jobId, recordId: record.id, outcome: res.outcome });
    return { recordId: record.id, typeform: res.outcome };
  });
}

export { JobAbortedError };
