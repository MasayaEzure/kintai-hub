// 申請一覧の組み立てと送信済み台帳との照合(MVP_SPEC.md 月末一括化)。
// PoC 08-build-applications.mjs で検証した純粋ロジックの本実装+store 連携層。
//
// 変換ルール(2026-08-19 グリル確定・memory: excel-batch-typeform-design):
//   - 終日休暇 → お休み。暦日で連続する終日休暇のみ1件にまとめる
//     (土日祝は分類「休日」になるため、間に挟まると自動的に別件へ分かれる)
//   - 遅刻・午前休暇 → 遅参(開始時刻付き) / 早退・午後休暇 → 早帰り(終了時刻付き)
//   - 中抜け・⚠系(要確認/空欄平日)は申請対象外(一覧に理由付きで表示のみ)
//   - 理由は備考から推定: 「体調」を含めば「ご体調不良」、それ以外は「私用」(確認画面で修正可)
//   - 詳細欄はフォーム上任意のため空欄で送る。備考全文はプレビュー表示のみ
//   - 送信済み台帳と照合: 完全一致はスキップ / 同じ日に内容違いは⚠食い違い(送信しない)
//     台帳側にしかない日も⚠食い違い(取り消しは Typeform から手動連絡)
import { fmtMinutes } from './excel.mjs';
import { KIND_LABELS } from './store.mjs';

export const TYPE_TO_KIND = { 'お休み': 'vacation', '遅参': 'late', '早帰り': 'early' };
// 確認画面の理由セレクトの選択肢(Typeform の選択肢と一致させる)
export const REASONS = ['私用', 'ご体調不良', 'その他'];

// Typeform 日にち欄の表記。単日は '8/14'(実送信実績のある M/D)、期間はフォーム側の
// 記入ガイド「20YY/MM/DD〜20YY/MM/DD のようにご回答ください」に従う(ドライラン 2026-08-20 で確認)
const md = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
};
const ymd = (iso) => iso.replaceAll('-', '/');
export const dateText = (app) => (app.endDate ? `${ymd(app.date)}〜${ymd(app.endDate)}` : md(app.date));
const inferReason = (note) => (note.includes('体調') ? 'ご体調不良' : '私用');

// days(excel.mjs parseXls の分類済み配列)→ { apps, excluded }
export function buildApplications(days) {
  const apps = [];
  const excluded = []; // 申請対象外(⚠系・中抜け)。プレビュー表示用
  let run = null; // 連続する終日休暇の蓄積。days は暦日順なので「連続エントリ=連続暦日」

  const flush = () => {
    if (!run) return;
    const notes = [...new Set(run.notes.filter(Boolean))];
    apps.push({
      type: 'お休み',
      date: run.date,
      endDate: run.endDate,
      time: null,
      reason: inferReason(notes.join(' ')),
      detail: '',
      note: notes.join(' / '),
      contacted: 'はい',
    });
    run = null;
  };

  for (const day of days) {
    if (day.kind === '終日休暇') {
      if (run) {
        run.endDate = day.date;
        run.notes.push(day.note);
      } else {
        run = { date: day.date, endDate: null, notes: [day.note] };
      }
      continue;
    }
    flush(); // 終日休暇以外の日(休日含む)で連続が途切れる → 土日祝またぎは別件になる

    if (day.kind === '遅刻' || day.kind === '午前休暇') {
      apps.push({
        type: '遅参', date: day.date, endDate: null, time: fmtMinutes(day.start),
        reason: inferReason(day.note), detail: '', note: day.note, contacted: 'はい',
      });
    } else if (day.kind === '早退' || day.kind === '午後休暇') {
      apps.push({
        type: '早帰り', date: day.date, endDate: null, time: fmtMinutes(day.end),
        reason: inferReason(day.note), detail: '', note: day.note, contacted: 'はい',
      });
    } else if (day.kind === '中抜け') {
      excluded.push({ date: day.date, why: '中抜けは申請対象外(備忘メモ扱い)', note: day.note, warnings: day.warnings });
    } else if (day.kind.startsWith('⚠')) {
      excluded.push({ date: day.date, why: `${day.kind}のため申請対象外`, note: day.note, warnings: day.warnings });
    }
    // 通常・休日は申請なし
  }
  flush();
  return { apps, excluded };
}

