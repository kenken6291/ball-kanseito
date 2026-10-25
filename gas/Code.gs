/**
 * ボール管制塔～タスク管理（ball-kanseito）— GAS バックエンド
 * v1.2.0（返事待ちの複数人対応・確認先URL・確認先スクリーンショット）
 *
 * 認証 / ミッション(タスク)CRUD / 実績ログ / Gemini実況 / Gemini TTS / Drive保存 / メール送信
 * フロントからは Content-Type: text/plain で JSON を POST する（CORSプリフライト回避）
 *
 * 初回：エディタで setup() を1回実行 → スクリプトプロパティに GEMINI_API_KEY を設定 → ウェブアプリとしてデプロイ
 * ※コードを変更したら「デプロイを管理」→ 編集 → バージョン「新バージョン」で再デプロイ（URLはそのまま）
 */

const APP_VERSION = '1.2.1';
const APP_NAME = 'ボール管制塔～タスク管理';   // メール件名・本文に表示

const DEF = {
  USERS: { name: 'Users', headers: ['email', 'nickname', 'salt', 'hash', 'mustChange', 'failCount', 'lockedUntil', 'createdAt', 'lastLogin'] },
  TASKS: { name: 'Tasks', headers: ['taskId', 'email', 'title', 'category', 'deadline', 'status', 'nextAction', 'ballHolder', 'waitName', 'waitDept', 'waitContact', 'ballDue', 'createdAt', 'updatedAt', 'completedAt', 'waiters', 'links', 'shots'] },
  LOGS: { name: 'Logs', headers: ['logId', 'taskId', 'email', 'date', 'text', 'createdAt'] },
  NARRATIONS: { name: 'Narrations', headers: ['id', 'email', 'type', 'text', 'audioFileId', 'createdAt'] }
};

const STATUSES = ['未着手', '進行中', '保留', '完了'];
const SESSION_TTL = 21600;        // 6時間（CacheServiceの上限）
const MAX_FAIL = 5;               // 連続失敗でロック
const LOCK_MIN = 15;              // ロック時間（分）
const NARRATE_DAILY_LIMIT = 40;   // 1人1日あたりの実況生成上限
const HASH_ROUNDS = 300;
const MAX_WAITERS = 200;          // 1ミッションあたりの返事待ち人数の上限
const MAX_LINKS = 10;             // 確認先URLの上限
const MAX_SHOTS = 20;             // 確認先スクリーンショットの上限（1ミッション）
const MAX_SHOT_BYTES = 6 * 1024 * 1024;
const SHOT_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/* =========================================================
 * 初期セットアップ（エディタから1回だけ実行）
 * ========================================================= */
