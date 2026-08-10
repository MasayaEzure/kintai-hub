// フロー本体(ジョブとして実行される一連の手順)。
// フロー①: 月末勤怠入力(F1) / フロー②: 例外日の申請・登録(F2)/ 取り消し(§3-2)
import { audit } from './audit.mjs';
import { buildMonthPlan } from './plan.mjs';
import {
  withLevtech,
  assertSession,
  resolveReportId,
  assertMonthMatches,
  scrapeRows,
  classifyRows,
  applyRows,
  finalExpectedState,
  verifyAgainst,
  saveAndAssert,
  summarize,
} from './adapters/levtech.mjs';
import { submitTypeform, buildAnswers } from './adapters/typeform.mjs';
import { registerRecordToCalendar } from './adapters/calendar.mjs';
import { JobAbortedError } from './jobs.mjs';

// ---- フロー①: 月末勤怠入力 -------------------------------------------------
// スキャン → プレビュー(確認待ち)→ 承認された入力のみ反映 → 再スクレイプ突合 → 保存アサート
export function startLevtechFill(runner, store, config, { month, workHours, manualUrl }) {
  const plan = buildMonthPlan(month, workHours, store); // ここで month / ストアの検証も済む

  return runner.start('levtech-fill', { month }, async (ctx) => {
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
      const existing = await scrapeRows(page, inputUrl, plan.days);
      const rows = classifyRows(plan.days, existing);
      await ctx.screenshot(page, '01-scan');

      const counts = {
        fill: rows.filter((r) => r.action === 'fill').length,
        match: rows.filter((r) => r.action === 'match').length,
        mismatch: rows.filter((r) => r.action === 'mismatch').length,
      };
      ctx.log(`スキャン完了: 入力予定 ${counts.fill} 日 / 一致 ${counts.match} 日 / 不一致 ${counts.mismatch} 日`);

      if (counts.fill === 0 && counts.mismatch === 0) {
        ctx.log('入力・変更が必要な行はありません。保存せずに終了します');
        return { month, saved: false, message: '変更なし(すべて入力済み・一致)', counts };
      }

      // 確認待ち: 不一致は UI で赤字表示され、承認された行のみ上書きされる(F1 手順5)
      const decision = await ctx.waitConfirmation({
        kind: 'levtech-plan',
        month,
        workHours,
        counts,
        rows: rows.map(({ date, label, dowLabel, note, expected, existing, action, unsubmitted }) => ({
          date, label, dowLabel, note, expected, existing, action, unsubmitted,
        })),
      });
      const approvedDates = decision.approvedDates ?? [];
      ctx.log(`承認されました(上書き承認 ${approvedDates.length} 件)。入力を開始します`);

      const applied = await applyRows(page, rows, approvedDates);
      ctx.log(`${applied.length} 行を入力しました`);
      await ctx.screenshot(page, '02-after-fill');

      ctx.log('保存前の最終突合: 全行を再スクレイプして計画と比較します');
      const finalRows = finalExpectedState(rows, approvedDates);
      const rescraped = await scrapeRows(page, inputUrl, plan.days);
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
      return { month, saved: true, counts, applied: applied.length, summary };
    });
  });
}

// ---- フロー②: 例外日の申請・登録 --------------------------------------------
// 逐次実行: まずカレンダー登録(可逆・冪等)、次に Typeform 送信(write-ahead)。
// 片方失敗でも続行し、バッジで可視化する(F2)。
export function startRequestFlow(runner, store, config, record) {
  return runner.start('request', { recordId: record.id, date: record.date, kind: record.kind }, async (ctx) => {
    ctx.log(`例外日 ${record.date}(${record.kind})の申請・登録を開始`);

    ctx.log('1/2: カレンダー登録(冪等・失敗しても申請は続行)');
    const cal = await registerRecordToCalendar(config, store, record, ctx.log);

    ctx.log('2/2: Typeform 申請の送信');
    const answers = buildAnswers(record);
    audit('typeform.attempt', { jobId: ctx.jobId, recordId: record.id, answers });
    let tf;
    try {
      const res = await submitTypeform(config, answers, {
        ctx,
        onBeforeSubmit: async () => {
          store.transitionTypeform(record.id, 'submitting'); // write-ahead(§3-3)
        },
      });
      store.transitionTypeform(record.id, res.outcome); // submitted | unknown
      if (res.outcome === 'submitted') {
        store.setSnapshot(record.id, { answers, detectedBy: res.detectedBy, submittedAt: new Date().toISOString() });
      }
      audit('typeform.result', { jobId: ctx.jobId, recordId: record.id, outcome: res.outcome });
      tf = res.outcome;
    } catch (err) {
      // 送信クリック前の失敗のみここに来る(クリック後は throw しない設計)
      const rec = store.get(record.id);
      if (rec.statuses.typeform === 'submitting') store.transitionTypeform(record.id, 'failed');
      audit('typeform.result', { jobId: ctx.jobId, recordId: record.id, outcome: 'failed', error: err.message });
      ctx.log(`Typeform 送信に失敗: ${err.message}`);
      tf = 'failed';
    }

    const ok = tf === 'submitted' && cal.status === 'registered';
    ctx.log(ok ? '申請・登録が完了しました' : '一部が未完了です。一覧のバッジから再実行できます');
    return { recordId: record.id, calendar: cal.status, typeform: tf };
  });
}

// Typeform のみ再実行(failed からの通常再実行 / unknown からの検証済み再送)
export function startTypeformRetry(runner, store, config, record, { target = 'request' } = {}) {
  return runner.start('typeform-retry', { recordId: record.id, target }, async (ctx) => {
    const answers = buildAnswers(record, { cancellation: target === 'cancellation' });
    audit('typeform.attempt', { jobId: ctx.jobId, recordId: record.id, target, answers });
    const res = await submitTypeform(config, answers, {
      ctx,
      screenshotPrefix: target === 'cancellation' ? 'cancel' : 'typeform',
      onBeforeSubmit: async () => {
        store.transitionTypeform(record.id, 'submitting', { target });
      },
    }).catch((err) => {
      const rec = store.get(record.id);
      const holder = target === 'cancellation' ? rec.cancellation : rec.statuses;
      if (holder.typeform === 'submitting') store.transitionTypeform(record.id, 'failed', { target });
      audit('typeform.result', { jobId: ctx.jobId, recordId: record.id, target, outcome: 'failed', error: err.message });
      throw err;
    });
    store.transitionTypeform(record.id, res.outcome, { target });
    if (res.outcome === 'submitted') {
      store.setSnapshot(record.id, { answers, detectedBy: res.detectedBy, submittedAt: new Date().toISOString() }, { target });
      if (target === 'cancellation') store.markCancelled(record.id);
    }
    audit('typeform.result', { jobId: ctx.jobId, recordId: record.id, target, outcome: res.outcome });
    return { recordId: record.id, target, typeform: res.outcome };
  });
}

// 取り消しフロー(§3-2): 取り消し申請の送信 → cancelled 化。カレンダーは手動削除を案内
export function startCancellationFlow(runner, store, config, record, detail) {
  store.beginCancellation(record, detail);
  return startTypeformRetry(runner, store, config, record, { target: 'cancellation' });
}

export { JobAbortedError };
