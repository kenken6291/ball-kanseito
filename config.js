/**
 * ボール管制塔～タスク管理 — 設定ファイル
 * GAS_URL は画面の「接続設定」からも上書きできます（ブラウザに保存され、こちらより優先）。
 */
window.APP_CONFIG = {
  APP_NAME: 'ボール管制塔～タスク管理',
  VERSION: 'v1.4.0',

  // GASウェブアプリのURL（https://script.google.com/macros/s/.../exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwRtwC8UG6W3MoMJggg0iBrUm0cefnffG9Ynyu-wrUjsbzturdanPJ-zlJwZJvkpqdvRQ/exec',

  // 既定のGeminiモデル（ユーザーが画面で選ばなかった時に使う）
  // 空文字 '' = 自動（汎用の最新モデル）
  GEMINI_MODEL: '',

  // 画面の「設定 > AIモデル」の選択肢（value がAPIのモデルID）
  // 指定モデルに該当がない（廃止・未公開・名前違い）場合は
  // GAS側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' }
  ],

  // 締め切りまで何時間を切ったら「最終案内」にするか
  DEADLINE_WARN_HOURS: 48,

  // 音声で登録するとき、何秒黙ったら話し終わりとみなすか（画面の設定で変更可）
  VOICE_SILENCE_SEC: 3,

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
