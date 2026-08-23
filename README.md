# kintai-hub

作業実績表(Excel)を唯一の情報源として、毎月末のレバテック勤怠入力と Typeform の休暇等申請を、Excel ドロップ→確認→承認の一操作でまとめて実行するツール。

- 仕様: [MVP_SPEC.md](MVP_SPEC.md)(v2)
- PoC の経緯・技術検証の記録: [POC_STORY.md](POC_STORY.md)

## 起動(MVP)

```
npm install
npm start   # → http://127.0.0.1:5678/
```

- 初回起動時に `config.json`(Git 管理外)が自動生成される。`typeform.personalId`(ENG…)を設定すること。
  旧構成から更新した場合、`config.json` に残った `calendar` ブロックは不要(残っていても無害。手で消してよい)
- レバテックのセッションは `./profile` に保存される。切れている場合は UI のログイン導線から回復する(素の Chrome + mock keychain で手動 SSO → Cmd+Q → 自動再チェック)

## 月末一括の流れ

1. 作業実績表(.xls)を UI へドラッグ&ドロップ(年月は D2/F2 から自動判定)
2. 確認画面: レバテック入力プレビュー(不一致は個別承認)と Typeform 申請一覧(理由の修正・送信除外可)を 1 回の承認でまとめて確認
3. レバテック入力・保存(可逆を先)→ 成功したら Typeform 申請を 1 件ずつ送信(不可逆を後)
4. 送信は「送信済み台帳」(store.json)に記録され、再実行時は送信済みを自動スキップ。台帳と Excel の食い違いは⚠警告のみ(自動送信しない。取り消しの連絡は Typeform を手動で開いて送る)
5. Typeform の途中失敗はそこで中断。同じ Excel を再実行すると残りだけ送られる

## 構成

```
src/
  server.mjs        … Express(127.0.0.1 bind・トークン・Origin 検証)
  store.mjs         … 送信済み台帳(JSON・原子的書き込み・世代バックアップ・状態遷移)
  applications.mjs  … Excel 分類 → Typeform 申請一覧の変換と台帳照合(PoC 08 移植)
  plan.mjs          … 時刻ユーティリティ・対象月の既定値
  excel.mjs         … 作業実績表(.xls)のパースと分類(PoC 07 移植)
  jobs.mjs          … 直列ジョブ実行(同時1件・確認待ち中断つき)
  flows.mjs         … 月末一括フロー(レバテック入力 → Typeform 逐次送信)/ 単体再送
  login.mjs         … セッション切れ回復の導線
  adapters/
    levtech.mjs     … Playwright(PoC 03/06 流用)
    typeform.mjs    … Playwright(PoC 04/09 流用・write-ahead 送信)
public/             … UI(素の HTML/JS + Tailwind Play CDN)
data/               … ストア・監査ログ・バックアップ(Git 管理外)
poc/                … PoC スクリプト(検証完了・参照用。npm scripts からルートで実行する前提)
mockup/             … UI モック(v0 / Next.js。見た目の参照元)
gas/                … 旧カレンダー連携の GAS Web App(機能は廃止済み。控えとして残置)
```

## 安全設計の要点

- レバテック保存前に必ずプレビュー承認(不一致行は個別承認のみ上書き)、保存後は「更新しました。」をアサート
- Typeform 送信はレバテック保存の成功後のみ(可逆を先・不可逆を後)。送信クリック前に `submitting` を永続化(write-ahead)し、完了画面検出で `submitted`。検出不能は `unknown` として到達確認チェック付きの導線でのみ解決
- 送信済み台帳との照合で二重申請を構造的に防止(日付が重なる申請は内容が違っても自動送信しない)
- 月次の「報告する」(請求提出)は自動化しない

## 初回本番チェックリスト(未実証項目)

- レバテック: 端数時刻(21:15、休憩 2:00 等)が保存時に受理されるか
- Typeform: 期間指定書式 `2026/08/12〜2026/08/13` の実送信受理と完了画面検出 / 複数件連続の実送信
