# SFX文字単位編集・保存の検証記録

対象ブランチ: `docs/sow-20261013-sfx-glyph-editor`。着手HEAD: `63f37f6e51b7beeb16908477329684b489f07979`。SOW §1〜14の113決定は変更していない。

コードHEAD: [`36801248`](https://github.com/falls247/serifu-editor/commit/36801248e39266e40cd8b26db67203714f49d9e4)。Checks実行記録: [run 38392728754](https://github.com/falls247/serifu-editor/actions/runs/38392728754)。文書追加後の最新実行は[本ブランチのChecks](https://github.com/falls247/serifu-editor/actions/workflows/ci.yml?query=branch%3Adocs%2Fsow-20261013-sfx-glyph-editor)を参照する。本記録の自動試験合格と、実機の正式受入は別。

## 実行環境

ローカルはLinux、Node 24.19.0、Playwright 1.56.1、Chromium 141.0.7390.37、WebKit 26。日本語の端末書体はNoto CJK、同梱19書体を確定ロードする。CIはNode 22、同じPlaywright版・両engine・Noto CJKを準備する。製品にテスト依存を追加していない。

WebKitはLinux用のブラウザ。390×844／1024×1366、DPR 2、mobile／touch設定で操作した。ローカルでは抽出した共有ライブラリを使うためホスト依存の事前検査だけ省略し、WebKit本体とアプリの試験は実行した。実iOS Safariとは異なる。

## 自動試験

| 対象 | 結果・確認内容 |
|---|---|
| 構文・静的ビルド | 構文89ファイル、`npm run build`、`git diff --check`が合格。新moduleをserver／build／bulkの配信許可リストへ追加 |
| Node単体 | 191件合格。原文grapheme、継承、run、点、幅、輪郭、seed、ID、互換、Worker中断を含む |
| backend | 38件合格、既存適用条件のGPU試験1件は対象外 |
| 既存回帰 | `test:browser`の元22本がすべて合格。最終CIはChecksで確認 |
| 一括描画 | `test:bulk`合格。全21書体のWorkerとmainのRGBA差0、読込中編集、中断／次操作、形式往復、cache、書込失敗、Worker代替 |
| マスク・SAM3 | `test:mask-render`／`test:mask-order`／`test:mask-storage`／`test:sam3-browser`が合格。旧回帰の元スクリプトを使用 |
| SFX基礎・選択 | `test:sfx-lettering-browser`／`test:sfx-selection`。Shift・Alt・矩形・なげなわ、複数複製／Undoと選択、別SFXへのClipboard外観、原文ドラフト取消／確定 |
| 長音線 | `test:sfx-stroke`。S字、Canvas制御点D&D、曲線／線幅点挿入、本文run分割結合、Undo、最終drawとPNG一致 |
| 合成外周 | `test:sfx-outline`。実インク3文字の重なり、手動ロック、grunge前シルエット不変、複数複製、PNG一致 |
| テンプレート・書体 | `test:sfx-template`と単体。異字数、長音なし、deep validation、欠損書体の明示代替／アップロード、元書体名、PNG |
| 旧描画・index | `test:sfx-render`。着手HEADのrenderer fixtureと旧SFX24条件のRGBA差0。改行・絵文字・縦横・光学字詰めの原文index4条件 |
| 出力・再読込 | `test:sfx-export`。画像外警告とクリップ、元寸法1000×750、縦横往復、JSON再読込後のPNGバイト一致 |
| ファイルID | `test:project-open`。三択、追加／別projectのID、同ID画像差替と旧履歴、無効ファイルの原子的UI維持 |
| 保存 | `test:project-history`。v2中断／同ID冪等再試行、旧ストア保持、20回短期確定、5分判定、6→5世代、同内容で履歴追加なし、画像／マスク旧世代、quota／abort rollback、参照検証GC、対象latestだけの消去、共有素材を重複計上しない容量／解放可能量 |
| タブ終了中の保存 | 同history試験でsnapshot書込後のnative IDB transactionを維持し、CDP `Page.crash`。再オープン後も直前のlatest、全history、読める素材bundleを確認 |
| 3タブ | `test:project-tabs`。他2タブ閲覧、最後の明示操作優先、終了／期限切れ後の引継ぎ、latest再読込、旧token保存／削除拒否 |
| モバイル寸法 | `test:sfx-touch`。Chromium／WebKit各2寸法でタップ・数値・保存復元・横はみ出しなし。Chromiumはnative touchによる長押しルーペ／2指pinchも確認。WebKitの多点ジェスチャは実機未確認 |

`test/dev-launcher.test.mjs`はfixtureが `/proc/self/stat` のPIDを報告するよう変更した。検証環境の仮想PIDと `/proc` のPIDが異なり、無関係の生存プロセスを終了失敗と判定したため。終了assert・timeoutは保持した。既存ブラウザsmokeのassert・timeoutは変更していない。

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
| 11 | history smokeの20回確定／5分／5世代 | 実機の長時間放置・再開 |
| 12 | tabs smokeの3タブ終了／expiry／fencing | 実Safariのタブ休止 |
| 13 | open smokeの同ID三択・独立ID・履歴保護 | 実機ファイルピッカー |
| 14 | native IDB中のPage crash／quota／abort、migration再試行 | 実Safariの強制終了 |
| 15 | history smokeの1世代削除／共有参照GCと容量報告 | 実機UI・容量表示 |
| 16 | Chromium／Linux WebKitの2モバイル寸法と保存復元 | **iPhone／iPad Safari、PC主要ブラウザの実機は未確認** |

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
