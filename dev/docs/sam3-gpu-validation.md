# SAM3実装・GPU検証記録

記録日：2026-10-11。実装ブランチ：`feat/sam3_detect`。基準main：`cf3437e8a1a494132806ca26258336712439f42e`。

この文書は実行済みの結果と未確認事項を区別する。モック、実GPU、Windowsで確認した範囲を個別に記録する。

版12の初期実装を検証した後、ユーザーの追加指示で共通の重なり順と版13へ更新した。今回の関連検証は末尾「共通順序・短縮カードの追加検証」に分けて記録する。推論backendは変更していない。

## 契約と実行環境

- SAM3 upstream：`0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc`。
- upstream環境条件：Python 3.12以上、PyTorch 2.7以上、CUDA runtime 12.6以上。ローカル`nvcc`12.0と、PyTorch wheelに含むCUDA runtimeは別に扱う。
- GPU依存：Python 3.12.13、PyTorch 2.10.0+cu128、torchvision 0.25.0+cu128。SAM3が未宣言で使う`pkg_resources`のためsetuptools80.10.2をGPU extraへ収録する。最終lockのruntime import診断も合格。
- 重み：`~/dev/models/vision/sam3.pt`、存在・サイズ3,450,062,241 bytesを確認。重みはGitへ含めず、自動取得しない。
- GPU：NVIDIA GeForce RTX 4070 Ti SUPER。サンドボックス内のNVMLアクセスはOSに遮断されるため、実機検証は明示的に権限を上げて実施する。
- ライセンス：upstream LICENSEはMeta独自のSAM License。pyprojectのMIT classifierを利用条件の根拠にしない。
- テキストAPI：`build_sam3_image_model(checkpoint_path=...,load_from_HF=False,enable_inst_interactivity=True)`と`Sam3Processor.set_image/set_text_prompt`。
- ポイントAPI：固定upstreamではinteractive predictorのbackboneがNoneのため、直接`set_image`は失敗する。`processor.set_image`のinference stateを公式`model.predict_inst(inference_state, point_coords=...,point_labels=...)`へ渡し、テキスト・ポイント・候補修正を実機で確認済み。
- モック境界：`SAM3_MOCK=1`でのみ明示的に有効。CIはGPU依存なし。モック合格を実モデルの検証とみなさない。

公式参照：[model builder](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model_builder.py)、[image processor](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model/sam3_image_processor.py)、[interactive predictor](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model/sam1_task_predictor.py)、[LICENSE](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/LICENSE)。

## 実行済みの検証

| 対象 | 結果 | 根拠 |
|---|---|---|
| Nodeプロキシ | PASS | `node --test test/sam3-proxy.test.mjs`。Host・Origin・Fetch Metadata・固定ルート・メソッド・実サイズ・HTTP410・未接続503 |
| IndexedDB | PASS | `node scripts/mask-storage-smoke.mjs`。版1→2、圧縮Blob復元、破損／不足／外部参照／abort時の前回保存保持、素材解放 |
| JSマスク基盤・描画 | PASS | codec・幾何・4効果・保存・履歴。透明境界とblur0の後勝ち。main／Worker／原寸表示が4回転で一致 |
| Node全テスト | PASS | 最終`npm test`、163件合格 |
| Python GPU不要テスト | PASS | 29件。API入力／Host／Origin、cache、codec、timeout、latest-wins、OOM、load/infer/unload競合 |
| 起動監視 | PASS | `node --test test/dev-launcher.test.mjs`、正常・異常終了とSIGTERM無視の孫プロセス停止 |
| SAM3モックE2E | PASS | text／points／refine、latest-seq、取消／再検出、page switch／remount、4加工・crop・保存・PNG・API停止 |
| 既存ブラウザE2E | PASS | 21本。スイート前半16本の後、旧形式fixtureの混入を修正してcaptionを再実行、未実行の後半5本も合格 |
| 一括保存・静的ビルド | PASS | 全21書体のWorker RGBA一致、100画像、中断／再開、破損読込、Pagesサブパス配信。Pythonは静的出力へ含めない |
| GPU実モデル・600秒解放 | PASS | 実pytest1件：231.90秒。最終依存でtext／points／text候補refine、610.5秒後の解放・画像再転送・再ロード成功 |
| 実GPUブラウザ操作 | PASS | 実モデルのtext検出、前景・背景2点、候補確定、PNG保存。対象内の黒塗りと対象外の元画素を検証 |
| 4K／6K・100マスク | PASS | `node scripts/mask-stress-smoke.mjs`。100素材、描画、100回Undo/Redo、バイナリ保存・読込 |
| Windows→WSL localhost | PASS（範囲限定） | Windows Edge headlessで実エディターの初期化・プリセット生成、Windows PowerShellでIPv4 health応答を確認。Windows GUIでの全操作は未確認 |

## 再現コマンド

