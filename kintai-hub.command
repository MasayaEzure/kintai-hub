#!/bin/bash
# 勤怠ハブ ランチャー
# ダブルクリックでサーバーを起動してブラウザを開く。ウィンドウを閉じるとサーバーも終了する。
# デスクトップに置きたい場合は Finder エイリアスを作成すること(シンボリックリンクは不可)。
set -u

cd "$(dirname "$0")" || exit 1

# Finder 起動でもログインシェル経由で PATH は通るが、念のため node の定番配置を補う
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "エラー: node が見つかりません。Node.js をインストールしてください。" >&2
  exit 1
fi

PORT=$(node -p 'try { JSON.parse(require("fs").readFileSync("config.json", "utf8")).port ?? 5678 } catch { 5678 }')
# サーバー(src/server.mjs)も同じ値で listen するため、不正値を黙って 5678 に
# 倒すと監視先だけがズレる。検証してエラー終了が正しい
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "エラー: config.json の port が不正です(1〜65535 の整数にしてください): ${PORT}" >&2
  exit 1
fi
URL="http://127.0.0.1:${PORT}/"

# 勤怠ハブ本人かどうかは /api/state の応答内容で判定する
# (ポートに別サーバーがいても 200 を返しうるため、ステータスだけでは判定しない)
is_kintai_hub() {
  curl -s --max-time 2 "http://127.0.0.1:${PORT}/api/state" 2>/dev/null | grep -q '"defaultMonth"'
}

if is_kintai_hub; then
  echo "勤怠ハブは起動済みです。ブラウザを開きます: ${URL}"
  open "$URL"
  exit 0
fi

# ポートに接続できるのに勤怠ハブでない → 別プロセスが占有している
if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
  echo "エラー: ポート ${PORT} は別のプロセスに使われています。" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null >&2
  echo "そのプロセスを終了するか、config.json の port を変更してください。" >&2
  exit 1
fi

echo "勤怠ハブを起動しています..."
node src/server.mjs &
SERVER_PID=$!

# Playwright はブラウザ起動中、SIGTERM/SIGHUP を吸収して Chrome を閉じるだけで
# node 自体は終了させない。TERM 後に猶予を置き(Chrome の後始末は約3秒で完了する)、
# それでも残っていれば SIGKILL で孤児化を確実に防ぐ
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || return 0
  for _ in $(seq 1 10); do
    kill -0 "$SERVER_PID" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

TIMEOUT=30
started=0
for ((i = 1; i <= TIMEOUT; i++)); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    # 注意: Express 5 はポート衝突(EADDRINUSE)でも起動バナーを表示したまま
    # 静かに exit 0 するため、プロセスの死で失敗を検知する
    echo "" >&2
    echo "エラー: サーバーが起動直後に終了しました。" >&2
    echo "(上に『勤怠ハブ: ...』と表示されていても起動できていません。" >&2
    echo " ポート ${PORT} の競合や設定エラーの可能性があります)" >&2
    exit 1
  fi
  if is_kintai_hub; then
    started=1
    break
  fi
  sleep 1
done

if [ "$started" -ne 1 ]; then
  echo "エラー: ${TIMEOUT} 秒以内にサーバーが応答しませんでした。終了します。" >&2
  exit 1
fi

echo "起動しました。ブラウザを開きます: ${URL}"
echo "終了するにはこのウィンドウを閉じてください。"
open "$URL"

# ログを見せたままサーバーにアタッチ。ウィンドウクローズ時は SIGHUP が
# プロセスグループ全体に届き node も終了する(trap は保険)
wait "$SERVER_PID"
