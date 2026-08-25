// Excel 取込アダプタ: 作業実績表(.xls BIFF8)を読み、日別の時刻と分類ラベルを返す。
// PoC 07-parse-excel.mjs で実証したロジックの本実装。
//
// 設計上の約束(グリル済み・memory: excel-import-design):
// - 実ファイルが唯一の情報源。例外日ストア/plan.mjs のストア参照とは連携しない
// - 分類ラベルは「プレビュー表示と警告制御」専用。送信値は F/G/H を素通しし、
//   分類結果による加工は一切しない
// - テンプレ改版(現 Ver 6_00)時は静かに壊れず ExcelParseError で大声で失敗する
// - 判定基準値は config.json の workHours が唯一の基準(実働基準は end−start−rest で導出)
import * as XLSX from 'xlsx';
import holidayJp from '@holiday-jp/holiday_jp';
import { toMinutes, pad2 } from './plan.mjs';

export const SHEET_NAME = '作業実績表（入力書式）';
export const DAY_ROW_START = 11; // 1日 = row11、31日 = row41 固定
// 備考(L列)の統制語彙。同義語リストは持たず「含むか」で照合(運用ルール)
export const KEYWORDS = ['終日休暇', '午前休暇', '午後休暇', '遅刻', '早退', '中抜け'];
const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// パース失敗(テンプレ不変条件違反・型異常・突合不一致)。API 層では 400 で返す
export class ExcelParseError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}:\n - ${problems.join('\n - ')}` : message);
    this.status = 400;
    this.code = 'excel-parse';
    this.problems = problems;
  }
}

// workHours('HH:MM')から判定基準(分)を導出する
export function deriveBase(workHours) {
  const start = toMinutes(workHours.start);
  const end = toMinutes(workHours.end);
  const rest = toMinutes(workHours.rest);
  if ([start, end, rest].some((v) => v === null || Number.isNaN(v))) {
    throw new ExcelParseError(`workHours が不正です: ${JSON.stringify(workHours)}`);
  }
  return { start, end, rest, work: end - start - rest };
}

// セル → 分。空欄(セル欠落・数式の "" キャッシュ)は null、時刻 0:00 は 0(厳密区別)。
// エラー型(#REF! 等)・想定外型は throw
export function cellToMinutes(cell, addr = '?') {
  if (cell === undefined) return null; // セルそのものが無い = 空欄
  if (cell.t === 'e') throw new ExcelParseError(`読み取り対象セル ${addr} がエラー型(#REF! 等)です`);
  if (cell.t === 's') {
    if (String(cell.v).trim() === '') return null; // 数式の "" キャッシュ
    const m = toMinutes(String(cell.v));
    if (m === null || Number.isNaN(m)) {
      throw new ExcelParseError(`セル ${addr} が時刻でない文字列です: ${JSON.stringify(cell.v)}`);
    }
    return m;
  }
  if (cell.t !== 'n') throw new ExcelParseError(`セル ${addr} が想定外の型(${cell.t})です`);
  return Math.round(cell.v * 1440); // シリアル値(1.0=24h) → 分。浮動小数の汚れは丸めで吸収
}

export const fmtMinutes = (min) => (min === null ? '' : `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`);
const excelSerial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;