// 台帳照合: apps を { toSend, skipped, mismatched } に振り分け、台帳孤児は orphans へ。
// 「送信済みの日付に重なる申請は、内容が違っても絶対に自動送信しない」が安全側の原則
export function reconcile(apps, ledger) {
  const expand = (e) => {
    const dates = [];
    const end = e.endDate ?? e.date;
    for (let d = new Date(`${e.date}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      dates.push(iso);
      if (iso === end) break;
      if (dates.length > 62) throw new Error(`期間が異常に長い: ${JSON.stringify(e)}`);
    }
    return dates;
  };

  const toSend = [];
  const skipped = [];
  const mismatched = [];
  const usedLedger = new Set();

  for (const app of apps) {
    const appDates = new Set(expand(app));
    const overlaps = ledger.filter((e) => expand(e).some((d) => appDates.has(d)));
    overlaps.forEach((e) => usedLedger.add(e));
    const exact = overlaps.find(
      (e) => e.type === app.type
        && e.date === app.date
        && (e.endDate ?? null) === (app.endDate ?? null)
        && (e.time ?? null) === (app.time ?? null)
    );
    // 完全一致でも他に重なる台帳エントリがあれば食い違いとして報告する(隠れた競合を skip で覆い隠さない)
    if (exact && overlaps.length === 1) skipped.push({ app, entry: exact });
    else if (overlaps.length > 0) mismatched.push({ app, entries: overlaps });
    else toSend.push(app);
  }
  const orphans = ledger.filter((e) => !usedLedger.has(e));
  return { toSend, skipped, mismatched, orphans };
}

// store の exceptions レコード → 台帳エントリ。
// sent: 送信済み扱い(submitted / submitting / unknown)。重なる申請は自動送信しない
// reusable: 未送信(none / failed)。同じ日を送り直すときは論理削除して作り直す対象
export function toLedger(records) {
  const sent = [];
  const reusable = [];
  for (const rec of records) {
    if (rec.cancelled) continue;
    const type = KIND_LABELS[rec.kind];
    if (!TYPE_TO_KIND[type]) continue; // 旧 custom 等、申請と対応しない過去レコードは台帳外
    const entry = {
      type,
      date: rec.date,
      endDate: rec.endDate ?? null,
      time: rec.time ?? null,
      status: rec.statuses.typeform,
      recordId: rec.id,
    };
    if (['submitted', 'submitting', 'unknown'].includes(rec.statuses.typeform)) sent.push(entry);
    else reusable.push(entry);
  }
  return { sent, reusable };
}

const overlapsRange = (a, b) => a.date <= (b.endDate ?? b.date) && b.date <= (a.endDate ?? a.date);

// 台帳照合の対象を月にスコープする。month は 'YYYY-MM'、月をまたぐ期間は重なりがあれば含める。
// 全期間を渡すと、過去月の送信済みが毎月 orphan(⚠食い違い)として警告に出続けてしまう
export function recordsOverlappingMonth(records, month) {
  const first = `${month}-01`;
  const last = `${month}-31`; // 文字列比較の上限(実在日である必要はない)
  return records.filter((r) => r.date <= last && first <= (r.endDate ?? r.date));
}

// Excel の days + store レコード → 送信計画(確認画面のプレビュー素材)
export function buildSubmissionPlan(days, records) {
  const { apps, excluded } = buildApplications(days);
  const { sent, reusable } = toLedger(records);
  const { toSend, skipped, mismatched, orphans } = reconcile(apps, sent);
  const planned = toSend.map((app, index) => ({
    index,
    ...app,
    dateText: dateText(app),
    staleRecordIds: reusable.filter((e) => overlapsRange(e, app)).map((e) => e.recordId),
  }));
  return { planned, skipped, mismatched, orphans, excluded };
}

// 確認画面の結果([{ index, reason, exclude }])を planned に適用して送信リストを確定する。
// 承認データが壊れている場合はレバテック入力前に throw して安全側で失敗させる
export function applyDecision(planned, decisionApps = []) {
  const byIndex = new Map();
  for (const d of decisionApps ?? []) {
    if (!Number.isInteger(d.index) || d.index < 0 || d.index >= planned.length) {
      throw new Error(`確認結果の index が不正です: ${JSON.stringify(d.index)}`);
    }
    if (d.reason != null && !REASONS.includes(d.reason)) {
      throw new Error(`確認結果の理由が不正です: ${JSON.stringify(d.reason)}`);
    }
    byIndex.set(d.index, d);
  }
  return planned
    .filter((app) => !byIndex.get(app.index)?.exclude)
    .map((app) => {
      const d = byIndex.get(app.index);
      return d?.reason ? { ...app, reason: d.reason } : app;
    });
}
