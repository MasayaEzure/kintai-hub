// 勤怠ハブ PoC ステップ5: Google カレンダーへの休暇予定登録(GAS 側)
//
// このファイルを Google Apps Script プロジェクトに貼り付けて使う。セットアップ手順:
//   1. https://script.google.com → 新しいプロジェクト(名前: kintai-hub-calendar など)
//   2. プロジェクト設定 → 「appsscript.json」マニフェストを表示 → gas/appsscript.json の内容で置き換え
//      (タイムゾーン Asia/Tokyo が重要。ズレると予定日が1日ずれる)
//   3. このファイルの内容を Code.gs に貼り付け
//   4. プロジェクト設定 → スクリプト プロパティ → SHARED_SECRET を追加
//      (値はローカルの calendar.config.json の sharedSecret と同じ文字列)
//   5. エディタで manualDryRun を実行 → 初回はカレンダー権限の認可を許可 → ログで結果確認
//   6. デプロイ → 新しいデプロイ → ウェブアプリ
//      「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」でデプロイ
//      → 発行された URL(…/exec)を calendar.config.json の webAppUrl に設定
//   ※ コードを修正したら「デプロイを管理 → 編集 → 新バージョン」で再デプロイしないと反映されない
//
// セキュリティ設計:
//   - Web App は「全員がアクセス可」だが、POST ボディの secret がスクリプトプロパティと
//     一致しない限り何もしない。secret が漏れても被害は「専用カレンダーに予定が増える」まで。
//   - 削除系(manualDeleteAll)は Web App に公開せず、エディタからの手動実行専用。

const CALENDAR_NAME = '勤怠ハブ';
const TAG_KEY = 'kintaiHub';
const WORK_START = '09:00';
const WORK_END = '18:00';

// エディタ手動実行用のサンプル(ドライラン検証と、仮説2〜4の一時登録に使う。
// 実運用の登録はローカルの 05-calendar-sync.mjs から行う)
const MANUAL_SAMPLE = {
  dryRun: true,
  events: [
    { date: '2026-08-14', kind: 'vacation' },
    { date: '2026-08-20', kind: 'late', time: '11:00' },
    { date: '2026-08-21', kind: 'early', time: '16:00' },
  ],
};

// ---- エディタから手動実行する関数 ----

function manualDryRun() {
  Logger.log(JSON.stringify(sync(MANUAL_SAMPLE), null, 2));
}

// 仮説4の検証: ツールが登録した予定(タグ付き)だけを識別して一括削除できること。
// 手で作った予定はタグを持たないため対象外になる
function manualDeleteAll() {
  const calendar = CalendarApp.getCalendarsByName(CALENDAR_NAME)[0];
  if (!calendar) {
    Logger.log('カレンダー「' + CALENDAR_NAME + '」が存在しません');
    return;
  }
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date();
  to.setFullYear(to.getFullYear() + 2);
  const targets = calendar.getEvents(from, to).filter(function (e) {
    return e.getTag(TAG_KEY);
  });
  targets.forEach(function (e) {
    Logger.log('削除: ' + e.getTitle() + ' ' + e.getStartTime());
    e.deleteEvent();
  });
  Logger.log(targets.length + ' 件削除しました(タグ ' + TAG_KEY + ' 付きのみ)');
}