function setup() {
  const p = PropertiesService.getScriptProperties();

  let ssId = p.getProperty('SPREADSHEET_ID');
  if (!ssId) {
    ssId = SpreadsheetApp.create(APP_NAME + '_DB').getId();
    p.setProperty('SPREADSHEET_ID', ssId);
  }
  const ss = SpreadsheetApp.openById(ssId);
  Object.keys(DEF).forEach(k => {
    const d = DEF[k];
    let sh = ss.getSheetByName(d.name);
    if (!sh) sh = ss.insertSheet(d.name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, d.headers.length).setValues([d.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    sh.getRange(1, 1, sh.getMaxRows(), d.headers.length).setNumberFormat('@');
  });
  ['シート1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('DRIVE_FOLDER_ID')) p.setProperty('DRIVE_FOLDER_ID', DriveApp.createFolder(APP_NAME + '_データ').getId());

  Logger.log('セットアップ完了');
  Logger.log('スプレッドシート: ' + ss.getUrl());
  Logger.log('Driveフォルダ: ' + DriveApp.getFolderById(p.getProperty('DRIVE_FOLDER_ID')).getUrl());
  Logger.log('次に、スクリプトプロパティ GEMINI_API_KEY を設定してください。');
}

/* =========================================================
 * ルーター
 * ========================================================= */
function doGet() {
  return json_({ ok: true, app: APP_NAME, version: APP_VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません。' });
  }

  const PUBLIC = {
    ping: apiPing_,
    register: apiRegister_,
    login: apiLogin_,
    resetPassword: apiResetPassword_
  };
  const PRIVATE = {
    me: apiMe_,
    logout: apiLogout_,
    changePassword: apiChangePassword_,
    listAll: apiListAll_,
    saveTask: apiSaveTask_,
    deleteTask: apiDeleteTask_,
    uploadShot: apiUploadShot_,
    getShot: apiGetShot_,
    discardShots: apiDiscardShots_,
    addLog: apiAddLog_,
    deleteLog: apiDeleteLog_,
    narrate: apiNarrate_,
    exportBackup: apiExportBackup_
  };
  const ALLOW_WHEN_TEMP = ['me', 'logout', 'changePassword'];

  try {
    const action = String(req.action || '');
    if (PUBLIC[action]) return json_(Object.assign({ ok: true }, PUBLIC[action](req)));
    if (PRIVATE[action]) {
      const sess = auth_(req.token);
      if (sess.mustChange && ALLOW_WHEN_TEMP.indexOf(action) < 0) {
        throw appErr_('仮パスワードのままです。先にパスワードを変更してください。', 'MUST_CHANGE');
      }
      return json_(Object.assign({ ok: true }, PRIVATE[action](req, sess)));
    }
    throw appErr_('不明な操作です：' + action);
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: err.message || String(err), code: err.code || '' });
  }
}

/* =========================================================
 * 認証系API
 * ========================================================= */
function apiPing_() {
  return { app: APP_NAME, version: APP_VERSION };
}

function apiRegister_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim();
  if (!isEmail_(email)) throw appErr_('メールアドレスの形式を確認してください。');
  if (!nickname || nickname.length > 20) throw appErr_('ニックネームは1〜20文字で入力してください。');

  return withLock_(() => {
    if (findUser_(email)) {
      throw appErr_('このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワードを忘れた」から再発行してください。');
    }
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    appendRow_(DEF.USERS, {
      email: email, nickname: nickname, salt: salt, hash: hash_(temp, salt),
      mustChange: true, failCount: 0, lockedUntil: '', createdAt: now_(), lastLogin: ''
    });
    sendMail_(email, '【' + APP_NAME + '】仮パスワードのお知らせ', [
      nickname + ' さん',
      '',
      APP_NAME + 'へのご登録ありがとうございます。',
      '',
      '仮パスワード：' + temp,
      '',
      'ログインすると、本パスワードの設定画面が表示されます。',
      appUrlLine_(),
      'このメールに心当たりがない場合は、破棄してください。'
    ].join('\n'));
    return { message: '仮パスワードをメールで送りました。届いたパスワードでログインしてください。' };
  });
}

function apiLogin_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  if (!email || !pw) throw appErr_('メールアドレスとパスワードを入力してください。');

  return withLock_(() => {
    const u = findUser_(email);
    if (!u) throw appErr_('メールアドレスまたはパスワードが違います。');

    if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
      throw appErr_('ログインに続けて失敗したため、一時的にロックしています。' + LOCK_MIN + '分ほど待つか、「パスワードを忘れた」から再発行してください。');
    }

    if (hash_(pw, u.salt) !== u.hash) {
      const fc = Number(u.failCount || 0) + 1;
      if (fc >= MAX_FAIL) {
        updateRow_(DEF.USERS, u, { failCount: 0, lockedUntil: new Date(Date.now() + LOCK_MIN * 60000).toISOString() });
        throw appErr_(MAX_FAIL + '回続けて失敗したため、' + LOCK_MIN + '分間ロックしました。');
      }
      updateRow_(DEF.USERS, u, { failCount: fc });
      throw appErr_('メールアドレスまたはパスワードが違います。（あと' + (MAX_FAIL - fc) + '回失敗するとロックされます）');
    }

    updateRow_(DEF.USERS, u, { failCount: 0, lockedUntil: '', lastLogin: now_() });
    const user = { email: u.email, nickname: u.nickname, mustChange: toBool_(u.mustChange) };
    const token = newToken_();
    putSession_(token, user);
    return { token: token, user: user };
  });
}

function apiResetPassword_(req) {
  const email = normEmail_(req.email);
  if (!isEmail_(email)) throw appErr_('メールアドレスの形式を確認してください。');
  withLock_(() => {
    const u = findUser_(email);
    if (!u) return;
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    updateRow_(DEF.USERS, u, { salt: salt, hash: hash_(temp, salt), mustChange: true, failCount: 0, lockedUntil: '' });
    sendMail_(email, '【' + APP_NAME + '】仮パスワードを再発行しました', [
      u.nickname + ' さん',
      '',
      '仮パスワードを再発行しました。',
      '',
      '仮パスワード：' + temp,
      '',
      'ログインすると、本パスワードの設定画面が表示されます。',
      appUrlLine_(),
      'この操作に心当たりがない場合は、このメールを破棄してください。以前のパスワードは使えなくなっています。'
    ].join('\n'));
  });
  return { message: '登録されているメールアドレスなら、仮パスワードを送りました。メールを確認してください。' };
}

function apiMe_(req, s) {
  return { user: { email: s.email, nickname: s.nickname, mustChange: s.mustChange } };
}

function apiLogout_(req) {
  CacheService.getScriptCache().remove('sess_' + req.token);
  return {};
}