// 分類(確定ルール): キーワードがラベルを決め、値条件は整合性チェック(⚠警告)に降格。
// day: { start, end, rest }(分 | null), note, dowLabel, holidayName
export function classify(day, base) {
  const { start, end, rest, note, dowLabel, holidayName } = day;
  const warnings = [];
  const empty = start === null && end === null && rest === null;
  const kws = KEYWORDS.filter((k) => note.includes(k));

  if (empty) {
    if (kws.includes('終日休暇')) return { kind: '終日休暇', warnings };
    if (holidayName) return { kind: '休日', warnings: [`祝日(${holidayName})`] };
    if (dowLabel === '土' || dowLabel === '日') return { kind: '休日', warnings };
    if (note.trim()) return { kind: '⚠要確認', warnings: [`空欄なのに備考あり: ${note}`] };
    return { kind: '⚠空欄平日', warnings: ['休暇か記入漏れか判別できません'] };
  }

  if (start === null || end === null) {
    return { kind: '⚠要確認', warnings: ['開始・終了の片方が空欄です'] };
  }
  if (rest === null) warnings.push('休憩が空欄(出勤日は必ず値が入る想定)');
  const actual = end - start - (rest ?? 0);

  if (kws.length > 1) warnings.push(`複数キーワード: ${kws.join('・')}`);
  const kw = kws[0];
  if (kw === '終日休暇') return { kind: '⚠要確認', warnings: ['終日休暇なのに時刻あり'] };
  if (kw === '午前休暇') {
    if (!(start >= 13 * 60)) warnings.push('整合⚠: 午前休暇なのに開始が13:00より前');
    if (rest !== 0) warnings.push('整合⚠: 午前休暇なのに休憩が0:00でない');
    return { kind: '午前休暇', warnings };
  }
  if (kw === '午後休暇') {
    if (!(end <= 12 * 60)) warnings.push('整合⚠: 午後休暇なのに終了が12:00より後');
    if (rest !== 0) warnings.push('整合⚠: 午後休暇なのに休憩が0:00でない');
    return { kind: '午後休暇', warnings };
  }
  if (kw === '遅刻') {
    if (!(start > base.start)) warnings.push(`整合⚠: 遅刻なのに開始が基準(${fmtMinutes(base.start)})以前`);
    return { kind: '遅刻', warnings };
  }
  if (kw === '早退') {
    if (!(end < base.end)) warnings.push(`整合⚠: 早退なのに終了が基準(${fmtMinutes(base.end)})以降`);
    return { kind: '早退', warnings };
  }
  if (kw === '中抜け') {
    if (!(rest > base.rest)) warnings.push(`整合⚠: 中抜けなのに休憩が基準(${fmtMinutes(base.rest)})以下`);
    return { kind: '中抜け', warnings };
  }
  if (note.trim()) return { kind: '⚠要確認', warnings: [...warnings, `語彙外の備考: ${note}`] };
  if (actual >= base.work) return { kind: '通常', warnings };
  return { kind: '⚠要確認', warnings: [...warnings, `実働 ${fmtMinutes(actual)} が基準(${fmtMinutes(base.work)})未満なのに備考なし`] };
}

