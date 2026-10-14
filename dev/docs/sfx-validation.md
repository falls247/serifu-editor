# SFX文字単位編集・保存の検証記録

対象ブランチ: `docs/sow-20261013-sfx-glyph-editor`。着手HEAD: `63f37f6e51b7beeb16908477329684b489f07979`。SOW §1〜14の113決定は変更していない。

コードHEAD: [`76e160d0`](https://github.com/falls247/serifu-editor/commit/76e160d0e6f5f42222c71280d0d746aacd152e94)。文書追加後の最新HEADのCI判定は[本ブランチのChecks](https://github.com/falls247/serifu-editor/actions/workflows/ci.yml?query=branch%3Adocs%2Fsow-20261013-sfx-glyph-editor)を参照する。本記録の自動試験合格と、実機の正式受入は別。

## 実行環境

ローカルはLinux、Node 24.19.0、Playwright 1.56.1、Chromium 141.0.7390.37、WebKit 26、Firefox 142.0.1。日本語の端末書体はNoto CJK、同梱19書体を確定ロードする。CIはNode 22、同じPlaywright版・3 engine・Noto CJKを準備する。製品にテスト依存を追加していない。

WebKitはLinux用のブラウザ。390×844／1024×1366、DPR 2、mobile／touch設定で操作した。ローカルでは抽出した共有ライブラリを使うためホスト依存の事前検査だけ省略し、WebKit本体とアプリの試験は実行した。実iOS Safariとは異なる。

PC向け追加試験はLinuxのheadless、1440×1080、DPR 1。ローカルでは共有ライブラリを抽出して使い、Firefoxは実行環境のuser namespace制約に合わせてブラウザsandboxを検証プロセス内だけで調整した。検査省略とsandbox overrideは結果JSONへ記録する。CIは通常の依存導入・ブラウザ起動設定で実行し、環境差を同じ条件の合格へ読み替えない。

## 自動試験

| 対象 | 結果・確認内容 |
|---|---|
| 構文・静的ビルド | 構文92ファイル、`npm run build`、`git diff --check`が合格。新moduleをserver／build／bulkの配信許可リストへ追加 |
| Node単体 | 193件合格。原文grapheme、継承、run、点、幅、輪郭、seed、ID、互換、Worker中断を含む |
| backend | 38件合格、既存適用条件のGPU試験1件は対象外 |
| 既存回帰 | `test:browser`の元22本がすべて合格。最終CIはChecksで確認 |
| 一括描画 | `test:bulk`合格。全21書体のWorkerとmainのRGBA差0、読込中編集、中断／次操作、形式往復、cache、書込失敗、Worker代替 |
| マスク・SAM3 | `test:mask-render`／`test:mask-order`／`test:mask-storage`／`test:sam3-browser`が合格。旧回帰の元スクリプトを使用 |
| SFX基礎・選択 | `test:sfx-lettering-browser`／`test:sfx-selection`。Shift・Alt・矩形・なげなわ、複数複製／Undoと選択、別SFXへのClipboard外観、原文ドラフト取消／確定 |
| 長音線 | `test:sfx-stroke`。S字、Canvas制御点D&D、曲線／線幅点挿入、本文run分割結合、Undo、最終drawとPNG一致 |
| 合成外周 | `test:sfx-outline`。実インク3文字の重なり、手動ロック、grunge前シルエット不変、複数複製、PNG一致 |
| テンプレート・書体 | `test:sfx-template`と単体。異字数、長音なし、deep validation、欠損書体の明示代替／アップロード、元書体名、PNG |
| 旧描画・index | `test:sfx-render`。着手HEADのrenderer fixtureと旧SFX24条件のRGBA差0。改行・絵文字・縦横・光学字詰めの原文index4条件 |
| 出力・再読込 | `test:sfx-export`。画像外警告とクリップ、文字単位の異なる書体のWorker描画、元寸法1000×750、縦横往復、JSON再読込後のPNGバイト一致 |
| ファイルID | `test:project-open`。三択、追加／別projectのID、同ID画像差替と旧履歴、無効ファイルの原子的UI維持 |
| 保存 | `test:project-history`。v2中断／同ID冪等再試行、旧ストア保持、20回短期確定、5分判定、6→5世代、同内容で履歴追加なし、画像／マスク旧世代、quota／abort rollback、参照検証GC、対象latestだけの消去、共有素材を重複計上しない容量／解放可能量 |
| タブ終了中の保存 | 同history試験でsnapshot書込後のnative IDB transactionを維持し、CDP `Target.closeTarget`でタブを終了。再オープン後も直前のlatest、全history、読める素材bundleを確認 |
| 自動保存の追従・所有権 | `test:autosave-catchup`。画像hashを保留中にClipboard操作と追加編集を行い、1秒／121秒のclock advance後に最新へ追従。期限切れ後も旧tokenは拒否。別writerの確定が保存準備中または次の心拍前に入れば古い保存を拒否し、latestを再読込 |
| 3タブ | `test:project-tabs`。他2タブ閲覧、最後の明示操作優先、終了／期限切れ後の引継ぎ、latest再読込、旧token保存／削除拒否 |
| PCブラウザ3系統 | `test:sfx-desktop`。Chromium／WebKit／Firefoxで数値編集・Esc取消・Ctrl+D／Undo、native曲線D&D・幅・個別書体の実ロード、共通drawとPNGのRGBA一致、JSON／.serifu往復、IndexedDB再読込とPNG一致、3タブ閲覧／明示入力優先／旧tokenの保存・削除拒否を確認 |
| モバイル寸法 | `test:sfx-touch`。Chromium／WebKit各2寸法でタップ・数値・保存復元・横はみ出しなし。Chromiumはnative touchによる長押しルーペ／2指pinchも確認。WebKitの多点ジェスチャは実機未確認 |

`test/dev-launcher.test.mjs`はfixtureが `/proc/self/stat` のPIDを報告するよう変更した。検証環境の仮想PIDと `/proc` のPIDが異なり、無関係の生存プロセスを終了失敗と判定したため。終了assert・timeoutは保持した。既存ブラウザsmokeのassert・期待値・30秒のtimeoutは維持し、非同期の保存待機だけを結果までawaitする共通helperへ変更した。

## UATとの対応

以下は自動試験がカバーした挙動の対応表。全端末での手動正式受入を意味しない。

| UAT | 自動検証・証跡 | 残る確認 |
|---|---|---|
| 01 | stroke smokeのS字／幅／PNG、geometry単体の端点追従 | 実機での操作感 |
| 02 | lettering smokeとmodel単体の本文差替・継承3種 | 実機IME |
| 03 | selection／outline smokeの複数複製／Undo、model単体の削除 | 実機ショートカット |
| 04 | outline smokeとoutline-groups単体 | 端末表示の視覚確認 |
| 05 | export smokeのUI往復とedit-operations単体 | 実機書体 |
| 06 | template smokeとtemplates単体の異字数／長音なし／seed | 実機UI |
| 07 | selection smokeのAlt、Chromium touchの長押し／pinch | Safari実機の多点操作 |
| 08 | export smokeの画像外警告／クリップ／原寸／再読込 | 実機視覚確認 |
| 09 | legacy compatibility単体、legacy rendererの24条件差0、既存PNG／ファイル往復 | 利用者の実ファイル群 |
| 10 | history／open smokeの同ID画像差替、旧画像／マスクと世代復元 | 実Safariの長時間保存 |
| 11 | history smokeの20回確定／5分／5世代、autosave smokeの保存中追加編集 | 実機の長時間放置・再開 |
| 12 | tabs smokeの3タブ終了／expiry／fencing、保存hash中のwriter交代と再読込 | 実Safariのタブ休止 |
| 13 | open smokeの同ID三択・独立ID・履歴保護 | 実機ファイルピッカー |
| 14 | native IDB中のタブ終了／quota／abort、migration再試行 | 実Safariの強制終了 |
| 15 | history smokeの1世代削除／共有参照GCと容量報告 | 実機UI・容量表示 |
| 16 | Chromium／Linux WebKitの2モバイル寸法と保存復元、PC3 engineの編集／書体／PNG／保存／3タブ | **iPhone／iPad Safari、PC主要ブラウザの実機は未確認** |

## 性能

`test:sfx-render`の30 samples、12文字、1000×750、共有外周、1文字のdxを毎回変更して共通drawを再実行する測定。ウォームキャッシュ、Headless Chromium 141／Linux、hardwareConcurrency 9。最後の測定値は平均19.50ms、P95 33.80ms。ブラウザ操作全体の入力遅延や実機性能を表す値ではない。CIでは `artifacts/sfx-validation.json` を保存する。

中間字形2MP・共有外周5MP、軸8192pxの制限と既存cache上限を維持する。PNG寸法は縮小しない。実際の500枚の大画像・多量エフェクトの性能、iOSのメモリ圧迫は未実測。

## 引継ぎ

製品実装の残りと旧CI回帰を解消する変更を本ブランチへ反映した。最終Checksのcode SHA／runは冒頭を参照し、実機UAT-16を別途記録する。実機未確認をSOW完了へ読み替えない。`main`へのmerge・Pages公開は実施しない。

## コミット対応

| 変更 | コミット |
|---|---|
| 原子的保存・移行・GC・容量・lease／fencing・SAM3・Worker中断 | [`6dfe1094`](https://github.com/falls247/serifu-editor/commit/6dfe10942e788c5941a51330451d6cc6b6720aec) |
| glyph／stroke／輪郭／テンプレートのモデル・描画 | [`06f0ce51`](https://github.com/falls247/serifu-editor/commit/06f0ce51d49e0fcb51d0544a2b4b9c80b0afbe61) |
| 編集UI・Clipboard・Touch・プロジェクト切替／復元 | [`1510c3f2`](https://github.com/falls247/serifu-editor/commit/1510c3f2806f7f42c5f2bcc09a2845d1d3d554b0) |
| 専用E2E・旧描画fixture・全版互換・CI | [`36801248`](https://github.com/falls247/serifu-editor/commit/36801248e39266e40cd8b26db67203714f49d9e4) |
| 保存中追加編集・準備後lease更新・所有権継続の検証・非同期待機上限 | [`f68164b5`](https://github.com/falls247/serifu-editor/commit/f68164b53777e9c7db61db47010b2ebfad77e7aa) |
| 次の心拍前にwriterが交代した場合の保存拒否・再読込 | [`459b7092`](https://github.com/falls247/serifu-editor/commit/459b7092ded1af55341098f25be9bdffd5ad5da4) |
| 保存中のClipboard待機を解消・500ページ回帰の修正 | [`76e160d0`](https://github.com/falls247/serifu-editor/commit/76e160d0e6f5f42222c71280d0d746aacd152e94) |

## CIで追加確認した待機条件

初回のChecks [38392728754](https://github.com/falls247/serifu-editor/actions/runs/38392728754)と文書追加後の[38393149746](https://github.com/falls247/serifu-editor/actions/runs/38393149746)は、新設project-open試験で保存完了前に画像参照を比較して失敗した。Promiseを返すwaitForFunctionの述語を同期の完了表示へ変更し、指定projectの保存メタデータを直接assertする。画像差替／旧履歴のassertとtimeoutは維持し、ローカル5回連続合格を確認した。補正は[`4715e61c`](https://github.com/falls247/serifu-editor/commit/4715e61c29155df469ade248d264dc53d4e48bb3)。過去の赤いrunを合格の証跡に使わない。

追加CI [38395302382](https://github.com/falls247/serifu-editor/actions/runs/38395302382)では既存balloon試験にも同じ非同期waitForFunctionの問題が再現した。`scripts/browser-wait.mjs`で述語のPromise結果を毎回awaitし、30秒以内でpollするよう統一した。吹き出しは修正後ローカル3回連続合格。補正は[`b6de524b`](https://github.com/falls247/serifu-editor/commit/b6de524b2b73de1ae7f2f66de97471ee935e51ea)。加えて、PNG Workerがglyph overridesの書体もロードするよう修正し、異なる文字書体のPNG一致と再読込を検証した（[`85869ecb`](https://github.com/falls247/serifu-editor/commit/85869ecbc2d0603ec77ef88dbe2e3660401d1e3c)）。タブ終了試験はnative IDB中にCDP Target.closeTargetを使い、終了待機10秒・CI job 15分を上限とする（[`2a987d19`](https://github.com/falls247/serifu-editor/commit/2a987d19009b052fec1410efe80cae724c9e6d2d)）。

Checks [38451564581](https://github.com/falls247/serifu-editor/actions/runs/38451564581)では、正しい非同期待機によって既存browser試験の自動保存待機が失敗した。保存中の追加編集を次の保存へ即時に引き継ぎ、履歴判定のawait前に進行中の保存を確保する。保存ごとのPromiseだけを解除する。さらに素材hash／WebKitバイト変換後・write transaction直前にleaseを更新する。同じdocumentの期限切れではownerEpochを保ち、別writer取得・解放・reloadでは変えるため、他writerが途中に入った古い保存を拒否できる。transactionのowner／token／期限照合は維持した。新設autosave試験の1秒／121秒・writer交代と再読込、3タブ、history、元browser-smokeがローカルで合格。非同期待機helperは未解決のpage.evaluateも30秒の上限で終了し、単体2件でfalseのpollと期限を検証する。

保存開始時にも、最後のlease照会以降にownerEpochが変わっていれば保存を拒否する。次の心拍前にwriter交代・保存・解放が完了したケースを追加し、別writerのlatestを保持して再読込することを確認した（[`459b7092`](https://github.com/falls247/serifu-editor/commit/459b7092ded1af55341098f25be9bdffd5ad5da4)）。

Checks [38457135604](https://github.com/falls247/serifu-editor/actions/runs/38457135604)は既存paged-smokeの83行目で、次画像への複製後の表示範囲が更新前のままとなり失敗した。自動保存を待つ共通guardが、同project内のClipboard操作まで保留していたため。Clipboardのguardは進行中の保存を待たずに適用し、project切替・復元・消去等の待機は保持する。元500ページ試験のassertとtimeoutは変更せず、50／100／全表示、範囲境界の複製・移動、500枚出力、保存復元までローカルで合格。autosave専用試験は画像hashを保留したままClipboard操作が3秒以内に完了することも確認する（[`76e160d0`](https://github.com/falls247/serifu-editor/commit/76e160d0e6f5f42222c71280d0d746aacd152e94)）。

## PCブラウザ検証の追加

追加試験のコミットは[`cc7686f0`](https://github.com/falls247/serifu-editor/commit/cc7686f0586b877c5244f9791ae4ce2c7497273f)。`npm run test:sfx-desktop`で3 engineを順に実行する。結果は`artifacts/sfx-desktop-results.json`へengine名・version・ホストOS／Node版・viewport・起動時override・各操作の結果を保存し、画面を`artifacts/sfx-desktop-*.png`へ記録する。起動やpage作成で失敗しても成功済みengineだけのJSONにせず、失敗したengineを記録する。page作成待機は30秒を上限とし、既存assertと期限を延長しない。

モバイル試験のログも確認した操作だけをPASSと表示する。WebKitではtap／数値／保存復元を記録し、Chromiumだけで実行したnative長押し／2指pinchをWebKitの合格として表示しない。新試験はPC向けの自動確認であり、Windows／macOSやiPhone／iPad実機の正式受入ではない。