function apiChangePassword_(req, s) {
  const cur = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) {
    throw appErr_('新しいパスワードは、英字と数字を含む8文字以上にしてください。');
  }
  if (cur === next) throw appErr_('今のパスワードとは別のパスワードにしてください。');

  return withLock_(() => {
    const u = findUser_(s.email);
    if (!u) throw appErr_('アカウントが見つかりません。', 'AUTH');
    if (hash_(cur, u.salt) !== u.hash) throw appErr_('現在のパスワード（仮パスワード）が違います。');
    const salt = Utilities.getUuid();
    updateRow_(DEF.USERS, u, { salt: salt, hash: hash_(next, salt), mustChange: false, failCount: 0, lockedUntil: '' });
    const user = { email: s.email, nickname: s.nickname, mustChange: false };
    putSession_(req.token, user);
    return { user: user, message: 'パスワードを変更しました。' };
  });
}

/* =========================================================
 * ミッション・ログ API
 * ========================================================= */
function apiListAll_(req, s) {
  const tasks = readAll_(DEF.TASKS).filter(t => t.email === s.email).map(publicTask_);
  const logs = readAll_(DEF.LOGS).filter(l => l.email === s.email).map(publicLog_);
  return { tasks: tasks, logs: logs, serverTime: now_() };
}

function apiSaveTask_(req, s) {
  const src = req.task || {};
  const data = cleanTask_(src);
  const id = String(src.taskId || '');

  return withLock_(() => {
    if (id) {
      const cur = readAll_(DEF.TASKS).find(t => t.taskId === id && t.email === s.email);
      if (!cur) throw appErr_('ミッションが見つかりません。');
      const oldShots = parseList_(cur.shots).map(x => x.fileId);
      const newShots = parseList_(data.shots).map(x => x.fileId);
      newShots.filter(f => oldShots.indexOf(f) < 0).forEach(f => ownShot_(f, s.email));
      oldShots.filter(f => newShots.indexOf(f) < 0).forEach(f => trashShot_(f, s.email));
      const justCompleted = data.status === '完了' && cur.status !== '完了';
      const patch = Object.assign({}, data, { updatedAt: now_() });
      if (justCompleted) patch.completedAt = now_();
      if (data.status !== '完了') patch.completedAt = '';
      const merged = updateRow_(DEF.TASKS, cur, patch);
      return { task: publicTask_(merged), justCompleted: justCompleted };
    }
    const task = Object.assign(
      { taskId: 'T' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), email: s.email },
      data,
      { createdAt: now_(), updatedAt: now_(), completedAt: data.status === '完了' ? now_() : '' }
    );
    parseList_(data.shots).forEach(x => ownShot_(x.fileId, s.email));
    appendRow_(DEF.TASKS, task);
    return { task: publicTask_(task), created: true };
  });
}

function apiDeleteTask_(req, s) {
  const id = String(req.taskId || '');
  return withLock_(() => {
    const t = readAll_(DEF.TASKS).find(x => x.taskId === id && x.email === s.email);
    if (!t) throw appErr_('ミッションが見つかりません。');
    const logRows = readAll_(DEF.LOGS).filter(l => l.taskId === id && l.email === s.email).map(l => l._row);
    deleteRows_(DEF.LOGS, logRows);
    deleteRows_(DEF.TASKS, [t._row]);
    parseList_(t.shots).forEach(x => trashShot_(x.fileId, s.email));
    return { taskId: id };
  });
}

function apiAddLog_(req, s) {
  const text = String(req.text || '').trim().slice(0, 500);
  if (!text) throw appErr_('今日やったことを入力してください。');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.date || '')) ? String(req.date) : today_();

  return withLock_(() => {
    const t = readAll_(DEF.TASKS).find(x => x.taskId === req.taskId && x.email === s.email);
    if (!t) throw appErr_('ミッションが見つかりません。');
    const log = {
      logId: 'L' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
      taskId: t.taskId, email: s.email, date: date, text: text, createdAt: now_()
    };
    appendRow_(DEF.LOGS, log);

    const patch = { updatedAt: now_() };
    if (typeof req.nextAction === 'string') patch.nextAction = req.nextAction.trim().slice(0, 300);
    if (t.status === '未着手') patch.status = '進行中';
    const merged = updateRow_(DEF.TASKS, t, patch);
    return { log: publicLog_(log), task: publicTask_(merged) };
  });
}

function apiDeleteLog_(req, s) {
  const id = String(req.logId || '');
  return withLock_(() => {
    const l = readAll_(DEF.LOGS).find(x => x.logId === id && x.email === s.email);
    if (!l) throw appErr_('記録が見つかりません。');
    deleteRows_(DEF.LOGS, [l._row]);
    return { logId: id };
  });
}

/* =========================================================
 * 確認先スクリーンショット（LINE など URL のない確認先用）
 * 画像はブラウザ側で縮小済みの JPEG を受け取り、Drive/shots に非公開で保存。
 * ファイルの説明欄に持ち主を記録し、本人以外は読めないようにする。
 * ========================================================= */
