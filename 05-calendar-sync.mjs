// PoC ステップ5: Google カレンダーへの休暇予定登録(ローカル → GAS Web App)
//
// デフォルトはドライラン(GAS 側は登録せず「作る予定の一覧」だけ返す)。
// --commit を付けたときだけ実登録する。予定は消せる(manualDeleteAll)ので
// Typeform より低リスクだが、流儀としてドライラン優先を踏襲。
//
// 事前準備(初回のみ): gas/Code.gs 冒頭のセットアップ手順に従って GAS をデプロイし、
// calendar.config.json に webAppUrl を設定する。
//
// 実行例:
//   npm run calendar             (ドライラン)
//   npm run calendar -- --commit (実登録)
import fs from 'node:fs';

const COMMIT = process.argv.includes('--commit');

// 「どうせ登録する正しい値を入れる」方式: --commit で本登録する前に、
// 実際に予定している例外日へ書き換えること。
const EXCEPTIONS = [
  { date: '2026-08-10', kind: 'vacation' }, // 夏季休暇(Typeform 申請済み 2026-08-10)
];

// ---- 設定読み込み ----
let config;
try {
  config = JSON.parse(fs.readFileSync(new URL('./calendar.config.json', import.meta.url), 'utf8'));
} catch {
  console.error('calendar.config.json が読めません。calendar.config.example.json をコピーして作成してください。');
  process.exit(1);
}
if (!config.webAppUrl || !config.webAppUrl.startsWith('https://script.google.com/')) {
  console.error('calendar.config.json の webAppUrl に GAS Web App の URL(…/exec)を設定してください。');
  console.error('デプロイ手順は gas/Code.gs 冒頭のコメント参照。');
  process.exit(1);
}

// ---- GAS Web App へ POST ----
const payload = { secret: config.sharedSecret, dryRun: !COMMIT, events: EXCEPTIONS };
// Content-Type は text/plain にする(GAS の定番。ブラウザから叩く将来構成でも CORS preflight を踏まない)
const res = await fetch(config.webAppUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify(payload),
  redirect: 'follow', // GAS は 302 で script.googleusercontent.com に飛ばすため必須
});
const text = await res.text();

let data;
try {
  data = JSON.parse(text);
} catch {
  console.error('JSON 以外の応答が返りました。デプロイ設定を確認してください:');
  console.error('- 「アクセスできるユーザー: 全員」になっているか(ログイン画面の HTML が返る典型パターン)');
  console.error('- コード修正後に「新バージョン」で再デプロイしたか');
  console.error('--- 応答冒頭 ---');
  console.error(text.slice(0, 300));
  process.exit(1);
}

if (!data.ok) {
  console.error('GAS 側エラー:', data.error);
  process.exit(1);
}

console.log(`モード: ${data.dryRun ? 'ドライラン(登録なし)' : '実登録'}`);
console.log(`カレンダー: ${data.calendar}`);
console.log(`GAS タイムゾーン: ${data.timeZone}`);
if (data.timeZone !== 'Asia/Tokyo') {
  console.warn('⚠ タイムゾーンが Asia/Tokyo ではありません。日付が1日ずれる恐れがあります(gas/appsscript.json 参照)');
}
console.log('---');
for (const r of data.results) {
  const detail = [r.title, r.time].filter(Boolean).join(' ');
  console.log(`  ${r.date} [${r.kind}] ${r.status}${detail ? `: ${detail}` : ''}${r.error ? `: ${r.error}` : ''}`);
}
