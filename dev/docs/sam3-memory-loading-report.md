# SAM3省メモリロード・無操作解放・全解除の実装報告

- 日付：2026-10-25
- 対象：[SOW](../sow/SOW_20261025_sam3_memory_loading.md)、[ADR-0033](adr/0033-sam3-memory-efficient-loading.md)
- 作業ブランチ：`fix/sam3-error-diagnostics`を継続。コミット・pushは未実施。

## 実装範囲

`backend/app/model_loader.py`がパス文字列で`torch.load(..., mmap=True, weights_only=True, map_location="cpu")`を行い、公開builderでCPU構造を作り、`load_state_dict(strict=True, assign=True)`で割り当ててGPUへ転送する。CPU初期化は残るが、コピー先と重みを同時に保持する期間を省く。checkpoint辞書をGPU転送前に解放し、モデルが持つマップへの参照も転送とともに解放する。旧形式は構造の構築前にmmapなしへ分岐し、OOMなどでの無条件再試行はしない。

dtypeはbuilderの値を維持し、共有parameter／bufferの同一性を割当て・GPU転送後に復元する。非永続bufferとupstreamの位置情報キャッシュはCPU構築経路に任せる。欠損・余剰・形状不一致と未実体化metaをロードエラーにする。段階時間、RSS（Resident Set Size：物理メモリ常駐量）、最大RSS、Linuxメモリ・swap・GPU割当てをログへ出す。例外のトレースに残る一時参照も解放する。

meta構築は未採用。固定ViTが`torch.linspace(...).item()`を使うため、空構造の試作は`Tensor.item() cannot be called on meta tensors`で失敗した。明示的CUDA生成とbufferの再構築まで安全に置き換えるにはupstream内部への依存が増える。SOWの段階採用条件に従い、公開builderのCPU構築を保ち、assignだけ先に採用した。`.venv`とPyTorch全体の差替え、量子化、精度変更、WSL設定変更、キャッシュ強制破棄は行っていない。CPUスレッド制限の追加も未採用。

モデル解放時にはautocast（自動精度変換）のキャッシュも消す。固定trackerが継続的なコンテキストを開いており、参照解除後も約1.2GiBの変換済み重みが残ることを確認した。`clear_autocast_cache()`でこの割当てが消えるため、GPU処理の直列化を保って解放処理へ追加した。追加診断では、推論前の解放でGPU割当て0、推論後で9.125MiB、モデル・プロセッサの弱参照は消滅し、GCから追跡できるPythonのCUDAテンソルは0。残る固定割当てはCUDAライブラリの作業領域と推定し、完全なドライバ／CUDAコンテキスト終了とは区別する。

## 無操作解放と設定

- 既定900秒。最後のアプリ操作、モデル準備完了、推論終了の最新時刻から単調時計で計時する。ロード・推論・待機中は解放せず、GPU lock内で時刻・モデル世代・設定更新中かを再確認する。
- アプリ共有クライアントがtrustedなpointer／key／input／click／wheel／touchを監視する。自動scrollイベントは数えず、wheel・タッチ・キー・スクロールバー操作を通して利用者のスクロールを数える。ページごとの保持タイマーは増やさない。
- `POST /api/sam3/activity`を追加。Host／Origin、1024バイト上限、余分なフィールド、型・値域を検証。入力内容や座標を送らず、セッション・連番・操作経過秒・モデル設定世代・healthで得た短命な時刻窓だけを送る。連続操作は最大約5秒間隔で集約する。
- 旧連番・別世代・10秒超の操作経過・最大30秒の有効窓を過ぎた通知は保持に使わない。非表示時は未送信の直近操作だけを試み、失敗通知を再送しない。API未接続中は通知せずバックオフする。復帰やhealth取得だけでは操作を更新しない。
- 解放時間は1〜240分・整数・明示保存。適用中の秒数、未保存、保存失敗、状態と解放目安を表示する。旧環境変数の125秒なども丸めず表示し、次の保存から分単位とする。
- 設定ファイルは原子的置換。モデルパスと時間を部分更新し、他方を消さない。保存失敗時は実行時設定・リビジョンも変更しない。無操作時間だけではモデル世代・ロード回数は変わらない。サーバー起動世代とリビジョンで、古いhealth・逆順の保存応答を無視する。

## 全解除の原因と修正

原因は、`selected=false`になっても`drawOverlay()`が未選択候補の輪郭・番号を描き、hoverでは内部も塗る状態だったこと。ライブプレビューは`drawPage()`から現在のdraftを同期描画するため、この経路に遅延描画キューや古い合成キャッシュはなかった。キャッシュ全破棄は追加していない。

draftに候補の全解除済み状態と解除リビジョンを加えた。全解除はhoverも消し、候補描画とヒット判定を止め、選択数・確定ボタン・ライブプレビューを更新する。候補一覧、プロンプト、ポイント、重ねて表示の設定、確定済み加工は保持する。一覧の再選択・全選択で表示を戻す。新しい検出は初期表示へ戻すが、解除前に始まった要求の遅延応答は全解除後の非選択・非表示を維持する。保存形式と未確定候補の出力対象は変更していない。

## 単一モデルの実GPU比較

利用者が既存サーバーを手動停止したあと、別々のプロセスを交互に実行した。モデルを並列にロードしていない。SAM3は`0570b3a`、PyTorch 2.10.0、同じ約3.45GBのcheckpoint、CPUスレッド8、同一の256×256顔画像と入力。CPUスレッド数を変えた比較ではない。