function apiUploadShot_(req, s) {
  const mime = String(req.mime || '');
  if (SHOT_MIMES.indexOf(mime) < 0) throw appErr_('画像はJPEG・PNG・WebPのいずれかにしてください。');
  let bytes;
  try { bytes = Utilities.base64Decode(String(req.data || '')); } catch (e) { throw appErr_('画像データを読み取れませんでした。'); }
  if (!bytes.length) throw appErr_('画像データが空です。');
  if (bytes.length > MAX_SHOT_BYTES) throw appErr_('画像が大きすぎます（6MBまで）。');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const name = 'shot_' + safeName_(s.email) + '_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().slice(0, 4) + '.' + ext;
  const file = subFolder_('shots').createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription(shotOwnerTag_(s.email));
  return { fileId: file.getId(), at: now_() };
}

function apiGetShot_(req, s) {
  const file = ownShot_(String(req.fileId || ''), s.email);
  const blob = file.getBlob();
  return { data: Utilities.base64Encode(blob.getBytes()), mime: blob.getContentType() };
}

/** 保存されなかった（キャンセル・保存前に外した）画像をゴミ箱へ。どのミッションにも使われていないものだけ */
function apiDiscardShots_(req, s) {
  const ids = (Array.isArray(req.fileIds) ? req.fileIds : []).slice(0, MAX_SHOTS * 2).map(String);
  const used = {};
  readAll_(DEF.TASKS).filter(t => t.email === s.email)
    .forEach(t => parseList_(t.shots).forEach(x => { used[x.fileId] = true; }));
  let n = 0;
  ids.forEach(f => { if (!used[f]) { trashShot_(f, s.email); n++; } });
  return { trashed: n };
}

function shotOwnerTag_(email) {
  return 'ball-kanseito:' + toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email + prop_('PEPPER', ''), Utilities.Charset.UTF_8)).slice(0, 32);
}

/** 本人がアップロードした画像か確認してファイルを返す */
function ownShot_(fileId, email) {
  if (!/^[\w-]{10,}$/.test(fileId)) throw appErr_('画像の指定が正しくありません。');
  let file;
  try { file = DriveApp.getFileById(fileId); } catch (e) { throw appErr_('画像が見つかりません。削除された可能性があります。'); }
  if (file.isTrashed() || file.getDescription() !== shotOwnerTag_(email)) throw appErr_('この画像は表示できません。');
  return file;
}

function trashShot_(fileId, email) {
  try { ownShot_(fileId, email).setTrashed(true); } catch (e) { console.warn('trashShot_: ' + e.message); }
}

function apiExportBackup_(req, s) {
  const tasks = readAll_(DEF.TASKS).filter(t => t.email === s.email).map(publicTask_);
  const logs = readAll_(DEF.LOGS).filter(l => l.email === s.email).map(publicLog_);
  const payload = { app: APP_NAME, version: APP_VERSION, exportedAt: now_(), user: s.nickname, tasks: tasks, logs: logs };
  const name = 'backup_' + safeName_(s.email) + '_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmmss') + '.json';
  const file = subFolder_('backup').createFile(name, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  return { name: name, url: file.getUrl() };
}

/* =========================================================
 * 実況（Gemini）＋ 読み上げ（Gemini TTS）
 * ========================================================= */
const NARRATION_SYSTEM = [
  'あなたはタスク管理アプリ「ボール管制塔」の名物管制官です。',
  '利用者のミッション（タスク）を空港を発着する便に見立て、ラジオの実況アナウンサーのように明るく軽快な日本語の話し言葉で状況を伝え、利用者を励まします。',
  '状況の呼び方：未着手は搭乗待ち、進行中は飛行中、保留は待機旋回、完了は着陸、締め切り間近は最終案内、締め切り超過は遅延。相手の返事待ちは「ボールは相手の手元」と表現します。',
  '',
  '出力ルール（厳守）：',
  '1. 出力するのは、音声合成エンジンがそのまま読み上げる本文だけ。',
  '2. 「承知しました」「かしこまりました」「以下が」などの応答・前置き・後書きを書かない。',
  '3. 「ナレーション：」「原稿」「実況：」「管制官：」などの見出し、ラベル、話者名を書かない。',
  '4. 読み方・声色・効果音・間の取り方などの演出指示、ト書き、括弧書きの注釈を書かない。',
  '5. 箇条書き、見出し記号、アスタリスク、絵文字、URL、英字の略語を使わない。',
  '6. 改行せず、ひと続きの文章にする。',
  '7. 日付や時刻は「10/27」のような記号表記にせず「10月27日の午後6時」のように言葉で書く。',
  '8. 利用者を責めない。遅れているものも、次にやる一手に目を向けさせる言い方にする。',
  '9. 依頼で指定された文字数以内に収める。'
].join('\n');

