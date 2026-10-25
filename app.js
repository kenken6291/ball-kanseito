/* =========================================================
   ボール管制塔 — app.js v1.0.0
   認証 / 案内板描画 / ボール所在 / 本日の記録 / XP・階級
   実況（Gemini + TTS 再生）/ Google Earth Studio 映像演出
   ========================================================= */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const EARTH = CFG.EARTH || {};
  const WARN_H = Number(CFG.DEADLINE_WARN_HOURS || 48);
  const LS = {
    token: 'bk_token', gas: 'bk_gas_url', voice: 'bk_voice', bg: 'bk_bg',
    auto: 'bk_auto_narrate', onboard: 'bk_onboarded'
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const state = {
    token: store(LS.token) || '',
    user: null,
    tasks: [],
    logs: [],
    filter: 'all',
    animate: true,
    lastNarration: null,
    finalCallShown: false
  };

  const STATUS = {
    '未着手': { label: '搭乗待ち', cls: 'st-wait' },
    '進行中': { label: '飛行中', cls: 'st-fly' },
    '保留': { label: '待機旋回', cls: 'st-hold' },
    '完了': { label: '着陸', cls: 'st-done' }
  };

  const RANKS = [
    [0, '訓練生'], [200, '副操縦士'], [500, '機長'], [1000, '編隊長'],
    [2000, '管制官'], [4000, '宇宙管制官'], [8000, '銀河航路長']
  ];

  const ICON_EYE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></g></svg>';
  const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></g></svg>';
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

  /* ---------------- 共通 ---------------- */
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* プライベートモード等 */ }
    return null;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const todayStr = () => ymd(new Date());
  const parseDT = s => (s ? new Date(String(s).length === 10 ? s + 'T00:00' : s) : null);
  const fmtDT = s => { const d = parseDT(s); return d ? pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—'; };
  const fmtD = s => { const d = parseDT(s); return d ? (d.getMonth() + 1) + '/' + d.getDate() : ''; };
  const fmtTime = s => { const d = parseDT(s); return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''; };
  const hoursLeft = s => { const d = parseDT(s); return d ? (d.getTime() - Date.now()) / 3600000 : null; };
  function fmtLeft(h) {
    if (h === null) return '締め切りなし';
    if (h < 0) { const o = -h; return o >= 24 ? Math.floor(o / 24) + '日超過' : Math.ceil(o) + '時間超過'; }
    if (h < 1) return 'あと' + Math.max(1, Math.round(h * 60)) + '分';
    if (h < 24) return 'あと' + Math.round(h) + '時間';
    return 'あと' + Math.floor(h / 24) + '日';
  }
  const gasUrl = () => (store(LS.gas) || CFG.GAS_URL || '').trim();
  const findTask = id => state.tasks.find(t => t.taskId === id);
  const isOpen = t => t.status !== '完了';

  async function api(action, data = {}) {
    const url = gasUrl();
    if (!url) {
      openSettings();
      throw new Error('GASのURLが設定されていません。「設定」で入力してください。');
    }
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, data, { action: action, token: state.token }))
      });
    } catch (e) {
      throw new Error('サーバーにつながりません。通信状態とGASのURLを確認してください。');
    }
    if (!res.ok) throw new Error('サーバーエラー（' + res.status + '）が起きました。');
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('サーバーの応答を読み取れません。GASのデプロイ設定（全員がアクセス可）を確認してください。'); }
    if (!json.ok) {
      if (json.code === 'AUTH') { clearSession(); showAuth('login'); }
      if (json.code === 'MUST_CHANGE') showAuth('change');
      const err = new Error(json.error || 'エラーが起きました。');
      err.code = json.code;
      throw err;
    }
    return json;
  }

  let toastTimer = 0;
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>';
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { el.hidden = true; action.run(); });
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 9000 : 3200);
  }

  function setBusy(form, busy) {
    $$('button, input, select, textarea', form).forEach(el => { if (el.type !== 'hidden') el.disabled = busy; });
  }
  function formMsg(form, msg, ok) {
    const p = $('.form-msg', form);
    if (!p) return;
    p.textContent = msg || '';
    p.classList.toggle('ok', !!ok);
  }

  /* ---------------- 認証 ---------------- */
  function showAuth(view) {
    $('#appView').hidden = true;
    $('#authView').hidden = false;
    $$('.auth-form').forEach(f => { f.hidden = f.dataset.view !== view; formMsg(f, ''); });
    const f = $('.auth-form[data-view="' + view + '"]');
    const first = f && $('input', f);
    if (first) setTimeout(() => first.focus(), 50);
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    state.tasks = [];
    state.logs = [];
    store(LS.token, null);
  }

  async function logout() {
    try { if (state.token) await api('logout'); } catch (e) { /* 失効済みでも続行 */ }
    stopAudio();
    clearSession();
    showAuth('login');
  }

  function bindAuth() {
    $$('[data-go]').forEach(b => b.addEventListener('click', () => {
      const from = b.closest('.auth-form');
      const to = $('.auth-form[data-view="' + b.dataset.go + '"]');
      const email = from && from.elements.email && from.elements.email.value;
      showAuth(b.dataset.go);
      if (email && to.elements.email) to.elements.email.value = email;
    }));

    $('.auth-form[data-view="login"]').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.currentTarget;
      formMsg(f, '');
      setBusy(f, true);
      try {
        const r = await api('login', { email: f.elements.email.value, password: f.elements.password.value });
        state.token = r.token;
        store(LS.token, r.token);
        state.user = r.user;
        f.elements.password.value = '';
        if (r.user.mustChange) showAuth('change'); else enterApp();
      } catch (err) { formMsg(f, err.message); }
      finally { setBusy(f, false); }
    });

    $('.auth-form[data-view="register"]').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.currentTarget;
      formMsg(f, '');
      setBusy(f, true);
      try {
        const r = await api('register', { email: f.elements.email.value, nickname: f.elements.nickname.value });
        const email = f.elements.email.value;
        showAuth('login');
        const lf = $('.auth-form[data-view="login"]');
        lf.elements.email.value = email;
        formMsg(lf, r.message, true);
        lf.elements.password.focus();
      } catch (err) { formMsg(f, err.message); }
      finally { setBusy(f, false); }
    });

    $('.auth-form[data-view="forgot"]').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.currentTarget;
      formMsg(f, '');
      setBusy(f, true);
      try {
        const r = await api('resetPassword', { email: f.elements.email.value });
        const email = f.elements.email.value;
        showAuth('login');
        const lf = $('.auth-form[data-view="login"]');
        lf.elements.email.value = email;
        formMsg(lf, r.message, true);
      } catch (err) { formMsg(f, err.message); }
      finally { setBusy(f, false); }
    });

    $('.auth-form[data-view="change"]').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.currentTarget;
      const cur = f.elements.currentPassword.value;
      const next = f.elements.newPassword.value;
      if (next !== f.elements.confirmPassword.value) { formMsg(f, '確認用のパスワードが一致しません。'); return; }
      if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) { formMsg(f, '英字と数字を含む8文字以上にしてください。'); return; }
      formMsg(f, '');
      setBusy(f, true);
      try {
        const r = await api('changePassword', { currentPassword: cur, newPassword: next });
        state.user = r.user;
        f.reset();
        toast('パスワードを変更しました。管制塔へようこそ。');
        enterApp();
      } catch (err) { formMsg(f, err.message); }
      finally { setBusy(f, false); }
    });

    // 目アイコン（表示／非表示）
    $$('.eye').forEach(b => { b.innerHTML = ICON_EYE; });
    document.addEventListener('click', e => {
      const b = e.target.closest('.eye');
      if (!b) return;
      const input = b.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = show ? ICON_EYE_OFF : ICON_EYE;
      b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      b.setAttribute('aria-pressed', String(show));
    });
  }

  /* ---------------- アプリ本体 ---------------- */
  async function enterApp() {
    $('#authView').hidden = true;
    $('#appView').hidden = false;
    applyBackground();
    renderGreeting();
    renderAll();
    await loadAll();
    if (!store(LS.onboard)) {
      store(LS.onboard, '1');
      $('#helpDialog').showModal();
    }
  }

  async function loadAll() {
    $('#boardEmpty').hidden = false;
    $('#boardEmpty').textContent = '案内板を読み込んでいます…';
    try {
      const r = await api('listAll');
      state.tasks = r.tasks || [];
      state.logs = r.logs || [];
      state.animate = true;
      renderAll();
      checkFinalCall();
    } catch (err) {
      $('#boardEmpty').textContent = err.message;
    }
  }

  function renderAll() {
    renderBoard();
    renderCourt();
    renderToday();
    renderRank();
    renderCategories();
  }

  function renderGreeting() {
    const h = new Date().getHours();
    const g = h < 5 ? '夜間飛行おつかれさまです' : h < 11 ? 'おはようございます' : h < 17 ? 'こんにちは' : 'こんばんは';
    $('#greet').textContent = state.user ? g + '、' + state.user.nickname + '機長。' : '';
  }

  function updateClock() {
    const d = new Date();
    $('#clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* --- 状況判定 --- */
  function boardStatus(t) {
    if (t.status === '完了') return STATUS['完了'];
    const h = hoursLeft(t.deadline);
    if (h !== null && h < 0) return { label: '遅延', cls: 'st-late' };
    if (h !== null && h <= WARN_H) return { label: '最終案内', cls: 'st-final' };
    return STATUS[t.status] || STATUS['未着手'];
  }

  function flightCodes() {
    const map = {};
    state.tasks.slice()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .forEach((t, i) => { map[t.taskId] = 'BK' + String(i + 1).padStart(3, '0'); });
    return map;
  }

  function compareTasks(a, b) {
    const rank = t => {
      if (!isOpen(t)) return 3;
      const h = hoursLeft(t.deadline);
      if (h === null) return 2;
      return h < 0 ? 0 : 1;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 3) return String(b.completedAt).localeCompare(String(a.completedAt));
    if (ra === 2) return String(a.createdAt).localeCompare(String(b.createdAt));
    return String(a.deadline).localeCompare(String(b.deadline));
  }

  function filteredTasks() {
    const f = state.filter;
    return state.tasks.filter(t => {
      if (f === 'done') return !isOpen(t);
      if (!isOpen(t)) return false;
      if (f === 'mine') return t.ballHolder !== 'other';
      if (f === 'them') return t.ballHolder === 'other';
      return true;
    }).sort(compareTasks);
  }

  function flap(text, anim, offset) {
    return Array.from(String(text)).map((ch, i) =>
      '<i style="--d:' + (anim ? (offset || 0) + i * 45 : 0) + 'ms">' + esc(ch) + '</i>'
    ).join('');
  }

  /* --- 案内板 --- */
  function renderBoard() {
    const list = $('#boardList');
    const tasks = filteredTasks();
    const codes = flightCodes();
    const anim = state.animate && !reduceMotion;
    const today = todayStr();

    list.innerHTML = tasks.map((t, idx) => {
      const st = boardStatus(t);
      const h = hoursLeft(t.deadline);
      const them = t.ballHolder === 'other';
      const ballOver = them && t.ballDue && t.ballDue < today && isOpen(t);
      const fc = anim ? ' anim' : '';
      const delay = idx * 70;

      const ballHtml = them
        ? '<span class="c-ball them' + (ballOver ? ' overdue' : '') + '"><span class="dot"></span><span>' + esc(t.waitName) + 'の返事待ち'
          + '<small>' + (t.ballDue ? (ballOver ? '回答遅延 ' : '回答期日 ') + esc(fmtD(t.ballDue)) : '期日未設定') + (t.waitDept ? '／' + esc(t.waitDept) : '') + '</small></span></span>'
        : '<span class="c-ball me"><span class="dot"></span><span>自分<small>' + (isOpen(t) ? 'ボールは手元' : '') + '</small></span></span>';

      const acts = isOpen(t)
        ? '<button type="button" data-act="log">記録</button><button type="button" data-act="edit">編集</button><button type="button" data-act="done">着陸</button>'
        : '<button type="button" data-act="edit">編集</button>';

      return '<li class="row ' + st.cls + (isOpen(t) ? '' : ' is-done') + '" data-id="' + esc(t.taskId) + '">'
        + '<span class="c-flight"><span class="flap' + fc + '">' + flap(codes[t.taskId] || 'BK---', anim, delay) + '</span></span>'
        + '<span class="c-title"><b>' + esc(t.title) + '</b><small>'
        + (t.category ? '<span class="cat">' + esc(t.category) + '</span>' : '')
        + (t.nextAction ? '次：' + esc(t.nextAction) : '') + '</small></span>'
        + '<span class="c-deadline"><time' + (t.deadline ? ' datetime="' + esc(t.deadline) + '"' : '') + '>' + esc(t.deadline ? fmtDT(t.deadline) : '—') + '</time>'
        + '<small>' + esc(isOpen(t) ? fmtLeft(h) : '着陸 ' + fmtDT(t.completedAt)) + '</small></span>'
        + ballHtml
        + '<span class="c-status"><span class="flap' + fc + '">' + flap(st.label, anim, delay + 200) + '</span></span>'
        + '<span class="c-act">' + acts + '</span>'
        + '</li>';
    }).join('');

    const empty = $('#boardEmpty');
    if (tasks.length) {
      empty.hidden = true;
    } else {
      empty.hidden = false;
      empty.textContent = {
        all: '運航中の便はありません。「＋ ミッションを登録」から最初の便を登録しましょう。',
        mine: '自分の手元にあるボールはありません。',
        them: '返事待ちの便はありません。',
        done: 'まだ着陸した便はありません。'
      }[state.filter];
    }
    state.animate = false;
  }

  /* --- ボールの所在 --- */
  function chaseLink(t) {
    const c = String(t.waitContact || '').trim();
    if (/^[^\s@]+@[^\s@]+$/.test(c)) {
      const subject = '【ご確認のお願い】' + t.title;
      const body = (t.waitName || '') + ' 様\n\nお世話になっております。\n「' + t.title + '」の件、その後のご状況はいかがでしょうか。\nお手すきの際にご連絡いただけますと幸いです。\n\n' + (state.user ? state.user.nickname : '');
      return 'mailto:' + c + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    }
    const tel = c.replace(/[^\d+]/g, '');
    return tel.length >= 10 ? 'tel:' + tel : '';
  }

  function renderCourt() {
    const open = state.tasks.filter(isOpen);
    const mine = open.filter(t => t.ballHolder !== 'other').sort(compareTasks);
    const them = open.filter(t => t.ballHolder === 'other')
      .sort((a, b) => String(a.ballDue || '9999').localeCompare(String(b.ballDue || '9999')));
    const today = todayStr();

    $('#ballMineCount').textContent = mine.length;
    $('#ballThemCount').textContent = them.length;

    $('#ballMine').innerHTML = mine.length
      ? mine.slice(0, 5).map(t => '<li><b>' + esc(t.title) + '</b><small>'
          + esc(t.nextAction ? '次：' + t.nextAction : fmtLeft(hoursLeft(t.deadline))) + '</small></li>').join('')
        + (mine.length > 5 ? '<li class="empty">ほか ' + (mine.length - 5) + '件</li>' : '')
      : '<li class="empty">手元のボールはゼロ。相手の返事を待つあいだに一息どうぞ。</li>';

    $('#ballThem').innerHTML = them.length
      ? them.map(t => {
          const over = t.ballDue && t.ballDue < today;
          const link = chaseLink(t);
          return '<li class="' + (over ? 'overdue' : '') + '"><b>' + esc(t.waitName) + (t.waitDept ? '（' + esc(t.waitDept) + '）' : '') + '</b>'
            + esc(t.title)
            + '<small>' + (t.ballDue ? (over ? '回答期日を過ぎています（' + esc(fmtD(t.ballDue)) + '）' : '回答期日 ' + esc(fmtD(t.ballDue))) : '回答期日は未設定') + '</small>'
            + (link && over ? '<a href="' + esc(link) + '">' + (link.indexOf('tel:') === 0 ? '電話で確認する' : '催促メールの下書きを開く') + '</a>' : '')
            + '</li>';
        }).join('')
      : '<li class="empty">相手に預けているボールはありません。</li>';
  }

  /* --- 本日の記録 --- */
  function streakDays() {
    const days = new Set(state.logs.map(l => l.date));
    const d = new Date();
    if (!days.has(ymd(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function renderToday() {
    const today = todayStr();
    const titleOf = {};
    state.tasks.forEach(t => { titleOf[t.taskId] = t.title; });
    const logs = state.logs.filter(l => l.date === today)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const landed = state.tasks.filter(t => !isOpen(t) && String(t.completedAt).slice(0, 10) === today);

    $('#stLogs').textContent = logs.length;
    $('#stLanded').textContent = landed.length;
    $('#stRemain').textContent = state.tasks.filter(isOpen).length;
    $('#stStreak').textContent = streakDays() + '日';

    $('#todayLogs').innerHTML = logs.length
      ? logs.map(l => '<li data-log="' + esc(l.logId) + '"><time>' + esc(fmtTime(l.createdAt)) + '</time>'
          + '<span><b>' + esc(titleOf[l.taskId] || '（削除された便）') + '</b>' + esc(l.text) + '</span>'
          + '<button type="button" class="del" aria-label="この記録を削除">×</button></li>').join('')
      : '<li class="empty">今日の記録はまだありません。案内板の「記録」から、やったことを1行書いてみましょう。</li>';
  }

  /* --- XP・階級 --- */
  function calcXP() {
    let xp = state.logs.length * 10;
    state.tasks.forEach(t => {
      if (isOpen(t)) return;
      xp += 50;
      if (t.deadline && t.completedAt && parseDT(t.completedAt) <= parseDT(t.deadline)) xp += 30;
    });
    return xp;
  }

  function renderRank() {
    const xp = calcXP();
    let i = 0;
    while (i + 1 < RANKS.length && xp >= RANKS[i + 1][0]) i++;
    const cur = RANKS[i];
    const next = RANKS[i + 1];
    const pct = next ? ((xp - cur[0]) / (next[0] - cur[0])) * 100 : 100;
    $('#rankTitle').textContent = cur[1];
    $('#rankLv').textContent = 'Lv.' + (i + 1);
    $('#xpFill').style.width = Math.min(100, Math.max(2, pct)) + '%';
    $('#xpText').textContent = xp + ' XP' + (next ? '／次まで ' + (next[0] - xp) : '');
    return { xp: xp, rank: cur[1] };
  }

  function renderCategories() {
    const cats = Array.from(new Set(state.tasks.map(t => t.category).filter(Boolean)));
    $('#catList').innerHTML = cats.map(c => '<option value="' + esc(c) + '">').join('');
  }

  function checkFinalCall() {
    if (state.finalCallShown) return;
    const urgent = state.tasks.filter(t => isOpen(t) && t.deadline && hoursLeft(t.deadline) <= WARN_H);
    if (!urgent.length) return;
    state.finalCallShown = true;
    toast('最終案内・遅延の便が ' + urgent.length + '件あります。', { label: '最終案内を聞く', run: () => narrate('deadline') });
  }

  /* ---------------- ミッション編集 ---------------- */
  function syncWaitFields() {
    const f = $('#taskForm');
    const other = f.elements.ballHolder.value === 'other';
    $('.wait-fields', f).hidden = !other;
  }

  function openTaskDialog(t) {
    const f = $('#taskForm');
    f.reset();
    formMsg(f, '');
    const isNew = !t;
    $('#taskDialogTitle').textContent = isNew ? 'ミッションを登録' : 'ミッションを編集';
    $('#taskDelete').hidden = isNew;
    const v = t || { status: '未着手', ballHolder: 'me' };
    ['taskId', 'title', 'category', 'deadline', 'status', 'nextAction', 'waitName', 'waitDept', 'waitContact', 'ballDue']
      .forEach(k => { if (f.elements[k]) f.elements[k].value = v[k] || (k === 'status' ? '未着手' : ''); });
    $$('input[name="ballHolder"]', f).forEach(r => { r.checked = r.value === (v.ballHolder === 'other' ? 'other' : 'me'); });
    syncWaitFields();
    $('#taskDialog').showModal();
    setTimeout(() => f.elements.title.focus(), 30);
  }

  function readTaskForm() {
    const f = $('#taskForm');
    const o = {};
    ['taskId', 'title', 'category', 'deadline', 'status', 'nextAction', 'waitName', 'waitDept', 'waitContact', 'ballDue']
      .forEach(k => { o[k] = f.elements[k].value.trim(); });
    o.ballHolder = f.elements.ballHolder.value === 'other' ? 'other' : 'me';
    return o;
  }

  function replaceTask(task) {
    const i = state.tasks.findIndex(t => t.taskId === task.taskId);
    if (i >= 0) state.tasks[i] = task; else state.tasks.push(task);
  }

  async function submitTask(e) {
    e.preventDefault();
    const f = $('#taskForm');
    const data = readTaskForm();
    if (!data.title) { formMsg(f, 'ミッション名を入力してください。'); return; }
    if (data.ballHolder === 'other' && !data.waitName) { formMsg(f, 'ボールを持っている相手の名前を入力してください。'); return; }
    const before = findTask(data.taskId);
    const xpBefore = calcXP();
    setBusy(f, true);
    try {
      const r = await api('saveTask', { task: data });
      replaceTask(r.task);
      state.animate = true;
      $('#taskDialog').close();
      renderAll();
      if (r.justCompleted) celebrate(r.task, calcXP() - xpBefore);
      else toast(r.created ? '離陸許可が出ました。案内板に便を追加しました。' : (before ? '案内板を更新しました。' : '保存しました。'));
    } catch (err) { formMsg(f, err.message); }
    finally { setBusy(f, false); }
  }

  async function deleteTask() {
    const f = $('#taskForm');
    const id = f.elements.taskId.value;
    const t = findTask(id);
    if (!t || !confirm('「' + t.title + '」を削除します。記録も一緒に消えます。よろしいですか？')) return;
    setBusy(f, true);
    try {
      await api('deleteTask', { taskId: id });
      state.tasks = state.tasks.filter(x => x.taskId !== id);
      state.logs = state.logs.filter(l => l.taskId !== id);
      $('#taskDialog').close();
      renderAll();
      toast('便を案内板から外しました。');
    } catch (err) { formMsg(f, err.message); }
    finally { setBusy(f, false); }
  }

  /* ---------------- 今日の記録 ---------------- */
  function openLogDialog(t) {
    const f = $('#logForm');
    f.reset();
    formMsg(f, '');
    f.elements.taskId.value = t.taskId;
    f.elements.date.value = todayStr();
    f.elements.nextAction.value = t.nextAction || '';
    $('#logTaskTitle').textContent = t.title;
    $('#logDialog').showModal();
    setTimeout(() => f.elements.text.focus(), 30);
  }

  async function submitLog(e) {
    e.preventDefault();
    const f = $('#logForm');
    const text = f.elements.text.value.trim();
    if (!text) { formMsg(f, 'やったことを入力してください。'); return; }
    setBusy(f, true);
    try {
      const r = await api('addLog', {
        taskId: f.elements.taskId.value,
        date: f.elements.date.value,
        text: text,
        nextAction: f.elements.nextAction.value
      });
      state.logs.push(r.log);
      replaceTask(r.task);
      $('#logDialog').close();
      renderAll();
      toast('記録しました。+10 XP');
    } catch (err) { formMsg(f, err.message); }
    finally { setBusy(f, false); }
  }

  async function deleteLog(id) {
    if (!confirm('この記録を削除しますか？')) return;
    try {
      await api('deleteLog', { logId: id });
      state.logs = state.logs.filter(l => l.logId !== id);
      renderAll();
    } catch (err) { toast(err.message); }
  }

  /* ---------------- 着陸（完了） ---------------- */
  async function completeTask(id) {
    const t = findTask(id);
    if (!t) return;
    unlockAudio();
    const xpBefore = calcXP();
    try {
      const r = await api('saveTask', { task: Object.assign({}, t, { status: '完了' }) });
      replaceTask(r.task);
      state.animate = true;
      renderAll();
      celebrate(r.task, calcXP() - xpBefore);
    } catch (err) { toast(err.message); }
  }

  let landingTimer = 0;
  function celebrate(task, gained) {
    const ov = $('#landing');
    const v = $('#landingVideo');
    $('#landingTitle').textContent = task.title;
    $('#landingXp').textContent = '+' + gained + ' XP' + (gained >= 80 ? '　締め切り内ボーナス' : '');
    const useVideo = !reduceMotion && EARTH.landing;
    ov.classList.toggle('no-video', !useVideo);
    ov.hidden = false;
    $('#landingClose').focus();
    if (useVideo) {
      v.hidden = false;
      v.src = EARTH.landing;
      v.currentTime = 0;
      v.onerror = () => { v.hidden = true; ov.classList.add('no-video'); };
      v.play().catch(() => { v.hidden = true; ov.classList.add('no-video'); });
    } else {
      v.hidden = true;
    }
    clearTimeout(landingTimer);
    landingTimer = setTimeout(closeLanding, 9000);
    if (store(LS.auto) !== 'off') narrate('complete', task.taskId);
  }

  function closeLanding() {
    clearTimeout(landingTimer);
    const v = $('#landingVideo');
    v.pause();
    $('#landing').hidden = true;
  }

  /* ---------------- 実況（Gemini + TTS） ---------------- */
  const player = new Audio();
  let audioUnlocked = false;

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      player.src = SILENT_WAV;
      const p = player.play();
      if (p) p.catch(() => {});
    } catch (e) { /* noop */ }
  }

  function stopAudio() {
    try { player.pause(); } catch (e) { /* noop */ }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    setWave(false);
  }

  function setWave(on) {
    $('#radioWave').classList.toggle('on', on);
    $('#btnNarrate .wave').classList.toggle('on', on);
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.05;
    u.onstart = () => setWave(true);
    u.onend = () => setWave(false);
    u.onerror = () => setWave(false);
    speechSynthesis.speak(u);
  }

  function playNarration(n) {
    stopAudio();
    if (store(LS.voice) === 'off') return;
    if (n.audio) {
      player.src = 'data:' + (n.mime || 'audio/wav') + ';base64,' + n.audio;
      player.onplaying = () => setWave(true);
      player.onended = () => setWave(false);
      player.onpause = () => setWave(false);
      player.play().catch(() => { if (CFG.TTS_FALLBACK_WEBSPEECH !== false) speak(n.text); });
    } else if (CFG.TTS_FALLBACK_WEBSPEECH !== false) {
      speak(n.text);
    }
  }

  let typeTimer = 0;
  function typeOut(text) {
    const p = $('#radioText');
    clearInterval(typeTimer);
    p.classList.remove('pending');
    if (reduceMotion) { p.textContent = text; return; }
    let i = 0;
    p.textContent = '';
    typeTimer = setInterval(() => {
      i += 2;
      p.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(typeTimer);
    }, 40);
  }

  async function narrate(type, taskId) {
    unlockAudio();
    const radio = $('#radio');
    const p = $('#radioText');
    radio.hidden = false;
    $('#radioReplay').hidden = true;
    clearInterval(typeTimer);
    p.classList.add('pending');
    p.textContent = '管制塔と交信しています…';
    stopAudio();
    try {
      const r = await api('narrate', { type: type, taskId: taskId || '', tts: store(LS.voice) !== 'off' });
      state.lastNarration = r;
      typeOut(r.text);
      playNarration(r);
      $('#radioReplay').hidden = false;
    } catch (err) {
      p.classList.remove('pending');
      p.textContent = err.message;
    }
  }

  /* ---------------- Google Earth Studio 背景 ---------------- */
  function applyBackground() {
    const v = $('#bgVideo');
    const on = store(LS.bg) !== 'off' && !reduceMotion && !!EARTH.background;
    $('#earthAttr').textContent = EARTH.attribution || 'Google Earth';
    if (!on) {
      document.body.classList.remove('has-bg');
      v.pause();
      v.removeAttribute('src');
      v.load();
      return;
    }
    if (EARTH.backgroundPoster) v.poster = EARTH.backgroundPoster;
    if (!v.getAttribute('src')) v.src = EARTH.background;
    v.onerror = () => document.body.classList.remove('has-bg');
    v.oncanplay = () => document.body.classList.add('has-bg');
    v.play().catch(() => { /* 自動再生不可の端末は静止画（poster）のまま */ });
  }

  document.addEventListener('visibilitychange', () => {
    const v = $('#bgVideo');
    if (document.hidden) v.pause();
    else if (document.body.classList.contains('has-bg')) v.play().catch(() => {});
  });

  /* ---------------- 設定 ---------------- */
  function openSettings() {
    const d = $('#settingsDialog');
    if (d.open) return;
    const f = $('#settingsForm');
    formMsg(f, '');
    f.elements.gasUrl.value = store(LS.gas) || '';
    f.elements.gasUrl.placeholder = CFG.GAS_URL || 'https://script.google.com/macros/s/…/exec';
    f.elements.voice.checked = store(LS.voice) !== 'off';
    f.elements.autoNarrate.checked = store(LS.auto) !== 'off';
    f.elements.bg.checked = store(LS.bg) !== 'off';
    $('#pingResult').textContent = '';
    $('#backupResult').textContent = '';
    $('#backupBox').hidden = !state.token || $('#appView').hidden;
    d.showModal();
  }

  function saveSettings(e) {
    e.preventDefault();
    const f = $('#settingsForm');
    const url = f.elements.gasUrl.value.trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      formMsg(f, 'GASウェブアプリのURL（https://script.google.com/…/exec）を入力してください。');
      return;
    }
    store(LS.gas, url || null);
    store(LS.voice, f.elements.voice.checked ? null : 'off');
    store(LS.auto, f.elements.autoNarrate.checked ? null : 'off');
    store(LS.bg, f.elements.bg.checked ? null : 'off');
    if (!f.elements.voice.checked) stopAudio();
    $('#settingsDialog').close();
    if (!$('#appView').hidden) applyBackground();
    toast('設定を保存しました。');
  }

  async function pingServer() {
    const f = $('#settingsForm');
    const url = f.elements.gasUrl.value.trim() || CFG.GAS_URL;
    const out = $('#pingResult');
    if (!url) { out.textContent = 'URLを入力してください。'; return; }
    out.textContent = '確認しています…';
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping' }) });
      const j = await res.json();
      out.textContent = j.ok ? '接続できました（サーバー v' + j.version + '）' : '応答はありましたが、エラーでした：' + j.error;
    } catch (err) {
      out.textContent = '接続できません。URLとデプロイ設定を確認してください。';
    }
  }

  async function backup() {
    const out = $('#backupResult');
    out.textContent = '保存しています…';
    try {
      const r = await api('exportBackup');
      out.innerHTML = '保存しました：<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name) + '</a>';
    } catch (err) { out.textContent = err.message; }
  }

  /* ---------------- イベント配線 ---------------- */
  function bindApp() {
    $('#btnAdd').addEventListener('click', () => openTaskDialog(null));
    $('#btnNarrate').addEventListener('click', () => narrate('briefing'));

    $('#boardList').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const t = findTask(b.closest('.row').dataset.id);
      if (!t) return;
      if (b.dataset.act === 'log') openLogDialog(t);
      if (b.dataset.act === 'edit') openTaskDialog(t);
      if (b.dataset.act === 'done') completeTask(t.taskId);
    });

    $$('.seg button').forEach(b => b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      $$('.seg button').forEach(x => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      state.animate = true;
      renderBoard();
    }));

    $('#todayLogs').addEventListener('click', e => {
      const b = e.target.closest('.del');
      if (b) deleteLog(b.closest('li').dataset.log);
    });

    $('#taskForm').addEventListener('submit', submitTask);
    $('#taskForm').addEventListener('change', e => { if (e.target.name === 'ballHolder') syncWaitFields(); });
    $('#taskDelete').addEventListener('click', deleteTask);
    $('#logForm').addEventListener('submit', submitLog);
    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#btnPing').addEventListener('click', pingServer);
    $('#btnBackup').addEventListener('click', backup);

    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    $$('[data-open="settings"]').forEach(b => b.addEventListener('click', openSettings));
    $$('[data-open="help"]').forEach(b => b.addEventListener('click', () => $('#helpDialog').showModal()));
    $$('[data-act="logout"]').forEach(b => b.addEventListener('click', logout));

    $('#radioClose').addEventListener('click', () => { stopAudio(); $('#radio').hidden = true; });
    $('#radioReplay').addEventListener('click', () => { if (state.lastNarration) playNarration(state.lastNarration); });

    $('#landingClose').addEventListener('click', closeLanding);
    $('#landing').addEventListener('click', e => { if (e.target === e.currentTarget) closeLanding(); });
    $('#landingVideo').addEventListener('ended', () => { landingTimer = setTimeout(closeLanding, 1500); });

    // 1分ごとに時計と残り時間を更新（めくり演出なし）
    setInterval(() => {
      updateClock();
      if (!$('#appView').hidden) { renderBoard(); renderCourt(); }
    }, 60000);
  }

  /* ---------------- 起動 ---------------- */
  function init() {
    $$('.app-version').forEach(el => { el.textContent = CFG.VERSION || ''; });
    if (CFG.APP_NAME) document.title = CFG.APP_NAME;
    updateClock();
    bindAuth();
    bindApp();

    if (!gasUrl()) {
      showAuth('login');
      openSettings();
      formMsg($('#settingsForm'), '最初に、GASウェブアプリのURLを入力してください。');
      return;
    }
    if (!state.token) { showAuth('login'); return; }

    api('me')
      .then(r => {
        state.user = r.user;
        if (r.user.mustChange) showAuth('change'); else enterApp();
      })
      .catch(() => { clearSession(); showAuth('login'); });
  }

  init();
})();
