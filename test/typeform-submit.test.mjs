// submitTypeform の送信境界の統合テスト(実 Chrome をヘッドレス起動し、ローカルのモックフォームで検証)。
// 実 Typeform には一切アクセスしない。
//
// P0-3: 送信クリック命令自体の例外は「送信された可能性がある」ため、
// throw(→ failed 扱い・通常再送可)ではなく outcome: 'unknown' を返さなければならない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { submitTypeform } from '../src/adapters/typeform.mjs';

// Typeform の DOM 構造(data-qa 属性)を最小再現したモックフォーム
const MOCK_FORM_HTML = `<!doctype html>
<html><body>
  <div id="app"><button data-qa="start-button">回答を始める</button></div>
  <script>
    document.querySelector('[data-qa="start-button"]').addEventListener('click', () => {
      document.getElementById('app').innerHTML =
        '<div data-qa-block="true" data-qa-focused="true">' +
        '<h2 data-qa="block-title">最終確認</h2>' +
        '<button data-qa="submit-button">送信</button>' +
        '</div>';
      document.querySelector('[data-qa="submit-button"]').addEventListener('click', () => {
        document.body.innerHTML = '<p>ご回答ありがとうございました。</p>';
      });
    });
  </script>
</body></html>`;

// 送信クリック後に完了画面が出ないフォーム(クリック後の切断・検出タイムアウトの再現用)。
// クリック成立をフラグで通知し、テスト側が「クリック後」の切断を決定的に再現できるようにする
const MOCK_FORM_NO_COMPLETE_HTML = MOCK_FORM_HTML.replace(
  "document.body.innerHTML = '<p>ご回答ありがとうございました。</p>';",
  'window.__submitClicked = true;'
);

function startMockServer(html = MOCK_FORM_HTML) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const configFor = (server) => ({
  typeform: { formUrl: `http://127.0.0.1:${server.address().port}/form`, personalId: 'ENG0000000000' },
});

const ANSWERS = { type: 'お休み', date: '9/1', start: '', end: '', reason: '私用', detail: '', contacted: 'はい' };

const makeCtx = () => {
  const captured = { page: null };
  return {
    captured,
    ctx: {
      log: () => {},
      screenshot: async (page) => {
        captured.page = page; // テストから page を掴むためのフック(送信直前に必ず呼ばれる)
      },
    },
  };
};

test('正常系: 完了画面を検出して submitted を返す', { timeout: 60000 }, async () => {
  const server = await startMockServer();
  try {
    const { ctx } = makeCtx();
    const res = await submitTypeform(configFor(server), ANSWERS, {
      ctx,
      onBeforeSubmit: async () => {},
      launchOptions: { headless: true },
    });
    assert.equal(res.outcome, 'submitted');
    assert.ok(res.detectedBy.includes('ありがとう'));
  } finally {
    server.close();
  }
});

test('P0-3: 送信クリック命令が例外になった場合は throw せず unknown を返す', { timeout: 60000 }, async () => {
  const server = await startMockServer();
  try {
    const { ctx, captured } = makeCtx();
    const res = await submitTypeform(configFor(server), ANSWERS, {
      ctx,
      // write-ahead の直後・クリック命令の直前に page を閉じ、
      // 「クリック命令がブラウザ切断で例外になる」状況を決定的に再現する
      onBeforeSubmit: async () => {
        await captured.page.close();
      },
      launchOptions: { headless: true },
    });
    // 送信済みか未送信か確定できないため、failed(未送信確定)ではなく unknown でなければならない
    assert.equal(res.outcome, 'unknown');
    assert.equal(res.detectedBy, null);
  } finally {
    server.close();
  }
});

test('クリック成立後・完了検出前にブラウザが切断されても throw せず unknown を返す', { timeout: 60000 }, async () => {
  const server = await startMockServer(MOCK_FORM_NO_COMPLETE_HTML);
  try {
    const { ctx, captured } = makeCtx();
    const res = await submitTypeform(configFor(server), ANSWERS, {
      ctx,
      // クリック成立(モックがフラグを立てる)を確認してからブラウザ接続を落とし、
      // 「完了検出ループ中の切断」を決定的に再現する。クリック前に閉じると
      // クリック例外の経路(P0-3)に入ってしまい、このテストの対象を検証できない。
      // throw が漏れると呼び出し側で failed(通常再送可)になり、二重申請の経路になる
      onBeforeSubmit: async () => {
        let attempts = 0;
        const poll = setInterval(async () => {
          const clicked = await captured.page.evaluate(() => window.__submitClicked === true).catch(() => false);
          if (clicked || ++attempts > 100) {
            clearInterval(poll);
            if (clicked) await captured.page.context().browser().close().catch(() => {});
          }
        }, 50);
      },
      launchOptions: { headless: true },
      detectTimeoutMs: 5000,
    });
    assert.equal(res.outcome, 'unknown');
    assert.equal(res.detectedBy, null);
    // クリック例外の経路ではなく、クリック後の完了検出フェーズを通ったことを確認する
    assert.ok(!res.bodyHead.includes('クリック命令が例外'), `unexpected path: ${res.bodyHead}`);
  } finally {
    server.close();
  }
});