`scripts/sam3-memory-benchmark.py`は、APIが稼働していれば開始を拒否し、Linuxの空きメモリが512MiBを下回れば中止する。今回の最小空きメモリは従来約3.71GiB、省メモリ約6.25GiBで、中止条件には達していない。

| 方式・回 | 読込み秒 | ロード時最大RSS MiB | ロード中のWSL全体swap書込み MiB | プロセス最大swap MiB |
|---|---:|---:|---:|---:|
| 従来・初回 | 18.587 | 6881.2 | 1477.9 | 1125.5 |
| mmap＋assign・初回 | 12.464 | 5500.9 | 0 | 0 |
| 従来・反復2 | 16.852 | 7056.3 | 1207.4 | 756.3 |
| mmap＋assign・反復2 | 10.811 | 5499.1 | 0 | 0 |
| 従来・反復3 | 16.270 | 7031.0 | 1000.2 | 820.7 |
| mmap＋assign・反復3 | 11.144 | 5499.3 | 0 | 0 |

中央値では読込み16.852→11.144秒、最大RSS 7031.0→5499.3MiB（約1.50GiB、21.8%減）。GPU割当ては準備完了時3573.3MiBで同じ。6回すべてで全state_dictのキー・dtype・値のSHA-256が一致し、テキスト、前景＋背景ポイント、候補修正の件数・bbox・マスクSHA-256・スコアも完全一致した。許容誤差を加えていない。

省メモリ方式の初回段階時間はcheckpoint 0.148秒、CPU構築7.612秒、割当て0.176秒、GPU転送2.334秒。CPU構築が残るため、meta相当の削減とは扱わない。実装の基礎は[PyTorch公式の読込み手順](https://docs.pytorch.org/tutorials/recipes/recipes/module_load_state_dict_tips.html)を参照。

比較時のOSキャッシュは強制破棄していない。初回のキャッシュ冷温は未確認で、反復もOSの回収に影響される。swap書込みは`/proc/vmstat`の差分×4KiBで、SAM3単独の書込み量ではなくWSL全体の値。`/proc/self/io`が実行環境で存在せず、プロセス別のディスク入出力は未取得。WindowsのVmmemWSL・空きメモリも未取得。時間短縮を一般化せず、この環境・この実行順の計測結果として扱う。

生データは無視対象の`artifacts/sam3-memory-{baseline,mapped}-{1,2,3}.json`、GPU回帰ログは`artifacts/sam3-memory-gpu-lifecycle.log`。再現コマンドは次のとおり。既存サーバーを停止した状態で、各コマンドの終了を待って次を実行する。

```bash
backend/.venv/bin/python scripts/sam3-memory-benchmark.py --strategy baseline --output artifacts/baseline.json
backend/.venv/bin/python scripts/sam3-memory-benchmark.py --strategy mapped --output artifacts/mapped.json
SAM3_RUN_GPU_TESTS=1 PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests/test_gpu_smoke.py -m gpu -q -s
```

## 検証と操作説明書

- 非GPUのローダーテスト：小型モデルでmmap、旧形式、metaへの割当て、共有parameter／buffer、非永続buffer、dtype保持、欠損・余剰・形状不一致、OOM、例外時の参照消滅を検証。SAM3本体のmeta対応テストとは区別する。
- バックエンド：アプリ無操作900秒の境界は単調時計を制御して確認。複数タブ、旧通知、GPU lock待ち中の新操作、保存の部分更新・優先順位・原子的失敗、APIのHost／Origin・サイズ・型を検証。
- 実GPU：起動、活動通知による保持、期限後解放、モデル弱参照の消滅、ロード中取消、次画像の再利用、完全解放後の再ロード、テキスト／前景・背景／候補修正を検証。しきい値は1秒へ短縮したテストで、900秒の実待機ではない。
- ブラウザ：既存`test:sam3-browser`・`test:sam3-lifecycle`・`test:sam3-focus`と追加`test:sam3-idle-clear`。4加工の全解除前後の画素、遅延結果、再選択、ポイント・確定済み加工の保持、PC・モバイル幅、タッチ・キー、FOCUS・リサイズ・原寸表示、別タブの設定反映と失敗表示を確認。
- `npm run check`、`npm run build`、単体テストを実施。操作説明書「SAM3で領域を指定する」を更新し、通常・FOCUS・原寸表示の対象、無操作15分、保存、通知障害、長時間GPU占有、全解除と確定済み加工の違いを追記。起動用READMEに環境変数・設定優先順位・保存先を記載。
- 最終集計：バックエンド非GPU 62件、実GPU 2件、JavaScript全体244件が成功。その後、サーバー再起動前の遅延応答を拒否するクライアント回帰1件を追加し、関連テストで確認。
- 操作説明書のPC／モバイル幅、ダーク／ライトと記憶、印刷、JavaScript無効、ローカルの`/docs/`・`/docs/index.html`・CSS配信を確認。静的buildにHTML・CSSを出力。追加設定UIもPC・モバイル幅のスクリーンショットで確認。

未確認：真の冷キャッシュ比較、Windows側メモリ、プロセス別ディスクI/O、900秒の実待機、実機のiOS／Android。通信断中の操作をバックエンドが観測する保証はない。解放直後のWindowsへのメモリ返却量も保証しない。