```bash
npm run check
npm test
npm run build
npm run test:browser
npm run test:bulk
npm run test:mask-render
npm run test:mask-order
npm run test:mask-storage
npm run test:mask-stress
npm run test:sam3-browser
cd backend
uv sync --locked
uv run --locked pytest -m 'not gpu' -q
# 実GPU環境
uv sync --locked --extra gpu
uv run --locked --extra gpu python scripts/check_setup.py
SAM3_RUN_GPU_TESTS=1 uv run --locked --extra gpu pytest -m gpu -v
cd ..
# 起動済み実GPUサーバーに対し、ルートから実行（PORT指定時は引数を追加）
npm run test:sam3-gpu-lifecycle -- --port 5254
npm run test:sam3-real-browser -- http://127.0.0.1:5254
```

## 未確認事項

実写・漫画素材の検出精度、全面マスク100枚や最大強度の大領域ぼかし、他プロセスによる実VRAM圧迫、Windows GUIでの全編集操作は未確認。OOMはEngine→JobManagerの注入試験で、1回再試行と2回目失敗を検証した。GPU pressureを発生させた測定とは区別する。

コミット・PRとGitHub Actionsの実行はユーザーのコミット承認後。mainへのpush／mergeは行っていない。

## 事前GPUスモーク（Gate 0）

実checkpointを使用。PyTorch 2.10.0+cu128、CUDA runtime 12.8、RTX 4070 Ti SUPER。`load_from_HF=False`で公式builderを実行し、テキストではmasks/scoresを取得、公式`predict_inst`では3×256×256マスクを取得し、非空画素26,339を確認した。候補修正・実写での検出精度・アイドル解放・OOMの総合検証とは区別する。

| 指標 | 観測値 |
|---|---|
| 初回モデルロード | 約200秒 |
| CUDA peak allocated | 5,591,841,792 bytes |
| CUDA peak reserved | 6,129,975,296 bytes |
| テキスト出力 | 200×1×256×256 masks、200 scores |
| ポイント出力 | 3×256×256 masks、非空画素26,339 |

## 100マスクのブラウザ負荷検証

画像は均一色、各マスクは64×64px、4種類の加工と輪郭補正を混在したfixture。以下は初期実装で透明境界を修正した後の測定値。大領域100枚の場合の性能を保証する測定ではない。`artifacts/sam3-mask-stress.json`は再実行時に更新され、今回の最新値は末尾に記録する。

| 画像 | 描画 | Undo/Redo100回 | 保存＋復元 | 展開マスク総量 | 圧縮素材総量 | 観測JS heap | 観測browser RSS合計ピーク |
|---|---:|---:|---:|---:|---:|---:|---:|
| 3840×2160 | 145ms | 1596ms | 88ms | 409,600B | 800B | 78,950,430B | 556,138,496B |
| 6000×4000 | 158ms | 1506ms | 76ms | 409,600B | 800B | 210,796,171B | 785,649,664B |

素材バイト列が履歴へ含まれないこと、Undo後の完全復元、100件の保存／読込と既知の黒塗り画素、元画像・マスク外の保持を検証した。履歴は約2.34MB。browser RSSはCDPが示す自分のChromiumプロセスの`VmRSS`合計を50ms間隔で測定した値で、共有ページを二重計上する。同じブラウザで4K→6Kを順に実行し、開始時RSSは363,966,464B／556,138,496B。正確な瞬間ピーク・PSS・GPUメモリを表す測定ではない。

## 既存ブラウザテストの基準比較

最新main `cf3437e8a1a494132806ca26258336712439f42e`を`git archive`で一時ディレクトリへ展開し、同じPlaywright・フォントで比較した。次の失敗はSAM3追加前でも同一に再現した。実装ブランチの動作を戻さず、現行仕様を検証する期待値に修正する。

- `browser-smoke.mjs:86`：整数表示された太さ3に対して旧期待2.5。
- `full-preview-smoke.mjs:79`：旧文字順の移行後、配列先頭の吹き出しX=730.123456789を台詞X=250.123456789と比較していた。種類で対象を特定する。
- `image-edit-smoke.mjs:62`：版9fixtureの旧描画順移行により吹き出し→台詞→キャプションとなるが、移行前配列を期待していた。

ORIGINALにCanvas overlayを追加したことによる参照の混線はSAM3統合で修正した。アプリと関連テストのLIVE PREVIEW取得は`canvas.preview`へ限定する。

新版の保存結果から旧版fixtureを作るbrowser／caption試験では、新版だけのmaskフィールドを除去する。旧版へのmask混入は読み込み時に拒否する仕様を維持した。bulkの静的サブパスfixtureには、新規5モジュールに加え既存image-edit／preview-modalも配信する。成功済みの前半を繰り返さず、修正対象と未実行の後半を個別実行して21本の合格を確認した。

## 最終lockでの実サーバーGPU計測

`PORT=5254 npm run dev`でNode／FastAPIを起動。元画像は外部素材を使わず生成した256×256pxの顔fixture。`scripts/sam3-gpu-lifecycle.py --port 5254`から同一オリジンプロキシ経由で操作した。記録元は`artifacts/sam3-gpu-lifecycle.json`。

