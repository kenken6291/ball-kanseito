# ボール管制塔～タスク管理（ball-kanseito） v1.3.0

抱えている用事を「便」として発着案内板に並べ、締め切り・今日の成果・残り・**いま誰がボールを持っているか**を一目で見張るマルチタスク管理アプリ。完了は「着陸」、締め切り間近は「最終案内」、超過は「遅延」。AI管制官（Gemini）が状況を実況し、Gemini TTS で読み上げます。

---

## 1. 全体アーキテクチャ

```
[ブラウザ / GitHub Pages]
  index.html ─ style.css ─ config.js ─ app.js
  assets/earth/*.mp4（Google Earth Studio 書き出し映像）
        │  POST (Content-Type: text/plain, JSON {action, token, ...})
        ▼
[Google Apps Script ウェブアプリ  Code.gs]
  ├─ 認証：仮パスワード発行・強制変更・再発行・5回失敗で15分ロック
  │        SHA-256 × 300回（salt + pepper）／セッションは CacheService（6時間・アクセスで延長）
  ├─ CRUD：Tasks / Logs（スプレッドシート）
  ├─ 音声・ひとこと登録：parseTask → Gemini が文（または録音音声）から名前・分類・開始日・締め切り・返事待ちの相手を JSON で返す。
  │        日付の取り違え防止に、今日から6週間のカレンダー表を毎回プロンプトに渡す
  ├─ 実況：Gemini generateContent → 前置き除去クリーナー → テキスト
  ├─ 読み上げ：Gemini TTS（PCM）→ WAV 化 → Base64 でブラウザへ ＋ Drive/audio に保存
  ├─ スクショ：ブラウザで縮小（幅1280px・JPEG）→ Drive/shots に保存、表示時は getShot で本人だけ取得
  ├─ バックアップ：JSON を Drive/backup に保存
  └─ メール：MailApp で仮パスワード送信
        │
        ├─ Google スプレッドシート「ボール管制塔_DB」
        ├─ Google ドライブ「ボール管制塔_データ」（audio / backup）
        └─ Gemini API（キーは GAS のスクリプトプロパティにのみ保存）
```

### データフロー（例：着陸）
1. 「着陸」→ `saveTask`（status=完了）→ GAS が `completedAt` を記録
2. ブラウザで XP を再計算 → Earth Studio の着陸映像を全画面再生
3. `narrate`（type=complete）→ Gemini が祝福実況 → TTS 音声を返却 → 再生（失敗時はブラウザ内蔵読み上げ）

### スプレッドシート定義（setup() が自動作成）

| シート | 列 |
|---|---|
| Users | email, nickname, salt, hash, mustChange, failCount, lockedUntil, createdAt, lastLogin |
| Tasks | taskId, email, title, category, deadline(yyyy-MM-ddTHH:mm), status(未着手/進行中/保留/完了), nextAction, ballHolder(me/other), waitName・waitDept・waitContact・ballDue（v1.0の列。v1.1では未使用）, createdAt, updatedAt, completedAt, **waiters**, **links**, **shots**, **startDate**(yyyy-MM-dd) |
| Logs | logId, taskId, email, date(yyyy-MM-dd), text, createdAt |
| Narrations | id, email, type(briefing/complete/deadline), text, audioFileId, createdAt |

文字列はアポストロフィ付きで書き込み、日付の自動変換と数式注入を防いでいます。

- **waiters**（JSON配列、最大200人）：`{id, name, dept, contact, due, replied}`。contact はメール・電話・URL のどれでも可。
- **links**（JSON配列、最大10件）：`{label, url}`。label が空なら URL から「調整さん」「LINE」「Googleフォーム」などを自動判定。
- **shots**（JSON配列、最大20枚）：`{fileId, label, at}`。LINEなどURLのない確認先のスクリーンショット。画像本体は Drive の「ボール管制塔_データ/shots」に非公開で保存し、ファイルの説明欄に持ち主（メールのハッシュ）を記録。本人以外は `getShot` で読めません。
- **startDate**：工程表のバーの開始日。空のときは登録日から始まるバーとして表示。
- ボールの判定：ballHolder=other かつ未回答（replied=false）が1人以上いれば「相手の手元」。全員回答済みになると自動で「自分の手元」に戻ります。
- v1.0 で1人だけ登録していた返事待ちは、読み込み時に waiters へ自動移行されます。列の追加もサーバーが自動で行うので、setup() の再実行は不要です。

### XP と階級（ブラウザで計算）
記録 +10 ／ 着陸 +50 ／ 締め切り内の着陸 +30。
訓練生 0 → 副操縦士 200 → 機長 500 → 編隊長 1000 → 管制官 2000 → 宇宙管制官 4000 → 銀河航路長 8000

### TTS 用テキストの二重ガード
1. システムプロンプトで「本文のみ・前置き/ラベル/演出指示/括弧注釈/改行なし」を厳命
2. `cleanNarration_()` で「承知しました」「以下が」「ナレーション：」「（明るく読んで）」などを機械的に除去
3. TTS には本文だけを渡す（声色の指示文は混ぜず、声は `TTS_VOICE` で指定）

---

## 2. ファイル構成

```
ball-kanseito/
├─ index.html
├─ style.css
├─ config.js
├─ app.js
├─ assets/earth/
│   ├─ bg-orbit.mp4   背景ループ
│   ├─ bg-orbit.jpg   背景ポスター（動画が流れない端末用）
│   └─ landing.mp4    着陸演出
└─ gas/
    ├─ Code.gs
    └─ appsscript.json
```

---

## 3. Google Earth Studio 連携手順