// ワークブック(XLSX.read 済み)→ { month: 'YYYY-MM', year, monthNum, base, days }
// days[]: { date, label, dow, dowLabel, holidayName, start, end, rest(分|null), note, kind, warnings }
// 不変条件違反・丸め不一致・実働合計の突合不一致は全件集めて ExcelParseError で throw する
export function parseWorkbook(wb, workHours) {
  const base = deriveBase(workHours);
  const problems = [];

  if (!wb.SheetNames.includes(SHEET_NAME)) {
    throw new ExcelParseError(`シート「${SHEET_NAME}」がありません(存在: ${wb.SheetNames.join(', ')})`);
  }
  const ws = wb.Sheets[SHEET_NAME];
  const cell = (addr) => ws[addr];

  // ---- テンプレ不変条件: 年月セル・ヘッダラベル ----
  const yearCell = cell('D2');
  const monthCell = cell('F2');
  if (yearCell?.t !== 'n' || !Number.isInteger(yearCell.v) || yearCell.v < 2000 || yearCell.v > 2099) {
    problems.push(`D2(年)が想定外: ${JSON.stringify(yearCell?.v)}`);
  }
  if (monthCell?.t !== 'n' || !Number.isInteger(monthCell.v) || monthCell.v < 1 || monthCell.v > 12) {
    problems.push(`F2(月)が想定外: ${JSON.stringify(monthCell?.v)}`);
  }
  for (const [addr, expect] of [
    ['D8', '日'], ['E8', '曜日'], ['F9', '開始'], ['G9', '終了'],
    ['H8', '休憩時間'], ['I8', '実働時間'], ['I9', '実作業'],
  ]) {
    if (cell(addr)?.v !== expect) problems.push(`ヘッダ ${addr} が「${expect}」でない: ${JSON.stringify(cell(addr)?.v)}`);
  }
  if (!String(cell('L9')?.v ?? '').includes('備')) problems.push(`L9 が備考ヘッダでない: ${JSON.stringify(cell('L9')?.v)}`);

  // 年月が壊れていたら日行の解釈自体が無意味なので、ここまでの違反で即中断
  if (yearCell?.t !== 'n' || monthCell?.t !== 'n') {
    throw new ExcelParseError('テンプレ不変条件違反', problems);
  }
  const year = yearCell.v;
  const monthNum = monthCell.v;
  const daysInMonth = new Date(year, monthNum, 0).getDate();

  // ---- テンプレ不変条件: 日行(A列)の日付整合と余剰行 ----
  for (let d = 1; d <= daysInMonth; d++) {
    const a = cell(`A${DAY_ROW_START - 1 + d}`);
    if (a?.t !== 'n' || a.v !== excelSerial(year, monthNum, d)) {
      problems.push(`A${DAY_ROW_START - 1 + d} の日付が ${year}/${monthNum}/${d} と不一致: ${JSON.stringify(a?.v)}`);
    }
  }
  for (let d = daysInMonth + 1; d <= 31; d++) {
    const dd = cell(`D${DAY_ROW_START - 1 + d}`);
    if (dd !== undefined && dd.t === 'n') problems.push(`余剰行 D${DAY_ROW_START - 1 + d} に日付が残っています`);
  }

  // ---- 日別抽出: 丸め結果を Excel 自身の表示文字列(w)と全数突合しながら読む ----
  const readTime = (addr) => {
    let min;
    try {
      min = cellToMinutes(cell(addr), addr);
    } catch (err) {
      problems.push(err.message);
      return null;
    }
    const c = cell(addr);
    if (c?.t === 'n' && min !== null) {
      const w = String(c.w ?? '').trim();
      if (!w) {
        // w が無いのは表示との突合ができないだけで、丸め不一致とは別の問題として報告する
        problems.push(`${addr}: Excel 表示文字列(w)が無いため丸め結果と突合できません`);
      } else {
        // 表示形式が h:mm:ss の場合も値が同じなら一致とみなす(秒を落として比較)
        const wMin = toMinutes(w.replace(/^(\d{1,2}:[0-5]\d):[0-5]\d$/, '$1'));
        if (wMin !== min) problems.push(`${addr}: 丸め=${fmtMinutes(min)} が Excel 表示=${JSON.stringify(c.w)} と不一致`);
      }
    }
    return min;
  };

  const holidays = new Map(
    holidayJp
      .between(new Date(year, monthNum - 1, 1), new Date(year, monthNum - 1, daysInMonth))
      .map((h) => [h.date.toISOString().slice(0, 10), h.name])
  );

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const r = DAY_ROW_START - 1 + d;
    const date = `${year}-${pad2(monthNum)}-${pad2(d)}`;
    const dow = new Date(year, monthNum - 1, d).getDay();
    const day = {
      date,
      label: `${pad2(monthNum)}/${pad2(d)}`,
      dow,
      dowLabel: DOW_LABELS[dow],
      holidayName: holidays.get(date) ?? null,
      start: readTime(`F${r}`),
      end: readTime(`G${r}`),
      rest: readTime(`H${r}`),
      note: String(cell(`L${r}`)?.v ?? '').trim(),
    };
    Object.assign(day, classify(day, base));
    days.push(day);
  }

  // ---- 月間実働合計をファイル自身の集計セル N43 (=SUM(N11:N41)) と突合 ----
  const derived = days.reduce(
    (sum, day) => sum + (day.start !== null && day.end !== null ? day.end - day.start - (day.rest ?? 0) : 0),
    0
  );
  let n43 = null;
  try {
    n43 = cellToMinutes(cell('N43'), 'N43');
  } catch (err) {
    problems.push(err.message);
  }
  if (derived !== n43) {
    problems.push(`月間実働合計の突合不一致: 導出=${fmtMinutes(derived)} / ファイル集計(N43)=${fmtMinutes(n43)}(古い計算キャッシュの可能性)`);
  }

  if (problems.length > 0) {
    throw new ExcelParseError('作業実績表のパースに失敗しました', problems);
  }
  return { month: `${year}-${pad2(monthNum)}`, year, monthNum, base, days, totalMinutes: derived };
}

// .xls バッファ → parseWorkbook。読めないバイナリも ExcelParseError に正規化する
export function parseXls(buffer, workHours) {
  let wb;
  try {
    wb = XLSX.read(buffer, { cellNF: true });
  } catch (err) {
    throw new ExcelParseError(`Excel ファイルとして読み込めませんでした: ${err.message}`);
  }
  return parseWorkbook(wb, workHours);
}

// パース結果 → レバテック入力フロー(scrapeRows/classifyRows/applyRows)が期待する
// 計画 day 形式へ変換する。送信値は F/G/H を素通し(分類結果による加工はしない)。
// 分類ラベルと警告は excelKind / warnings としてプレビュー専用に添える
export function toPlanDays(days) {
  return days.map((day) => ({
    date: day.date,
    label: day.label,
    dow: day.dow,
    dowLabel: day.dowLabel,
    expected: {
      start: fmtMinutes(day.start),
      end: fmtMinutes(day.end),
      rest: fmtMinutes(day.rest),
    },
    note: day.note,
    kind: null,
    recordId: null,
    unsubmitted: false,
    excelKind: day.kind,
    warnings: day.warnings,
  }));
}
