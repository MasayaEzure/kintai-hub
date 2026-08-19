// 作業実績表(.xls)パースの目視確認 CLI。本体は src/excel.mjs(本実装のアダプタ)。
// テンプレ不変条件・丸め全数突合・実働合計突合はアダプタ内で検証され、違反時は
// ExcelParseError で失敗する(exit 1)。ここでは分類テーブルを表示するだけ。
//
// 実行: npm run parse-excel            (既定: data/samples/作業実績表_202607.xls)
//       npm run parse-excel -- <path>  (任意の .xls を指定)
import fs from 'node:fs';
import path from 'node:path';
import { parseXls, fmtMinutes, ExcelParseError } from '../src/excel.mjs';
import { pad2 } from '../src/plan.mjs';

const filePath = process.argv[2] ?? path.join('data', 'samples', '作業実績表_202607.xls');
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

const { year, monthNum, base, days, totalMinutes } = parsed;
console.log(`\n年月: ${year}年${monthNum}月 (${days.length}日) / 基準: ${fmtMinutes(base.start)}-${fmtMinutes(base.end)} 休憩${fmtMinutes(base.rest)} 実働${fmtMinutes(base.work)}\n`);
console.log('日付   曜 開始  終了  休憩  判定       備考・警告');
for (const day of days) {
  console.log([
    day.label,
    day.dowLabel,
    fmtMinutes(day.start).padEnd(5),
    fmtMinutes(day.end).padEnd(5),
    fmtMinutes(day.rest).padEnd(5),
    day.kind.padEnd(5),
    [day.note, ...day.warnings].filter(Boolean).join(' / '),
  ].join('  '));
}

const counts = {};
for (const day of days) counts[day.kind] = (counts[day.kind] ?? 0) + 1;
console.log(`\n判定内訳: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' / ')}`);
console.log(`月間実働合計: ${fmtMinutes(totalMinutes)}(ファイル集計 N43 と一致を検証済み)`);

fs.mkdirSync('output', { recursive: true });
const outPath = path.join('output', `parse-excel-${year}${pad2(monthNum)}.json`);
fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
console.log(`JSON 出力: ${outPath}`);