// ---- Web App エンドポイント ----

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'リクエストボディが JSON ではありません' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret || payload.secret !== secret) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }
  try {
    return jsonOut(sync(payload));
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ---- 本体 ----

// payload: { dryRun?: boolean, events: [{ date: 'YYYY-MM-DD', kind: 'vacation'|'late'|'early', time?: 'HH:MM' }] }
// dryRun はデフォルト true。明示的に false を渡したときだけ実登録する(安全側デフォルト)
function sync(payload) {
  const dryRun = payload.dryRun !== false;
  const events = payload.events || [];
  let calendar = CalendarApp.getCalendarsByName(CALENDAR_NAME)[0] || null;
  if (!calendar && !dryRun) {
    calendar = CalendarApp.createCalendar(CALENDAR_NAME);
  }

  const results = events.map(function (ev) {
    const plan = buildPlan(ev);
    if (plan.error) {
      return { date: ev.date, kind: ev.kind, status: 'error', error: plan.error };
    }
    const existing = calendar ? findExisting(calendar, plan) : null;
    if (existing) {
      return { date: ev.date, kind: ev.kind, status: 'skipped(既登録)', title: plan.title, time: plan.timeLabel };
    }
    if (dryRun) {
      return { date: ev.date, kind: ev.kind, status: 'planned', title: plan.title, time: plan.timeLabel };
    }
    let created;
    if (plan.allDay && plan.endExclusive) {
      created = calendar.createAllDayEvent(plan.title, plan.day, plan.endExclusive);
    } else if (plan.allDay) {
      created = calendar.createAllDayEvent(plan.title, plan.day);
    } else {
      created = calendar.createEvent(plan.title, plan.start, plan.end);
    }
    created.setTag(TAG_KEY, plan.key); // 重複検出と一括削除のための目印
    return { date: ev.date, kind: ev.kind, status: 'created', title: plan.title, time: plan.timeLabel };
  });

  return {
    ok: true,
    dryRun: dryRun,
    calendar: calendar ? CALENDAR_NAME : CALENDAR_NAME + '(未作成。実登録時に自動作成)',
    timeZone: Session.getScriptTimeZone(),
    results: results,
  };
}

function buildPlan(ev) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ev.date || '');
  if (!m) return { error: 'date は YYYY-MM-DD 形式で指定: ' + ev.date };
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const key = ev.kind + ':' + ev.date;
  if (ev.kind === 'vacation') {
    // endDate 指定で複数日の連続休暇(1本の終日予定)になる
    if (ev.endDate) {
      const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ev.endDate);
      if (!m2) return { error: 'endDate は YYYY-MM-DD 形式で指定: ' + ev.endDate };
      const endDay = new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
      if (endDay <= day) return { error: 'endDate は date より後の日付を指定: ' + ev.date + '..' + ev.endDate };
      // createAllDayEvent の終了日は exclusive のため +1 日する(しないと最終日が欠ける)
      const endExclusive = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1);
      return {
        key: ev.kind + ':' + ev.date + '..' + ev.endDate,
        title: '休暇',
        allDay: true,
        day: day,
        endExclusive: endExclusive,
        timeLabel: '終日(' + ev.date + '〜' + ev.endDate + ')',
      };
    }
    return { key: key, title: '休暇', allDay: true, day: day, timeLabel: '終日' };
  }
  if (ev.kind === 'late') {
    if (!ev.time) return { error: 'late には time(出社時刻)が必要: ' + ev.date };
    return {
      key: key,
      title: '遅参(' + ev.time + '出社)',
      allDay: false,
      day: day,
      start: at(day, WORK_START),
      end: at(day, ev.time),
      timeLabel: WORK_START + '-' + ev.time,
    };
  }
  if (ev.kind === 'early') {
    if (!ev.time) return { error: 'early には time(退社時刻)が必要: ' + ev.date };
    return {
      key: key,
      title: '早帰り(' + ev.time + '退社)',
      allDay: false,
      day: day,
      start: at(day, ev.time),
      end: at(day, WORK_END),
      timeLabel: ev.time + '-' + WORK_END,
    };
  }
  return { error: '不明な kind: ' + ev.kind };
}

function at(day, hhmm) {
  const parts = hhmm.split(':');
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(parts[0]), Number(parts[1]));
}

function findExisting(calendar, plan) {
  const hits = calendar.getEventsForDay(plan.day).filter(function (e) {
    return e.getTag(TAG_KEY) === plan.key;
  });
  return hits[0] || null;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