function apiNarrate_(req, s) {
  checkRate_(s.email);
  const type = ['briefing', 'complete', 'deadline'].indexOf(req.type) >= 0 ? req.type : 'briefing';
  const tasks = readAll_(DEF.TASKS).filter(t => t.email === s.email);
  const logs = readAll_(DEF.LOGS).filter(l => l.email === s.email);
  const prompt = buildContext_(type, tasks, logs, s, String(req.taskId || ''));

  const text = cleanNarration_(gemini_(NARRATION_SYSTEM, prompt));
  if (!text) throw appErr_('実況文を作れませんでした。もう一度お試しください。');

  let audio = '';
  let audioFileId = '';
  let ttsError = '';
  if (req.tts) {
    try {
      const wav = tts_(text);
      audio = Utilities.base64Encode(wav);
      audioFileId = saveAudio_(wav, s.email, type);
    } catch (err) {
      console.warn(err);
      ttsError = err.message || String(err);
    }
  }

  appendRow_(DEF.NARRATIONS, {
    id: 'N' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
    email: s.email, type: type, text: text, audioFileId: audioFileId, createdAt: now_()
  });
  return { text: text, audio: audio, mime: 'audio/wav', ttsError: ttsError };
}

function buildContext_(type, tasks, logs, s, taskId) {
  const nowD = new Date();
  const today = today_();
  const open = tasks.filter(t => t.status !== '完了');
  const titleOf = {};
  tasks.forEach(t => { titleOf[t.taskId] = t.title; });

  const line = t => {
    const parts = [t.title];
    if (t.category) parts.push('分類 ' + t.category);
    parts.push('締め切り ' + (t.deadline ? speakDT_(t.deadline) + '（' + leftText_(t.deadline, nowD) + '）' : 'なし'));
    parts.push('状況 ' + t.status);
    const pt = publicTask_(t);
    const pending = pendingWaiters_(pt);
    if (pt.ballHolder === 'other' && pt.waiters.length) {
      const over = pending.filter(w => w.due && w.due < today);
      const names = pending.slice(0, 5).map(w => w.name).join('、');
      parts.push(pending.length
        ? 'ボール：' + pt.waiters.length + '人に返事待ち、未回答' + pending.length + '人' + (over.length ? '（うち期日超過' + over.length + '人）' : '') + '、未回答の主な相手 ' + names + (pending.length > 5 ? 'ほか' : '')
        : 'ボール：' + pt.waiters.length + '人全員から回答あり、ボールは自分に戻った');
      if (pt.links.length) parts.push('返事の確認先 ' + pt.links.map(l => l.label).join('、'));
      if (pt.shots.length) parts.push('確認用のスクリーンショット' + pt.shots.length + '枚');
    } else {
      parts.push('ボール：自分');
    }
    if (t.nextAction) parts.push('次にやること ' + t.nextAction);
    return '- ' + parts.join('／');
  };

  const head = [
    '現在日時：' + Utilities.formatDate(nowD, tz_(), 'yyyy年M月d日 H時m分'),
    '利用者の呼び名：' + s.nickname + 'さん'
  ];

  if (type === 'complete') {
    const t = tasks.find(x => x.taskId === taskId);
    if (!t) throw appErr_('対象のミッションが見つかりません。');
    const onTime = !t.deadline || !t.completedAt || new Date(t.completedAt) <= new Date(t.deadline);
    const count = logs.filter(l => l.taskId === t.taskId).length;
    return head.concat([
      '依頼：次のミッションが完了（着陸）しました。スポーツ実況のように盛り上げて祝ってください。' + (onTime ? '締め切りに間に合ったことを称えてください。' : '締め切りは過ぎたが最後までやり切ったことを称えてください。') + '残りの便の数にも一言触れてください。120字以内。',
      '着陸した便：' + t.title,
      'これまでの記録回数：' + count + '回',
      '残りの便：' + open.length + '件'
    ]).join('\n');
  }

  const todayLogs = logs.filter(l => l.date === today);
  const landedToday = tasks.filter(t => t.status === '完了' && String(t.completedAt).slice(0, 10) === today);
  const sorted = open.slice().sort((a, b) => (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1);

  if (type === 'deadline') {
    const urgent = sorted.filter(t => t.deadline && hoursLeft_(t.deadline, nowD) <= 48);
    return head.concat([
      '依頼：締め切りが迫っている便への最終案内放送をしてください。焦らせすぎず、いま取りかかる一手を1つ具体的に伝えてください。150字以内。',
      '【最終案内・遅延の便 ' + urgent.length + '件】'
    ]).concat(urgent.slice(0, 5).map(line)).join('\n');
  }

  return head.concat([
    '依頼：今日の運航状況を管制塔の実況として伝えてください。遅延、最終案内、相手の返事待ちを優先して触れ、今日の成果をほめ、最後に次の一手を1つ提案して励ましてください。230字以内。',
    '【未完了の便 ' + open.length + '件（締め切り順）】'
  ]).concat(sorted.slice(0, 8).map(line)).concat([
    '【今日の記録 ' + todayLogs.length + '件】'
  ]).concat(todayLogs.slice(0, 6).map(l => '- ' + (titleOf[l.taskId] || '') + '：' + l.text)).concat([
    '【今日着陸した便 ' + landedToday.length + '件】'
  ]).concat(landedToday.map(t => '- ' + t.title)).join('\n');
}

function gemini_(system, user) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw appErr_('サーバーにGEMINI_API_KEYが設定されていません。');
  const model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const json = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) throw appErr_('Gemini APIエラー（' + code + '）：' + ((json.error && json.error.message) || ''));
  const cand = json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
}

