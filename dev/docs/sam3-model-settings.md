# SAM3モデルパスの保存

ORIGINAL下のSAM3カードに、現在のモデルパスを表示する。入力欄を編集しただけでは設定を変更せず、「保存」で確定する。

- 保存先は `backend/.local/sam3-settings.json`。Git管理の対象外。
- `SAM3_SETTINGS_FILE` で保存先を変更できる。
- 起動時は保存済みのパスを優先し、未保存の場合は `SAM3_MODEL_PATH`、続いて `~/dev/models/vision/sam3.pt` を使う。
- `~` と相対パスをバックエンド側で絶対パスに変換して保存する。相対パスの基準はバックエンドの作業ディレクトリ。
- 保存後は読込済みモデルを解放し、次の推論で新しいパスから読み込む。モデル読込・推論中は保存を拒否し、再試行を案内する。
- ファイルの存在とモデルとしての利用可否は読込時に検証する。パスの保存成功はモデル読込の成功を意味しない。
- 保存に失敗した場合は現在の設定と入力内容を保持する。画面に失敗理由を表示する。

`GET /api/sam3/health` の `modelPath` で現在のパスを取得し、`POST /api/sam3/settings` に `{ "modelPath": "..." }` を送って保存する。同一オリジンとループバック接続の検査は既存の推論APIと共通。

## モデルの寿命と共有監視（2026-10-18）

- モデルの準備完了とGPU推論終了の新しい時刻から、既定600秒後に完全解放する。画像要求を取り消しても、成功したロードの完了時刻は更新する。
- パス変更ではモデル世代・保持時刻・直前の計測を無効化する。保存前から通信中だったhealthを画面へ再適用しない。
- 全パネルで1個の監視を共有する。ロード中1秒・通常10秒、通信失敗時は最大30秒。非表示タブでは周期監視を停止し、再表示時に更新する。画像を選ぶだけでは推論しない。
- healthの追加項目は`modelGeneration`、`loadCount`、`loadElapsedSeconds`、`lastLoadSeconds`、`loadTimings`。秒数はバックエンドの単調増加時計で測る。`loadCount`はそのバックエンドで実際に開始したロードの通算回数で、パス変更時にも通算する。
- `loadTimings`は`dependenciesSeconds`・`builderSeconds`・`processorSeconds`。builder内の重みI/O・CPU構築・GPU転送は分離していない。CPU待機は未実装。

設計と検証は[SOW](SOW_20261018_sam3_reload_lifecycle.md#9-追加依頼による実装結果2026-10-18)、[ADR-0032](adr/0032-sam3-model-lifecycle-and-status.md)を参照。
