// PoC ステップ1(改): 初回の手動ログイン + セッション保存
//
// Google は自動化制御下のブラウザからの SSO ログインを拒否するため、
// ログインだけは「自動化フラグなしの素の Chrome」で同じプロファイルを開いて行う。
// ここで保存されたセッション Cookie を、以降の Playwright(check / fill)が使い回す。
//
// 実行: npm run login
//   1. 起動した Chrome で「Googleでログイン」から手動ログイン
//   2. 「契約」>「作業報告」の画面まで到達できることを確認
//   3. Chrome を完全終了(Cmd+Q)する → プロファイルが保存される
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profileDir = path.resolve('./profile');

console.log('');
console.log('自動化フラグなしの Chrome を起動します(普段の Chrome とは別プロファイル)。');
console.log('手動でログインし、作業報告の画面まで到達したら Chrome を完全終了(Cmd+Q)してください。');
console.log('');

const proc = spawn(
  CHROME,
  [
    `--user-data-dir=${profileDir}`,
    // Playwright は Chrome をモックキーチェーン(--use-mock-keychain)で起動するため、
    // ログイン側も同じ鍵で Cookie を暗号化しないと Playwright がセッションを復号できない
    '--use-mock-keychain',
    '--no-first-run',
    '--no-default-browser-check',
    'https://platform.levtech.jp/p/',
  ],
  { stdio: 'ignore' },
);

proc.on('exit', () => {
  console.log('Chrome が終了しました。セッションは ./profile に保存されています。');
  console.log('次: `npm run check`(できれば翌日)で、再ログインなしに入れるか=仮説1を検証してください。');
});