/** TTSに渡す前の最終クリーニング：前置き・ラベル・演出指示・記号を除去 */
function cleanNarration_(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  s = s.replace(/[*#_`>~|]/g, '');
  const label = /^(ナレーション|実況原稿|読み上げ原稿|原稿|実況文?|本文|管制官|管制塔)[^:：。！？]{0,8}[:：]\s*/;
  let lines = s.split(/\r?\n+/).map(l => l.trim().replace(label, '')).filter(Boolean);
  const meta = /^(承知|かしこまりました|了解しました|もちろんです|はい、?(承知|わかりました)|以下(が|は|に)|---)/;
  while (lines.length && meta.test(lines[0])) lines.shift();
  lines = lines.filter(l => !/^(以上|※)/.test(l));
  s = lines.join('');
  s = s.replace(/^[^。！？]{0,20}(ナレーション|原稿|実況|本文|管制官)[^。！？]{0,6}[:：]\s*/, '');
  s = s.replace(/[（(][^）)]{0,40}(読み上げ|読ん|読む|BGM|SE|効果音|間を|声|トーン|口調|調子|明るく|元気に|ゆっくり|笑)[^）)]{0,40}[）)]/g, '');
  s = s.replace(/\[[^\]]{0,40}\]/g, '');
  s = s.replace(/^[「『"]+|[」』"]+$/g, '');
  s = s.replace(/https?:\/\/\S+/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

function tts_(text) {
  const key = prop_('GEMINI_API_KEY', '');
  const model = prop_('TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const body = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prop_('TTS_VOICE', 'Puck') } } }
    }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const json = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) throw new Error('TTSエラー（' + code + '）：' + ((json.error && json.error.message) || ''));
  const cand = json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
  if (!audioPart) throw new Error('TTSの音声データが空でした。');
  const mime = String(audioPart.inlineData.mimeType || '');
  const rateMatch = mime.match(/rate=(\d+)/);
  const pcm = Utilities.base64Decode(audioPart.inlineData.data);
  return pcmToWav_(pcm, rateMatch ? Number(rateMatch[1]) : 24000, 1, 16);
}

/** 16bit リニアPCM → WAV（ヘッダ付与） */
function pcmToWav_(pcm, rate, ch, bits) {
  const dataLen = pcm.length;
  const h = [];
  const str = s => { for (let i = 0; i < s.length; i++) h.push(s.charCodeAt(i)); };
  const u32 = n => { h.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255); };
  const u16 = n => { h.push(n & 255, (n >> 8) & 255); };
  str('RIFF'); u32(36 + dataLen); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(ch); u32(rate); u32(rate * ch * bits / 8); u16(ch * bits / 8); u16(bits);
  str('data'); u32(dataLen);
  const header = h.map(b => (b > 127 ? b - 256 : b));
  return header.concat(Array.prototype.slice.call(pcm));
}

function saveAudio_(wavBytes, email, type) {
  const name = 'narration_' + safeName_(email) + '_' + type + '_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmmss') + '.wav';
  const file = subFolder_('audio').createFile(Utilities.newBlob(wavBytes, 'audio/wav', name));
  return file.getId();
}

function checkRate_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'nr_' + safeName_(email) + '_' + today_();
  const n = Number(cache.get(key) || 0);
  if (n >= NARRATE_DAILY_LIMIT) throw appErr_('今日の実況は上限（' + NARRATE_DAILY_LIMIT + '回）に達しました。また明日どうぞ。');
  cache.put(key, String(n + 1), 21600);
}

/* =========================================================
 * データ整形
 * ========================================================= */
