// PoC ステップ5: 作業実績表 → Typeform 申請一覧の変換ロジック検証 CLI。
// パース・分類は src/excel.mjs(検証済み)に任せ、ここでは
// 「分類結果 → 送るはずの申請一覧」の変換と送信済み台帳との照合だけを検証する。
// 画面もフォーム操作もなし。送信は一切しない。
//
// 変換ルール(2026-08-19 グリル確定・memory: excel-batch-typeform-design):
//   - 終日休暇 → お休み。暦日で連続する終日休暇のみ1件にまとめる
//     (土日祝は分類「休日」になるため、間に挟まると自動的に別件へ分かれる)
//   - 遅刻・午前休暇 → 遅参(開始時刻付き) / 早退・午後休暇 → 早帰り(終了時刻付き)
//   - 中抜け・⚠系(要確認/空欄平日)は申請対象外(一覧に理由付きで表示のみ)
//   - 理由は備考から推定: 「体調」を含めば「ご体調不良」、それ以外は「私用」
//     参画先企業へ連絡済み=「はい」(いずれも本実装では確認画面で修正可)
//   - 詳細欄はフォーム上任意のため空欄で送る。備考全文はプレビュー表示のみ(2026-08-20 決定)
//   - 送信済み台帳と照合: 完全一致はスキップ / 同じ日に内容違いは⚠食い違い(送信しない)
//     台帳側にしかない日も⚠食い違い(取り消しは手動対応)
//
// 実行: npm run build-apps                         (既定: ダミー8月ファイル)
//       npm run build-apps -- <xlsパス>
//       npm run build-apps -- <xlsパス> --ledger <台帳JSONパス>
// 台帳 JSON: [{ "type": "お休み|遅参|早帰り", "date": "YYYY-MM-DD",
//               "endDate": "YYYY-MM-DD"|null, "time": "HH:MM"|null }, ...]
import fs from 'node:fs';
import { parseXls, fmtMinutes, ExcelParseError } from '../src/excel.mjs';

const args = process.argv.slice(2);
const ledgerIdx = args.indexOf('--ledger');
const ledgerPath = ledgerIdx !== -1 ? args[ledgerIdx + 1] : null;
const filePath = args.find((a, i) => !a.startsWith('--') && (ledgerIdx === -1 || i !== ledgerIdx + 1))
  ?? 'data/samples/Poc検証用ダミーファイル_8月.XLS';

if (!fs.existsSync(filePath)) {
  console.error(`ファイルが見つかりません: ${filePath}`);
  process.exit(1);
}

let workHours = { start: '09:00', end: '18:00', rest: '01:00' };
try {
  workHours = { ...workHours, ...JSON.parse(fs.readFileSync('./config.json', 'utf8')).workHours };
} catch {
  console.log('config.json を読めないため既定の基準値(09:00-18:00 休憩01:00)を使います');
}

// ---- 変換本体(本実装へ移植する予定のロジック) ----

// Typeform 日にち欄の表記。単日は '8/14'(実送信実績のある M/D)、期間はフォーム側の
// 記入ガイド「20YY/MM/DD〜20YY/MM/DD のようにご回答ください」に従う(ドライラン 2026-08-20 で確認)
const md = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
};
const ymd = (iso) => iso.replaceAll('-', '/');
const dateText = (app) => (app.endDate ? `${ymd(app.date)}〜${ymd(app.endDate)}` : md(app.date));
const inferReason = (note) => (note.includes('体調') ? 'ご体調不良' : '私用');

// days(excel.mjs の分類済み配列)→ { apps, excluded }
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
    if (exact) skipped.push({ app, entry: exact });
    else if (overlaps.length > 0) mismatched.push({ app, entries: overlaps });
    else toSend.push(app);
  }
  const orphans = ledger.filter((e) => !usedLedger.has(e));
  return { toSend, skipped, mismatched, orphans };
}

// ---- CLI 表示 ----
const fmtApp = (a) =>
  `${dateText(a).padEnd(10)} ${a.type.padEnd(4)} ${(a.time ?? '—').padEnd(6)} 理由=${a.reason} 詳細=空欄 連絡済み=${a.contacted} (備考: ${a.note || 'なし'})`;
const fmtEntry = (e) =>
  `${e.date}${e.endDate ? `〜${e.endDate}` : ''} ${e.type}${e.time ? ` ${e.time}` : ''}`;

console.log(`入力: ${filePath}`);
let parsed;
try {
  parsed = parseXls(fs.readFileSync(filePath), workHours);
} catch (err) {
  if (err instanceof ExcelParseError) {
    console.error(`FAIL パース失敗:\n${err.message}`);
    process.exit(1);
  }
  throw err;
}
console.log(`年月: ${parsed.month} / 実働合計: ${fmtMinutes(parsed.totalMinutes)}(N43 突合済み)`);

const { apps, excluded } = buildApplications(parsed.days);

console.log(`\n■ 申請一覧(${apps.length}件)`);
for (const a of apps) console.log(`  ${fmtApp(a)}`);

console.log(`\n■ 申請対象外(${excluded.length}件)`);
for (const x of excluded) {
  console.log(`  ${md(x.date).padEnd(6)} ${x.why} ${x.note ? `備考=${x.note}` : ''}${x.warnings.length ? ` / ${x.warnings.join(' / ')}` : ''}`);
}

if (ledgerPath) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  console.log(`\n台帳: ${ledgerPath}(${ledger.length}件)と照合`);
  const { toSend, skipped, mismatched, orphans } = reconcile(apps, ledger);

  console.log(`\n■ 送信する申請(${toSend.length}件)`);
  for (const a of toSend) console.log(`  ${fmtApp(a)}`);

  console.log(`\n■ 送信済みスキップ(${skipped.length}件)`);
  for (const s of skipped) console.log(`  ${fmtApp(s.app)}  ← 台帳 ${fmtEntry(s.entry)}`);

  console.log(`\n■ ⚠食い違い — 送信しません。取り消しの連絡は Typeform から手動で(${mismatched.length}件)`);
  for (const m of mismatched) {
    console.log(`  Excel: ${fmtApp(m.app)}`);
    for (const e of m.entries) console.log(`    ≠ 送信済み: ${fmtEntry(e)}`);
  }

  console.log(`\n■ ⚠食い違い — 送信済みだが Excel に見当たらない日(${orphans.length}件)`);
  for (const e of orphans) console.log(`  ${fmtEntry(e)}(Excel 側で消えたか内容が変わっています)`);
}