| 操作 | 観測時間 | 候補数 | 第1候補の顔領域IoU |
|---|---:|---:|---:|
| 起動後ready待ち | 32.934秒 | — | — |
| テキスト`face` | 1.516秒 | 1 | 0.9940 |
| 前景1点 | 2.033秒 | 2 | 0.9949 |
| テキスト候補を前景・背景点で修正 | 0.509秒 | 1 | 0.9936 |
| 解放後の再ロード＋ポイント推論 | 17.478秒 | 2 | 0.9949 |

ジョブ時間にはHTTPと500msのpoll間隔を含む。モデル内部のkernel時間ではない。初回ロードはdisk cacheなどに影響されるため、Gate 0のcold観測約200秒と区別する。IoUは生成時の楕円領域に対する値で、実写・漫画素材への精度保証ではない。

最後の推論後610.513秒でhealthが`unloaded / modelLoaded=false`となった。アイドル設定は600秒、maintenanceは10秒、計測は5秒poll。`nvidia-smi memory.used`は16,021→11,783MiB、**4,238MiB減少**。この値はGPU全体で、同時に動く他のアプリの占有も含む。残り11,783MiBをSAM3の残留VRAMとみなさない。モデル・予測器の参照解放とallocator掃除後、画像期限切れ410を受けて1回再転送し、同じ入力の再推論に成功した。

### 実GPUブラウザでの確定・PNG保存

同じ実サーバーにLinux Chromiumから接続し、`scripts/sam3-real-browser-smoke.mjs`を実行した。APIの`gpuAvailable=true`とモック不使用を確認し、生成した顔PNGを画面から追加、`face`で1候補を検出、前景・背景を2点指定、黒塗りとして確定し、PNGをダウンロードした。中心画素は`[0,0,0,255]`、対象外は元画像と同じ`[65,135,185,255]`、PNGは5,715 bytes。ブラウザの未処理エラーなし。画面記録は`artifacts/sam3-real-gpu-browser.png`。

## Windows確認の範囲

Windows版Edgeの標準headless実行で`http://localhost:5254/`を開き、動的に生成されたプリセットを含むエディターDOMを確認した。PowerShellの`Invoke-RestMethod http://127.0.0.1:5254/api/sam3/health -Proxy $null`も`ready / modelLoaded=true / gpuAvailable=true`を返した。PowerShellのlocalhost名指定はタイムアウトしたため、CLIの再現はIPv4アドレスを使う。

Windowsの署名付きスクリプト実行ポリシーは保持した。一時EdgeプロファイルをWSLの`/tmp`へ置いたため、Edgeは一部のcache/database初期化警告を出したがアプリを読み込めた。Windows GUIでの画像追加・クリック・保存の全操作は未確認。Linux Chromiumのモック／実GPUブラウザ試験とは範囲を分ける。

## 統合レビューで修正した境界

- 再ロード中の`loading`をpollし続ける。モデル不在のhealth詳細と明示的な再検出、dispose後の遅延health応答を処理する。
- キャンセル／確定／ページ切替後も再検出できる。再マウントのsession UUIDでrequestSeq衝突を防ぎ、古い要求は通信・デコード双方で破棄する。
- ぼかし0pxの後勝ち、透明PNGのalpha付き平均、load／infer／unloadのGPU共有lockを検証する。
- Worker無効時のマスク付きサムネイルも原画像から加工する。縮小素材を再拡大する旧処理は最大69階調の差で失敗し、修正後は原PNGからの独立した参照と画素一致した。

## 共通順序・短縮カードの追加検証

`feat/sam3_detect`で、マスクと文字を共通の前後関係で扱い、非選択カードを短縮表示へ変更した。出力は版13、旧版12も読込可能。設計は[ADR-0024](adr/0024-shared-mask-and-text-order.md)。

| 対象 | 結果 | 確認範囲 |
|---|---|---|
| 全Nodeテスト | PASS | 167件。共通順位、履歴、複製時の順位、版12互換と版13の保存／復元 |
| マスク混在順序E2E | PASS | 短縮表示、Enter選択、文字／マスク相互の4方向移動、端での無変更、Undo/Redo、マスクの穴、元画素・透明画素、Canvas選択、Worker PNG、原寸表示、4回転・crop、JSON／コンテナ／一時保存、モバイル |
| 既存文字順E2E | PASS | 移行、相互移動、複数選択、端、履歴、Canvas選択、PNGと各保存形式 |
| SAM3モックE2E | PASS | 短縮カードを展開して4加工を編集、推論の取消・再実行、移動・リサイズ、サムネイル・保存・PNG |
| 既存マスク描画 | PASS | 従来の4回転、元座標、4加工、穴、margin、重複、ドラフト除外。main／Worker／原寸表示の画素一致 |
| 文字コピーE2E | PASS | 全4種類の画像間コピー、表示範囲切替、カット・Undo/Redo、各保存形式、話者プリセット |
| 4K／6K・100マスク | PASS | compositor変更後に再計測。4K描画165ms／観測browser RSSピーク557,076,480B、6K描画161ms／785,899,520B。fixtureとRSS計測の制約は初期測定と同じ |

初期実装で合格したブラウザ21本全部と実GPU待機試験は、今回の変更後には再実行していない。UI・描画・保存へ影響する上記の関連試験を実行した。全Nodeテストは今回の最終モデル・描画実装に対する結果で、推論backendには変更がない。