function cleanTask_(t) {
  const s = v => String(v == null ? '' : v).trim();
  const o = {
    title: s(t.title).slice(0, 80),
    category: s(t.category).slice(0, 20),
    deadline: s(t.deadline).slice(0, 16),
    status: STATUSES.indexOf(t.status) >= 0 ? t.status : '未着手',
    nextAction: s(t.nextAction).slice(0, 300),
    ballHolder: t.ballHolder === 'other' ? 'other' : 'me',
    waitName: '', waitDept: '', waitContact: '', ballDue: ''   // v1.0の列（waitersへ移行済み）
  };

  const waiters = (Array.isArray(t.waiters) ? t.waiters : []).map(w => ({
    id: s(w.id).slice(0, 12) || 'w' + Utilities.getUuid().replace(/-/g, '').slice(0, 8),
    name: s(w.name).slice(0, 40),
    dept: s(w.dept).slice(0, 40),
    contact: s(w.contact).slice(0, 200),
    due: s(w.due).slice(0, 10),
    replied: w.replied === true
  })).filter(w => w.name);
  if (waiters.length > MAX_WAITERS) throw appErr_('返事待ちの相手は' + MAX_WAITERS + '人までです。');
  waiters.forEach(w => {
    if (w.due && !/^\d{4}-\d{2}-\d{2}$/.test(w.due)) throw appErr_(w.name + 'さんの回答期日の形式が正しくありません。');
  });

  const links = (Array.isArray(t.links) ? t.links : []).map(l => ({
    label: s(l.label).slice(0, 30),
    url: s(l.url).slice(0, 500)
  })).filter(l => l.url);
  if (links.length > MAX_LINKS) throw appErr_('確認先のURLは' + MAX_LINKS + '件までです。');
  links.forEach(l => {
    if (!/^https?:\/\/[^\s]+$/i.test(l.url)) throw appErr_('確認先のURLは http:// または https:// で始まる形で入力してください：' + l.url);
    if (!l.label) l.label = guessLinkLabel_(l.url);
  });

  const shots = (Array.isArray(t.shots) ? t.shots : []).map(x => ({
    fileId: s(x.fileId).slice(0, 100),
    label: s(x.label).slice(0, 30),
    at: s(x.at).slice(0, 19)
  })).filter(x => /^[\w-]{10,}$/.test(x.fileId));
  if (shots.length > MAX_SHOTS) throw appErr_('スクリーンショットは' + MAX_SHOTS + '枚までです。');

  o.waiters = JSON.stringify(waiters);
  o.links = JSON.stringify(links);
  o.shots = JSON.stringify(shots);
  if (!o.title) throw appErr_('ミッション名を入力してください。');
  if (o.deadline && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.deadline)) throw appErr_('締め切りの日時の形式が正しくありません。');
  if (o.ballHolder === 'other' && !waiters.length) throw appErr_('返事を待っている相手を1人以上入力してください。');
  return o;
}

function publicTask_(t) {
  const o = {};
  DEF.TASKS.headers.forEach(h => { if (h !== 'email') o[h] = t[h] === undefined ? '' : t[h]; });
  o.waiters = parseList_(o.waiters);
  o.links = parseList_(o.links);
  o.shots = parseList_(o.shots);
  // v1.0 で登録した1人分の返事待ちを移行
  if (!o.waiters.length && o.waitName) {
    o.waiters = [{ id: 'w0', name: String(o.waitName), dept: String(o.waitDept || ''), contact: String(o.waitContact || ''), due: String(o.ballDue || ''), replied: false }];
  }
  ['waitName', 'waitDept', 'waitContact', 'ballDue'].forEach(k => { delete o[k]; });
  return o;
}

function parseList_(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

function pendingWaiters_(pt) {
  return pt.ballHolder === 'other' ? pt.waiters.filter(w => !w.replied) : [];
}

function guessLinkLabel_(url) {
  const u = String(url).toLowerCase();
  if (u.indexOf('chouseisan.com') >= 0) return '調整さん';
  if (u.indexOf('line.me') >= 0) return 'LINE';
  if (u.indexOf('forms.gle') >= 0 || u.indexOf('docs.google.com/forms') >= 0) return 'Googleフォーム';
  if (u.indexOf('docs.google.com/spreadsheets') >= 0) return 'スプレッドシート';
  if (u.indexOf('densuke.biz') >= 0) return '伝助';
  if (u.indexOf('slack.com') >= 0) return 'Slack';
  if (u.indexOf('teams.microsoft.com') >= 0) return 'Teams';
  if (u.indexOf('facebook.com') >= 0) return 'Facebook';
  return 'Webページ';
}

function publicLog_(l) {
  return { logId: l.logId, taskId: l.taskId, date: l.date, text: l.text, createdAt: l.createdAt };
}

/* =========================================================
 * シート操作
 * ========================================================= */
const HEADER_CHECKED_ = {};
function sheet_(def) {
  const id = prop_('SPREADSHEET_ID', '');
  if (!id) throw appErr_('サーバーの初期設定が終わっていません。setup()を実行してください。');
  const sh = SpreadsheetApp.openById(id).getSheetByName(def.name);
  if (!HEADER_CHECKED_[def.name]) {
    HEADER_CHECKED_[def.name] = true;
    if (sh.getLastColumn() < def.headers.length) {   // 列追加のバージョンアップに自動追従
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    }
  }
  return sh;
}

function readAll_(def) {
  const sh = sheet_(def);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, def.headers.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    def.headers.forEach((h, j) => { o[h] = norm_(r[j]); });
    return o;
  });
}

