# Serifu Editor

複数画像にセリフ・効果音・吹き出し・キャプションを配置するWebアプリ。

- [公開版を開く](https://falls247.github.io/serifu-editor/)
- [操作説明書（HTML）](docs/index.html)：`docs/index.html`をブラウザで直接開くか、起動後に http://localhost:5173/docs/ を開く。
- [開発ドキュメント](dev/docs/README.md)

## ローカル起動

Node.js 22以降が必要。通常の編集に`npm install`は不要。

```bash
git clone https://github.com/falls247/serifu-editor.git
cd serifu-editor
npm start
```

http://localhost:5173 を開く。WSLから起動した場合もWindowsのブラウザから利用できる。アプリはHTMLファイルを直接開かず、サーバー経由で使う。

同梱書体を用意する場合は、初回に以下を実行する（外部書体の取得にネット接続が必要）。未実行でも端末の代替書体で起動できる。

```bash
npm run fonts
```

ポートを変える場合は`PORT=5254 npm start`。終了は`Ctrl+C`。

## SAM3の画像マスク検出を使う場合

通常の編集に加えて、uv・Python 3.12・CUDA対応GPUとモデル重みが必要。`sam3.pt`を`~/dev/models/vision/sam3.pt`へ配置する。モデルは自動取得しない。利用条件と環境の詳細は[GPUセットアップ・検証記録](dev/docs/sam3-gpu-validation.md)を参照。

```bash
uv python install 3.12
cd backend
uv sync --locked --extra gpu
uv run --locked --extra gpu python scripts/check_setup.py
cd ..
npm run dev
```

http://localhost:5173 を開く。UI（5173）と推論API（8765）を同時に起動し、`Ctrl+C`で両方を終了する。モデルの場所は`SAM3_MODEL_PATH`、UIポートは`PORT`、APIポートは`SAM3_API_PORT`で変更できる。

モデルはアプリ無操作で既定15分後に解放する。解放時間はSAM3カードで1〜240分を保存できる。起動時は保存済みの有効な値、`SAM3_MODEL_IDLE_SECONDS`（秒）、既定900秒の順に適用する。既存の秒単位設定は維持し、UIで次に保存したときから分単位になる。モデルパスと解放時間は`backend/.local/sam3-settings.json`（`SAM3_SETTINGS_FILE`で変更可）に保存する。

公開版では新規検出を使えない。保存済みマスクの編集・PNG保存は利用できる。
