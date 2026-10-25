/**
 * ボール管制塔～タスク管理 — 設定ファイル
 * GAS_URL は画面の「接続設定」からも上書きできます（ブラウザに保存され、こちらより優先）。
 */
window.APP_CONFIG = {
  APP_NAME: 'ボール管制塔～タスク管理',
  VERSION: 'v1.2.1',

  // GASウェブアプリのURL（https://script.google.com/macros/s/.../exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwRtwC8UG6W3MoMJggg0iBrUm0cefnffG9Ynyu-wrUjsbzturdanPJ-zlJwZJvkpqdvRQ/exec',

  // 締め切りまで何時間を切ったら「最終案内」にするか
  DEADLINE_WARN_HOURS: 48,

  // Gemini TTS が失敗したとき、ブラウザ内蔵の読み上げで代替するか
  TTS_FALLBACK_WEBSPEECH: true,

  // Google Earth Studio で作った演出動画（GitHub Pages の assets/earth/ に置く）
  EARTH: {
    background: 'assets/earth/bg-orbit.mp4',   // 背景ループ（地球をゆっくり周回）
    backgroundPoster: 'assets/earth/bg-orbit.jpg',
    landing: 'assets/earth/landing.mp4',       // 完了時の着陸演出（5〜6秒）
    attribution: 'Google Earth'
  },

  // APIキー管理枠について：
  // GitHub Pages は誰でもソースを読めるため、Gemini APIキーはここに書かないでください。
  // キーは GAS の「スクリプトプロパティ」GEMINI_API_KEY に保存し、Gemini呼び出しはすべてGAS経由で行います。
  API_KEYS: {}
};