1. https://earth.google.com/studio/ を開き、Googleアカウントで利用開始。
2. **背景ループ（bg-orbit）**
   - 新規プロジェクト → クイックスタートの「Orbit（周回）」を選び、対象に日本全体や地球を指定。
   - 長さ 30秒、30fps、1280×720。始点と終点のカメラ角度をそろえるとループの継ぎ目が目立ちません。
3. **着陸演出（landing）**
   - 「Fly To」で上空から空港（例：羽田空港）へ降下するカメラを作成。長さ 5〜6秒。
4. **レンダリング**：Render → 解像度 1280×720 →「Attribution（帰属表示）」をオンのまま書き出し。JPEG 連番が zip で届きます。
5. **MP4 化（ffmpeg、Windows の例）**
   ```bat
   ffmpeg -framerate 30 -i "footage\bg-orbit_%03d.jpeg" -c:v libx264 -pix_fmt yuv420p -crf 30 -an -movflags +faststart bg-orbit.mp4
   ffmpeg -framerate 30 -i "footage\landing_%03d.jpeg"  -c:v libx264 -pix_fmt yuv420p -crf 28 -an -movflags +faststart landing.mp4
   ffmpeg -i bg-orbit.mp4 -frames:v 1 -q:v 4 bg-orbit.jpg
   ```
   連番のファイル名は書き出し時のプロジェクト名になるので、`-i` の部分を合わせてください。目安は背景 5MB 以下、着陸 2MB 以下。
6. **配置**：`assets/earth/` に置いて GitHub へ push。ファイル名を変えた場合は `config.js` の `EARTH` を修正。
7. **Drive の扱い**：書き出し元の連番・高画質版は Drive に保管して構いませんが、配信は GitHub Pages から行ってください（Drive の動画は `<video>` で安定して再生できません）。
8. **帰属表示**：Earth Studio の映像を使う画面には「Google Earth」の表示が必要です。フッターに常時表示しています。

動画が無い／自動再生できない端末／「動きを減らす」設定の端末では、自動で映像なしの演出に切り替わります。

---

## 4. デプロイ・セットアップ手順

### GAS
1. https://script.google.com で新しいプロジェクトを作成（名前：ball-kanseito）。
2. 「プロジェクトの設定」→「appsscript.json をエディタで表示する」をオン → `gas/appsscript.json` の内容で置き換え。
3. `Code.gs` に `gas/Code.gs` の内容を貼り付けて保存。
4. 関数 `setup` を選んで実行 → 権限を承認。ログにスプレッドシートと Drive フォルダの URL が出ます。
5. 「プロジェクトの設定」→「スクリプト プロパティ」に追加：

   | プロパティ | 必須 | 値 |
   |---|---|---|
   | GEMINI_API_KEY | ○ | Google AI Studio で発行したキー |
   | GEMINI_MODEL | | 実況用モデル（既定 gemini-2.5-flash） |
   | TTS_MODEL | | 読み上げ用モデル（既定 gemini-2.5-flash-preview-tts） |
   | TTS_VOICE | | 声の名前（既定 Puck。Kore、Aoede なども可） |
   | APP_URL | | GitHub Pages の URL（メール本文に記載） |

   SPREADSHEET_ID・DRIVE_FOLDER_ID・PEPPER は setup() が自動で入れます。PEPPER は後から変えると全員ログインできなくなるので触らないでください。
   モデル名は新しいものが出たらプロパティだけ書き換えれば切り替わります。
6. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」→ 実行ユーザー「自分」、アクセス「全員」→ デプロイ → URL をコピー。

> **GAS のコードを変更したら**、「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」→ デプロイ。これをしないと変更が反映されません（URL は変わりません）。

### GitHub Pages
1. リポジトリ `ball-kanseito` を作成し、`index.html / style.css / config.js / app.js / assets/` を push（`gas/` は控えとして入れておいても公開上の問題はありません。キーは含まれていません）。
2. `config.js` の `GAS_URL` にコピーした URL を貼る（または画面の「接続設定」で入力）。
3. Settings → Pages → Branch: `main` / `/(root)` → Save。
4. 数分後、`https://kenken6291.github.io/ball-kanseito/` で公開。

### 初回起動
1. 「新規登録」でメールアドレスとニックネームを入力 → 仮パスワードのメールを受信。
2. 仮パスワードでログイン → 本パスワード設定画面で変更。
3. 使い方ガイドが自動表示 →「はじめる」→ 最初のミッションを登録。
4. 「管制塔の実況を聞く」で Gemini と TTS の動作を確認。

### 更新履歴
- v1.3.0：音声・ひとこと登録（マイクで話す／一文で書く → AIが入力欄を自動で埋める。音声認識が使えない端末は録音してGeminiで聞き取り）、締め切りの日付・時刻ボタン（今日中・明日・今週金曜・来週月曜・月末・±1日など）と開始日、工程表（ガントチャート：分類ごとの段・週末と今日の表示・返事の期日と記録の印・日／週の切り替え、バーのドラッグで日程移動・両端で開始日／締め切り変更・元に戻す、キーボードの←→でも移動）
- v1.2.1：サイト名を「ボール管制塔～タスク管理」に変更
- v1.2.0：返事の確認先にスクリーンショットを登録（LINEなどURLのない確認先用。ファイル選択・Ctrl+V貼り付け、拡大表示・前後送り・保存、保存しなかった画像やミッション削除時の画像は自動でゴミ箱へ）
- v1.1.0：返事待ちを複数人に対応（まとめて追加・全員の期日・その場で回答済みチェック・BCCでまとめて催促）、返事の確認先URL（調整さん・LINEなど）を登録可能に
- v1.0.0：初版

### バージョンを上げるとき
`config.js` の `VERSION` と `Code.gs` の `APP_VERSION` をそろえて更新。画面右下とログイン画面、設定画面に表示されます。