function appendRow_(def, obj) {
  const sh = sheet_(def);
  sh.getRange(sh.getLastRow() + 1, 1, 1, def.headers.length).setValues([def.headers.map(h => toCell_(obj[h]))]);
}

function updateRow_(def, cur, patch) {
  const merged = Object.assign({}, cur, patch);
  sheet_(def).getRange(cur._row, 1, 1, def.headers.length).setValues([def.headers.map(h => toCell_(merged[h]))]);
  return merged;
}

function deleteRows_(def, rows) {
  const sh = sheet_(def);
  rows.slice().sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}

/** 文字列は先頭にアポストロフィを付けて「文字列として」保存（日付自動変換・数式注入を防止） */
function toCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  const s = String(v);
  return s === '' ? '' : "'" + s;
}

function norm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), "yyyy-MM-dd'T'HH:mm:ss");
  return v === null || v === undefined ? '' : v;
}

/* =========================================================
 * 共通ユーティリティ
 * ========================================================= */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function auth_(token) {
  if (!token) throw appErr_('ログインしてください。', 'AUTH');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) throw appErr_('ログインの有効期限が切れました。もう一度ログインしてください。', 'AUTH');
  cache.put('sess_' + token, raw, SESSION_TTL);
  return JSON.parse(raw);
}

function putSession_(token, user) {
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(user), SESSION_TTL);
}

function findUser_(email) {
  return readAll_(DEF.USERS).find(u => String(u.email).toLowerCase() === email) || null;
}

function hash_(pw, salt) {
  const pepper = prop_('PEPPER', '');
  if (!pepper) throw appErr_('サーバーの初期設定（PEPPER）が終わっていません。setup()を実行してください。');
  let d = salt + ':' + pw;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    d = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d + pepper, Utilities.Charset.UTF_8));
  }
  return d;
}

function toHex_(bytes) {
  return bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

function tempPassword_() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const all = letters + '23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now() + Utilities.getUuid());
  let out = '';
  for (let i = 0; i < 10; i++) out += all.charAt((bytes[i] & 255) % all.length);
  out = letters.charAt((bytes[20] & 255) % letters.length) + out.slice(1, 9) + '23456789'.charAt((bytes[21] & 255) % 8);
  return out;
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function sendMail_(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: APP_NAME });
}

function appUrlLine_() {
  const u = prop_('APP_URL', '');
  return u ? '\n' + u + '\n' : '';
}

function subFolder_(name) {
  const id = prop_('DRIVE_FOLDER_ID', '');
  if (!id) throw appErr_('Driveフォルダが未設定です。setup()を実行してください。');
  const root = DriveApp.getFolderById(id);
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function hoursLeft_(deadline, nowD) {
  const d = Utilities.parseDate(String(deadline).slice(0, 16), tz_(), "yyyy-MM-dd'T'HH:mm");
  return (d.getTime() - nowD.getTime()) / 3600000;
}

function leftText_(deadline, nowD) {
  const h = hoursLeft_(deadline, nowD);
  if (h < 0) return Math.ceil(-h) >= 24 ? Math.floor(-h / 24) + '日超過' : Math.ceil(-h) + '時間超過';
  return h < 24 ? 'あと' + Math.max(1, Math.round(h)) + '時間' : 'あと' + Math.floor(h / 24) + '日';
}

function speakDT_(dt) {
  const m = String(dt).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return dt;
  const hh = Number(m[4]);
  const ampm = hh < 12 ? '午前' : '午後';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return Number(m[2]) + '月' + Number(m[3]) + '日の' + ampm + h12 + '時' + (m[5] !== '00' ? Number(m[5]) + '分' : '');
}

function speakDate_(d) {
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Number(m[2]) + '月' + Number(m[3]) + '日' : d;
}

function appErr_(msg, code) { const e = new Error(msg); e.code = code || ''; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function prop_(k, d) { const v = PropertiesService.getScriptProperties().getProperty(k); return v === null || v === '' ? d : v; }
function tz_() { return Session.getScriptTimeZone() || 'Asia/Tokyo'; }
function now_() { return Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm:ss"); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function isEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function safeName_(s) { return String(s).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40); }
