# kintai-hub

毎月末の勤怠入力、Typeform の休暇申請、Google カレンダーへの休暇予定登録の3つを一つの画面 UI から登録できるツール。

- 仕様: [MVP_SPEC.md](MVP_SPEC.md)(v2)
- PoC の経緯・技術検証の記録: [POC_STORY.md](POC_STORY.md)

## 起動(MVP)

```
npm install
npm start   # → http://127.0.0.1:5678/
```

- 初回起動時に `config.json`(Git 管理外)が自動生成される。`typeform.personalId`(ENG…)と GAS の設定を確認すること(既存の `calendar.config.json` があれば GAS 設定は自動で引き継がれる)
- レバテックのセッションは `./profile` に保存される。切れている場合は UI のログイン導線から回復する(素の Chrome + mock keychain で手動 SSO → Cmd+Q → 自動再チェック)

## 構成

```
src/
  server.mjs       … Express(127.0.0.1 bind・トークン・Origin 検証)
  store.mjs        … 例外日ストア(JSON・原子的書き込み・世代バックアップ・状態遷移)
  plan.mjs         … 祝日判定と「例外日 → レバテック入力値」変換表(仕様 §5)
  jobs.mjs         … 直列ジョブ実行(同時1件・確認待ち中断つき)
  flows.mjs        … フロー①(月末勤怠入力)/ フロー②(申請・登録)/ 取り消し
  login.mjs        … セッション切れ回復の導線
  adapters/
    levtech.mjs    … Playwright(PoC 03/06 流用)
    typeform.mjs   … Playwright(PoC 04 流用・write-ahead 送信)
    calendar.mjs   … GAS Web App への HTTP POST(PoC 05 流用)
public/            … UI(素の HTML/JS + Tailwind Play CDN)
data/              … ストア・監査ログ・バックアップ(Git 管理外)
0X-*.mjs           … PoC スクリプト(検証完了・参照用)
mockup/            … UI モック(v0 / Next.js。見た目の参照元)
gas/               … GAS Web App(デプロイ済みの本番資産)
```

## 安全設計の要点

- レバテック保存前に必ずプレビュー承認(不一致行は個別承認のみ上書き)、保存後は「更新しました。」をアサート
- Typeform は送信クリック前に `submitting` を永続化(write-ahead)し、完了画面検出で `submitted`。検出不能は `unknown` として到達確認チェック付きの導線でのみ解決
- 月次の「報告する」(請求提出)は自動化しない
