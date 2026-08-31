# kintai-hub

作業実績表(Excel)を唯一の情報源として、毎月末のレバテック勤怠入力と Typeform の休暇等申請を、Excel ドロップ→確認→承認の一操作でまとめて実行するツール。

- 仕様: [MVP_SPEC.md](docs/specs/MVP_SPEC.md)(v2)
- PoC の経緯・技術検証の記録: [POC_STORY.md](docs/history/POC_STORY.md)

2026-08 分で初の本番実行を完了(レバテック 16 日・143:15 保存、Typeform 3 件送信。端数時刻・期間指定申請・複数件連続送信とも実証済み)。

## 起動

ふだんの月末は `kintai-hub.command` をダブルクリックするだけ(サーバー起動 → ブラウザが開く)。
終了はターミナルのウィンドウを閉じる(サーバーも一緒に終了する)。
デスクトップに置きたい場合は Finder エイリアスを作成すること(シンボリックリンクは不可)。
起動済みのときにもう一度ダブルクリックすると、ブラウザを開き直すだけ。

コマンドラインから起動する場合:

```text
npm install
npm start   # → http://127.0.0.1:<port>/ (port の既定値は 5678)
```

- 初回起動時に `config.json`(Git 管理外)が自動生成される。`typeform.personalId`(ENG…)を設定すること
- レバテックのセッションは `./profile` に保存される。切れている場合は UI のログイン導線から回復する(素の Chrome + mock keychain で手動 SSO → Cmd+Q → 自動再チェック)

## 月末一括の流れ

画面は「1 ファイル選択 → 2 内容確認 → 3 実行」の 3 ステップで現在地を表示する。

1. **ファイル選択**: 作業実績表(.xls)を「Excelファイルを選択」またはドラッグ&ドロップで投入(年月は D2/F2 から自動判定)。入力先 URL は一覧から自動解決され、失敗した場合のみ折りたたみの「入力先URLを指定」から手動指定できる
2. **内容確認**: レバテック入力プレビュー(不一致は個別承認)と Typeform 申請一覧(理由の修正・送信除外可)を 1 回の承認でまとめて確認
3. **実行**: レバテック入力・保存(可逆を先)→ 成功したら Typeform 申請を 1 件ずつ送信(不可逆を後)
4. 送信結果は画面下部の「申請履歴」(内部名: 送信済み台帳 = store.json)に記録され、再実行時は送信済みを自動スキップ。台帳と Excel の食い違いは⚠警告のみ(自動送信しない。取り消しの連絡は Typeform を手動で開いて送る)
5. Typeform の途中失敗はそこで中断。同じ Excel を再実行すると残りだけ送られる

### レバテック入力の突合ルール

- 画面が空欄の日 → Excel の値を入力
- 記入済みで Excel と完全一致 → スキップ(何も書かない)
- 記入済みで Excel と不一致 → 既定は現状維持。プレビューで承認した日だけ上書き

### 制限事項

- 暗号化パスワード付きの .xls は読み取れない(SheetJS が RC4 暗号化に非対応)。パスワードを解除した複製を作ってから投入すること。パスワード付き ZIP で届いた場合は、解凍すれば中の .xls はそのまま使える

## 構成

```text
kintai-hub.command  … ダブルクリック起動用ランチャー
docs/
  specs/
    MVP_SPEC.md      … MVP の仕様と設計
  history/
    POC_STORY.md     … PoC の経緯・技術検証の記録
  design/            … ローカルの設計レビュー資料(Git 管理外)
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
test/               … node --test のテストスイート(npm test)
data/               … ストア・監査ログ・受領 Excel・バックアップ(Git 管理外)
screenshots/        … ジョブ実行時の証跡スクリーンショット(Git 管理外)
poc/                … PoC スクリプト(検証完了・参照用。npm scripts からルートで実行する前提)
mockup/             … UI モック(v0 / Next.js。見た目の参照元)
```

## 安全設計の要点

- レバテック保存前に必ずプレビュー承認(不一致行は個別承認のみ上書き)、保存後は「更新しました。」をアサート
- Typeform 送信はレバテック保存の成功後のみ(可逆を先・不可逆を後)。送信クリック前に `submitting` を永続化(write-ahead)し、完了画面検出で `submitted`。検出不能は `unknown` として到達確認チェック付きの導線でのみ解決
- 送信済み台帳との照合で二重申請を構造的に防止(日付が重なる申請は内容が違っても自動送信しない)
- 月次の「報告する」(請求提出)は自動化しない
