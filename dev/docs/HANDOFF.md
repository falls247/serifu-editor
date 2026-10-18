# Serifu Editor エージェント引継書

- 記録日：2026-10-10（日本時間）
- コード基準：`b721ad78a7c658f23b83a0da1f6ed13c950c9696`
- リポジトリ：[falls247/serifu-editor](https://github.com/falls247/serifu-editor)
- 公開版：[GitHub Pages](https://falls247.github.io/serifu-editor/)

## 1. 現在地と作業方針

2026-10-18追加：READMEを起動用に整理し、利用者向けの操作説明をルートの[HTML操作説明書](../../docs/index.html)へ移した。以後のアプリ改修では[操作説明書の更新ルール](documentation-maintenance.md)に従い、利用者向けの変更と同時に説明書も更新する。

2026-10-17追加：プリセット適用時のカード保持・描画集約、インクマスク処理範囲の縮小、選択ページを優先する段階的な表示準備を実装した。[ADR-0031](adr/0031-selected-page-priority-and-preview-updates.md)と[性能・検証報告](editor-interaction-performance.md)を参照。回帰は`npm run test:editor-interaction`、計測は`npm run benchmark:editor-interaction`／`npm run benchmark:glyph-render`。プレビュー選択による文字サイズ70→81は未再現。

同日追補：長距離のサムネイル移動は直接スクロールし、背景準備・画像load・ResizeObserver後も移動先の位置を保つ。位置保持は新しい利用者操作や表示範囲の世代変更で解除する。初回`prepareMountedPage()`は`renderCards({restoreWindow:false})`を使い、文書スクロールを古い値へ戻さない。再利用した行の有効なload/resize callbackは現在の世代を参照する。選択済み入力欄への`focusin`は再選択・再描画を省く。候補表示前の待ちと最終停止位置の計測は`npm run benchmark:navigation-menu`。

2026-10-16追加：吹き出しの多角形モードを追加した。頂点数3〜60（既定6）の指定・ランダム生成、歪み度・seedの調整、Undo・プリセット・コピー・各保存形式に対応する。現在の `PROJECT_VERSION=15`、`RENDER_VERSION=12`。仕様は [ADR-0029](adr/0029-polygon-balloons.md)、ブラウザ検証は `npm run test:polygon-browser`。

2026-10-16追加：フォルダ内の `画像名.jpg.json`（`schemaVersion: 1`）から下書きを自動生成する。既定プリセットで右上から左、次に下段へ配置し、必要なら縮小する。最小サイズでも収まらない分は画像外へ配置して警告する。仕様は [ADR-0028](adr/0028-annotation-draft-import.md)、ブラウザ検証は `npm run test:annotation-drafts`。外部下書き形式とアプリの編集データ形式は別物。

複数画像へ台詞・効果音・吹き出し・キャプションを配置する、ブラウザ内処理の静的Webアプリ。元画像／入力／ライブプレビューの3列を画像ごとに縦へ並べる。これまでの依頼機能は上記コミットで実装・公開済み。

ユーザーは以後、ローカル側リポジトリで開発を継続する方針。次のエージェントはローカルの実ファイルとGit差分を起点に作業する。クラウド側の作業ディレクトリや過去のアップロード先には依存しない。コミット、push、公開の範囲は、その時点のユーザー指示に従う。この文書は新たな追加機能や公開指示を定義しない。

2026-10-10追加実装：対象別テキスト出力、ページ移動、一覧順のPNG連番、読込フォルダを初期位置にした保存先選択。[ADR-0007](adr/0007-page-order-and-text-export.md)を参照。上記コード基準は追加前の記録。追加実装は作業用ブランチの実ファイルと差分で確認する。

続く追加実装：キャプション本文の輪郭、Canvas選択中のDelete、50／100件・全表示、倍率・表示切替付きの左側サムネイル。[ADR-0008](adr/0008-paged-editor-and-caption-outlines.md)を参照。ADR-0007までのコミットは `b35abd5`。今回の作業用ブランチは `feat/paged-thumbnail-editor`。

続く追加実装：全4種類の名前付きプリセット。各カードで保存・選択し、種類別の既定へ反映する。[ADR-0009](adr/0009-named-layer-presets.md)を参照。追加前のHEADは `e1d7081`、作業ブランチは `feat/named-layer-presets`。

続く追加実装：500枚の一括処理を初期2個・読込時最大4個のWorkerと容量制限付きキューへ移行。共通進捗と中断、画像追加中の先行編集、PNG生成と書込みの重なり、128MiB PNGキャッシュ、差分一時保存、高速 `.serifu` 形式を追加。[ADR-0010](adr/0010-bulk-processing-and-progress.md)と[実装後報告](bulk-performance-report.md)を参照。作業ブランチは `feat/bulk-performance`。コミット・push・公開は未実施。

追加修正：進捗を暗色へ統一し、終了時に非表示。Braveなど保存先選択APIのない環境ではPNGと編集データをZIPでダウンロードする。全件／編集済み抽出、従来JSON／高速形式に対応。ZIPは全体4GiB未満・65535ファイルまでで、作成中の収録Blobを保持する。直接フォルダ保存の選択待ち・準備待ちにも中断を反映する。

着手時は `git status --short --branch`、現在のHEAD、適用される `AGENTS.md` を確認し、既存変更を保ったまま作業する。この引継の作成時点で、リポジトリ内に `AGENTS.md` はない。

先に [起動用README](../../README.md)、[HTML操作説明書](../../docs/index.html)、[操作説明書の更新ルール](documentation-maintenance.md)、[ADR一覧](adr/README.md) を読む。動作と設計の詳細は対応するコードを確認する。

## 2. ローカル起動と編集データの移行

Node.js 22以降を使用。アプリ本体にnpm依存パッケージはなく、通常起動のための `npm install` は不要。

初めて取得する場合：

```bash
git clone https://github.com/falls247/serifu-editor.git
cd serifu-editor
```

取得済みのcloneは作業状態と追跡先を確認して更新する。作業中の変更や分岐がある場合、強制リセットで消さない。

```bash
git status --short --branch
git fetch origin
git pull --ff-only
```

リポジトリルートで実行：

```bash
node --version
npm run fonts
npm start
```

`http://localhost:5173` を開く。`server.mjs` は開発用サーバーで、画像処理用のバックエンドではない。ポートは環境変数 `PORT` で変更可能。HTMLを `file://` で直接開く運用は前提にしない。

初回の `npm run fonts` はGoogle Fontsの固定バージョンを取得するためネットワーク接続が必要。添付由来の2書体はリポジトリ内の原本から準備する。`assets/fonts/` はGit管理外の生成物なので、clone直後に存在しなくても異常ではない。

GitHub Pagesとlocalhostは別のorigin。公開版のIndexedDB一時保存・localStorageプリセットは、コードをcloneしてもlocalhostへ移らない。公開版で「編集データを保存」し、ローカル版で「編集データを読込」する。JSONに画像・レイヤー・プリセットを含む。読込後は元フォルダとの接続を持たず、元画像削除は無効。ブラウザやポートの変更時もoriginごとの保存領域を区別する。

JSON読込は現在の画像一覧へ追加する。一時保存の復元は一覧を置き換える。どちらも `mergePresets` で未登録IDのユーザープリセットと既定選択を取り込むが、同じIDの既存プリセットを上書きしない。自動保存設定はデータに含まれるものの、現行の読込処理では適用しないため、移行先で周期とON／OFFを再設定する。

## 3. 実装済みの機能

| 領域 | 現在の仕様 |
|---|---|
| 台詞 | 男性 `#111111`、女性 `#ef4b91`、白縁。新規は縦書き。入力欄は1行開始、明示改行で高さを増やす |
| 効果音 | 漫画装飾、縦横ブラー、残像、歪み、掠れ、ハネ、数値によるインクの太さ、文字サイズのばらつき・左右のズレ |
| 先細り | `effect='taper'`。変化率 `taperRate` 初期10%。基準100pxなら100→90→80px、最小8px。改行や折返しでも順番を継続 |
| 装飾なし | `effect='none'`。集中線・震え・立体影なし。独立指定したブラー・掠れ・歪みは保持 |
| 吹き出し | `kind='balloon'`。独立した楕円、初期白・25%透過・テールなし・画像端からはみ出す配置。枠線色／太さとテール編集 |
| キャプション | `kind='caption'`。本文付き長方形、初期白背景25%透過・黒枠・縦書き・左右上下中央揃え。文字・背景・枠線の各色を編集 |
| 自動追従 | キャプションのみ `autoFit` 初期OFF。ONでボックス内に収まる文字サイズを算出。OFFの手動サイズは保持 |
| キャプション本文輪郭 | `textOutlineWidth` 0〜80px（初期0＝なし）、`textOutlineColor` 初期白。配置・自動追従に幅を反映。旧データは輪郭なし。コピー・Undo・PNG・JSON・一時保存に保持 |
| 配置 | ドラッグ移動、角でサイズ、丸で回転、数値入力、矢印移動。縦書き句読点は右上 |
| カード操作 | 男女の切替は台詞見出しの右横。セリフ交換UIとイベント経路は削除済み。モデルの `swapText` はアプリから未使用 |
| コピー | 選択レイヤーのCtrl／⌘+C/V、画像単位の一括コピー・カット・ペースト、次画像への追加。横長→縦長にも拡縮対応 |
| プリセット | 全4種類の書式と配置を名前付きで記憶。各カードで保存・選択・削除。種類別の既定を新規追加にも適用。本文・話者は保持。同じ種類・同名は確認後に上書き。カードの削除と上部の×で削除。配置済みの見た目は保持 |
| 保存 | 画像単体PNG、全画像一括、編集済みだけ一括、画像を含むJSON、一時保存、周期指定の自動保存（初期2分） |
| 本文出力 | 女性台詞を初期選択に、男性／全台詞／キャプション／効果音／全本文から選ぶ。ページ順・カード順にTXT保存。台詞1件ごとに「」で囲んで改行、キャプション・効果音は括弧なし。空本文は省略 |
| ページ順 | 「編集完了・次へ」の左に「ページ移動↑」「ページ移動↓」。並べ替えを画面・移動・JSON・一時保存・出力へ反映。画像の確認済み・編集済み・Undo履歴は保持 |
| 表示件数 | 初期50件、100件ずつ・全表示。現在のページを含む範囲を表示。範囲外のDOM・Canvas・元画像デコード結果を解放。保存対象は全体のまま |
| サムネイル | 広い画面では左、狭い画面では上。元画像を長辺320pxへ縮小。番号・未編集／編集済み／確認済み・現在位置を表示。クリックで範囲切替と編集画面への移動。表示／非表示、倍率50〜200% |
| Delete | Canvasにフォーカスがあるとき選択レイヤーを削除。Ctrl／⌘＋Zで戻す。本文入力・IME変換中・処理中は対象外 |
| 一括PNG命名 | 全体のページ順で `p{連番}_{元の名前}.png`。桁数は一覧枚数に追従（9枚：`p1_`、10枚：`p01_`、100枚：`p001_`）。編集済みだけでも全体の番号・桁数を保持。元拡張子はPNGへ置換 |
| 一括保存先 | 毎回選択でき、最後に読込成功した接続済みフォルダを初期位置にする。選択先に新規 `serifu_...` フォルダを作成。JSON・一時保存の復元後など接続がなければブラウザの既定位置 |
| 書体 | 21選択肢＝同梱19書体＋端末2書体。GEKIFUDE SFXと851チカラヨワクを含む |

「確認済み」`done` と「編集済み」`edited` は別。選択や確認だけでは編集済みにしない。追加した文字を全カット・削除した画像も編集済みになり得る。最初の編集をUndoすると未編集へ戻る。レイヤーを持つ読込画像は編集済みとして扱う。

## 4. コードの入口

2026-10-11の整理以後、アプリ用 `.js` 22件はすべて `src/` 直下。内部相互importは `./xxx.js`、Node単体テストとNode側scriptsは `../src/xxx.js`、ブラウザのHTMLと動的importは `./src/xxx.js`。

```text
index.html → ./src/app.js → ./src/{renderer,model,storage,fonts,...}.js
             ./src/bulk-pool.js → ./src/image-worker.js
             ./src/project-io.js → ./src/project-worker.js
server.mjs → src/*.js + HTML/CSS/画像 + assets/fonts/*
scripts/build.mjs → _site/src/*.js + _site/assets/fonts/*
```

Workerの `import.meta.url` 基準のフォントURLは `../assets/fonts/`、`src/fonts.js` がインラインCSSへ書くURLは**文書URL基準**の `./assets/fonts/`。両者を混同しない。Workerのフォールバックが異常を隠さないよう `npm run test:bulk` でWorker稼働とサブパス配信を確認。関連: [ADR-0017](adr/0017-src-layout-and-static-assets.md)、[移行SOW](sow/SOW_20261011_src_reorganization.md)。



以下のパスはリポジトリルートからの相対パス。

| ファイル | 責務・主な入口 |
|---|---|
| [app.js](../../src/app.js) | DOM、画像一覧、選択状態、イベント、ドラッグ、保存。`makeLayer`、`renderCards`、`updateControls`、`connectCanvas`、`saveImage`、`saveImages`、`temporarySave` |
| [export.js](../../src/export.js) | 一括PNGのページ番号・桁数・名前 `pageExportName`、対象別本文整形 `textExport` |
| [index.html](../../index.html) / [style.css](../../style.css) | 画面構造・各画像のテンプレート・3列とモバイルのレイアウト |
| [model.js](../../src/model.js) | 保存データ検証、履歴、コピーの拡縮。`normalizeLayer`、`checkpoint`、`restore`、`pasteSelection`、`pasteLayers` |
| [renderer.js](../../src/renderer.js) | `newLayer`、共通 `draw`、文字配置 `textGlyphs`、先細り `glyphFontSize`、インク描画、キャッシュ、選択・ハンドル判定 |
| [ink.js](../../src/ink.js) | 太さ変更、ブラー、掠れ、ハネ、固定seedの文字ばらつき |
| [typography.js](../../src/typography.js) | 書記素分割、縦書き記号の回転、句読点の右上配置 |
| [balloons.js](../../src/balloons.js) | 楕円・テールの形状、描画、実形状のヒット判定、制約付きの描画順 `paintOrder` |
| [captions.js](../../src/captions.js) | 本文配置 `captionLayout`、上下左右の揃え方、余白、文字サイズ自動追従、クリッピング |
| [presets.js](../../src/presets.js) | 既定・ユーザープリセット、解像度比の保存、適用、旧設定の補完 |
| [storage.js](../../src/storage.js) | IndexedDBの一時保存。メタ情報と画像を同一トランザクションで保存 |
| [fonts.js](../../src/fonts.js) | 書体カタログ、実ウェイト、配信CSS、フォントと規約のGit blobチェックサム |
| [scripts/fetch-font.mjs](../../scripts/fetch-font.mjs) | 固定版の書体取得／同梱原本の復元とチェックサム検証 |
| [server.mjs](../../server.mjs) / [scripts/build.mjs](../../scripts/build.mjs) | 開発時の配信許可リスト／`_site/` にコピーする静的ファイル一覧 |

新規追加の実際の既定値は、`newLayer` だけでなく `app.js` の `makeLayer` → `applyPreset` も確認する。ユーザーが記憶したプリセットが上書きされるため、コンストラクター変更だけでは既定の見た目が変わらない場合がある。

全ページに `row`／`canvas` があると仮定しない。範囲外はnullまたは未作成。`renderCards`・`updateControls`・`drawPage` は非表示を許容し、`activate` が対象範囲をマウントする。元画像Imageは寸法を持つが非表示時はsrcを外し、PNG保存では `imageBlob` が読み直す。コピー・削除・順序変更・復元は範囲の境界を確認する。

段階的マウントでは`row`が存在しても、画像・カード・イベントの準備が未完了の場合がある。`mountPage`は軽い枠を作り、`prepareMountedPage`が重い準備を行って`mountReady`を立てる。準備世代と`mountToken`の確認を維持し、古い読込みや通知を新しい表示へ反映しない。`sizePreview`／`updateImageView`／`renderCards`の`draw:false`は呼出し側で描画をまとめるための指定で、全呼出しを無条件に描画抑制しない。

## 5. 変更時に確認する範囲

| 変更 | 同時に確認する箇所 |
|---|---|
| 新しいレイヤー／設定値 | 初期値、中央カードと右側入力、`normalizeLayer` と範囲、描画、コピー拡縮、Undo、JSONと一時保存、関連テスト |
| 全種類の書式 | 上記に加え `presets.js` の `presetFields`／`presetDimension` と旧プリセットの既定値 |
| 書体追加 | `FONT_CATALOG`、原本・規約・blob SHA、取得処理、実ウェイト、読込後キャッシュ破棄、保存時の読込待ち |
| ボックス／テール | 回転前のローカル座標、ヒット判定、ハンドル、異なる縦横比へのコピー、吹き出しの描画順 |
| 新規ブラウザ用JS | `src/` に配置し、importに加え `server.mjs` と `scripts/build.mjs` の明示リスト、必要なら `package.json` の構文チェック |
| 永続化の破壊的変更 | `PROJECT_VERSION`、JSON読込可能版、一時保存復元可能版、欠損値の補完、互換性テスト、ADR |

単体保存・一括保存・プレビューは共通の `draw` を使う。保存は元解像度、選択枠なし、書体読込完了後。プレビューだけにCSSエフェクトを追加するとPNGに反映されないので、描画変更は共通経路へ入れる。

コピーで作り直す `id` と、見た目を固定する `glyphSeed` を混同しない。描画のたびに乱数を振り直さない。保存・コピー・復元で見た目が変わる。

吹き出しは常に台詞・キャプションより下。`paintOrder` を無視して単純な配列順描画に戻すと仕様を壊す。選択判定も描画順の逆順を使う。

## 6. 保存形式とデータの境界

現在の `PROJECT_VERSION` は6。JSONはversion 1〜6、一時保存はversion 3〜6の復元に対応。version 5以前でキャプションの `alignX`／`alignY` がない場合は旧配置の右／上を補完し、新規・version 6の既定は中央／中央。version 1の旧 `bubble` は男性台詞へ移行し、旧吹き出し形状は引き継がない。

プリセット形式はversion 1のまま。全4種類を扱い、旧設定には吹き出し・キャプションの標準設定を補完する。両種類の任意の `presetId` も編集データversion 6のまま保存する。localStorageキーは `serifu.preferences.v1`。IndexedDBは `serifu-editor-drafts`、DBスキーマ版1、`drafts` と `images` の2ストア。編集データの版とDBスキーマ版は別。詳細は [ADR-0004](adr/0004-edit-data-and-drafts.md)。

一時保存は最新1件・origin単位。別タブの保存で置き換わり得る。持ち出し用バックアップはJSON。元フォルダのハンドルは永続化せず、復元後に実ファイルの削除権限を再現しない。

ページ順は `pages` 配列を基準にし、保存データの配列順に保持する。ページ移動はrevisionを更新するが画像の `edited`／`done` は変更しない。画像別Undoの対象外で、移動ボタンで戻す。追加フィールドがないため `PROJECT_VERSION=6` を維持する。

キャプションの輪郭は欠損値を補完する任意フィールドとして追加し、version 6を維持する。表示設定はlocalStorage `serifu.view.v1` に保存し、JSON・一時保存に含めない。画像寸法とサムネイルは復元時に再生成する。

## 7. 検証

通常のローカル検証：

```bash
npm run check
npm test
npm run build
git diff --check
```

描画・配置・保存・フォント・操作を変更した場合はブラウザ検証も実行。PlaywrightとChromiumはアプリ本体の依存に追加せず、テスト用に導入する。

```bash
npm install --no-save --package-lock=false playwright@1.56.1
npx playwright install chromium
npm run fonts
npm run test:browser
```

Ubuntuでブラウザのシステム依存が不足する場合は `npx playwright install --with-deps chromium` を使用。CIはさらに `fonts-noto-cjk` を導入して端末書体の日本語フォールバックを用意している。Windows環境にUbuntuのapt手順をそのまま適用しない。

| ブラウザ検証 | 主な対象 |
|---|---|
| [browser-smoke.mjs](../../scripts/browser-smoke.mjs) | 3列、複数画像、プリセット、太さ、ばらつき、コピー／カット、異なる縦横比、復元、フォルダ保存・元画像削除の模擬API |
| [balloon-smoke.mjs](../../scripts/balloon-smoke.mjs) | 編集済みだけ保存、単体PNG、書体読込待ち／失敗、GEKIFUDE、透過、テール、順序、枠線色、PNG一致 |
| [caption-smoke.mjs](../../scripts/caption-smoke.mjs) | 手動追加、自動追従、手動サイズ保持、中央揃え・方向変更、クリップ、コピー、PNG一致、version 4/5互換 |
| [typography-smoke.mjs](../../scripts/typography-smoke.mjs) | 添付TTFのバイト一致、台詞・効果音の書体、5書体×2太さで句読点右上、装飾なし、先細りの実描画、変化率、復元 |
| [export-smoke.mjs](../../scripts/export-smoke.mjs) | テキスト出力・括弧・本文改行、ページ移動・状態保持、連番・欠番・桁数、保存先の初期位置・変更・取消・失敗、JSON・一時保存のページ順、モバイル配置 |
| [paged-smoke.mjs](../../scripts/paged-smoke.mjs) | 500件の表示数、範囲境界の複製・完了・移動、サムネイル寸法・倍率・状態・表示切替、Delete／Undo、輪郭のPNG一致・保存・復元、全件保存・全体TXT |

各スクリプトはサーバーを起動・終了する。ポート5187／5189／5191／5193／5195／5197を使用。スクリーンショット等は `artifacts/`（Git管理外）へ出力する。実画像フォルダを使った削除テストは不要。現行テストは模擬ハンドルを使用する。

引継基準コミットでは、49件の単体テストと4本のブラウザ検証に成功。[Pages実行38016273473](https://github.com/falls247/serifu-editor/actions/runs/38016273473)のbuild／deployも成功し、公開された主要コード・添付TTFが手元の内容と一致することを確認済み。この記録は基準コミットの結果であり、次の変更後の合格を意味しない。

2026-10-10追加実装のローカル検証：構文チェック、単体テスト、静的ビルド、差分の空白チェックに成功。既存4本と追加の `export-smoke.mjs` の計5本も成功。追加検証では女性・男性・キャプションのTXT実ファイル、ページ移動後の順序・状態保持、10枚への桁数変更、編集済み抽出時の欠番、模擬フォルダAPIの初期位置・別保存先・取消・失敗、JSON・一時保存の順序保持、狭い画面の配置を確認。実OSのフォルダ選択ダイアログでの初期位置は未確認。コミット・push・公開は未実施。

ADR-0008追加実装の検証：構文・単体・ビルド・差分チェックと、既存5本＋ `paged-smoke.mjs` の計6本に成功。500件の生成画像で編集DOM／Canvasが50・100・500件へ切り替わること、長辺320pxのサムネイル、状態・倍率・表示切替・設定保持、範囲境界の複製・完了・順序変更、DeleteとUndo、輪郭のCanvas実描画・PNG一致・旧データ互換、表示範囲外を含む500枚のPNG・JSON・TXT保存と一時保存復元を確認。実際の500枚の大画像・多量エフェクトによる性能測定は未実施。今回のコミット・push・公開は未実施。

ADR-0009の追加実装：構文・差分確認を実施。単体・ブラウザの動作検証は未実施。前項の成功記録は今回のプリセット変更後の結果ではない。コミット・push・公開は未実施。

## 8. 公開・運用の制約

GitHub Pagesは `.github/workflows/pages.yml` がmainへのpush、または手動実行で公開する。構文、単体、ブラウザ、フォント準備、静的ビルドを経て `_site/` を配信。通常CIの `.github/workflows/ci.yml` はpush／pull_requestで構文・単体・ビルド・一括/ブラウザ回帰テストを検証する。詳細は [ADR-0006](adr/0006-test-and-delivery.md)。

画像の一括保存・元画像削除には `showDirectoryPicker` が必要。APIがない環境では画像読込の代替と単体PNG／JSON保存は使えるが、直接フォルダ保存・元画像削除は使えない。実装は利用者の元画像を上書きしない。元画像削除は確認後の完全削除で、Undoやゴミ箱復元は提供しない。

大画像・多数画像・強いエフェクトの処理性能を網羅するベンチマークは未実施。描画はメインスレッドで行い、極端な設定では中間字形画像の解像度を制限する。出力PNGの寸法は元解像度のまま。ブラウザ・端末書体をまたぐバイト一致は受入基準にしておらず、同じ環境で選択枠なしのプレビューとPNGが一致することを検証している。

次の追加機能はユーザーの次の指示から決める。変更点、検証結果、実際に残った制約を報告し、機能・データ構造が変わった場合はこの引継書とADRの該当箇所を更新する。

## 一括処理の引継（2026-10-10）

- 編集データの初期保存形式は `.serifu`。同じ読込ボタンで旧JSON version 1〜6も読める。旧アプリへ渡す場合は「従来形式 (.json)」を明示選択する。一括PNGへ添付する形式も選択値に従う。
- `bulk-task.js` は操作ID・段階・確定件数・中断・計測、`bulk-pool.js` は画像Workerの起動確認・上限・タイムアウト・代替経路を担当する。キューは投入順に結果を返し、生成と書込みを重ねる。
- `image-worker.js` は画像準備・320px WebPサムネイル・PNGを共通 `draw` で生成する。`image-metadata.js` はPNG/JPEG/VP8Xのヘッダから割当用の寸法を取得し、未知の形式は単独処理する。
- `export-cache.js` は描画状態による128MiBのLRU。表示倍率・ページ番号・選択はキーに含めない。書体状態の変更時に失効する。
- `project-io.js` はコンテナ、旧JSONの逐次出力、writer abort、入力検証を担当する。外部プロジェクトのページID・ファイル参照・フォルダ情報は採用せず、新規画像IDを発行する。`project-worker.js` はJSONの解析・変換を担当する。
- 画像追加中は採用済みページの編集と表示範囲移動を許可する。PNG・編集データ出力中は本文編集を禁止し、表示範囲移動を許可する。一括レイヤー操作は準備完了まで履歴・データを変更しない。
- 手動一時保存は前景の進捗パネル、自動保存は `draftStatus` を使う。保存中も編集でき、開始revision以後の変更は未保存として残す。前景処理中は自動保存を延期する。
- `window.serifuMetrics` は直近の前景操作、`window.serifuDraftMetrics` は手動一時保存の測定値。`poolDelta` は当該操作のWorker時間・件数、`pool` はセッション累計。容量の割当見積もりと実際の保留Blob byteを区別する。
- 検証：`npm run check`、`npm test`、`npm run test:browser`、`npm run build`、`npm run test:bulk`。bulk検証は `_site/` を使うため先にビルドする。PlaywrightとChromiumが必要。
- 性能測定：`npm run benchmark:bulk -- after`。初期値は3種類×500枚×3回、短い診断は `BULK_COUNT`・`BULK_RUNS` で変更する。出力はGit管理外の `artifacts/bulk-benchmark/`。書込みは2ms遅延の疑似writerであり、実ディスクの性能値として使わない。

## 2026-10-10: ink print distress / balloon styles

- ブランチ: `feat/manga-ink-balloon-styles-20261010`（`main`へ直接反映しない）
- 追加: `ink.js:printDistressMask` の本文マスク、透明欠け、飛沫。 `renderer.js` は文字index＋textureSeedでキャッシュを区別し、欠けを `destination-out` で抜く。
- `model.js` はPROJECT_VERSION=7。効果音のインク質感と `outline=0`、吹き出しの影・ブラシ設定をバリデーション。プリセットseedは除外。
- 吹き出し `spiky` の放射状外周を鋭くし、中央本文の `w/h` を70%へ変更。影・ブラシ・既存テールを保持。
- `project-io.js` はJSON 1～7、`.serifu` 内部6/7読込。新版書き出しは7。
- `export-cache.js` の描画版2。従来Workerの共通 `draw()` を維持。
- 単体テスト追加: `test/print-distress.test.mjs`, `test/balloon-effects.test.mjs`。既存 `test/bulk-task.test.mjs` のプロジェクト版期待値を更新。
- 既存 `main` で失敗していた先細りテストは、別列間の差分ではなく同列の配置を検証するよう修正。
- 継続確認事項: PNG RGBA差分、実ブラウザでの参照画像比較、Workerレンダリング一致、性能P50/P95。未計測は成功扱いしない。
- ADR: `dev/docs/adr/0012-distressed-ink-and-balloon-effects.md`。

## 2026-10-11: プレビューのCtrl＋ドラッグ複製

- 実装: `src/app.js` の `connectCanvas`。Ctrl／⌘＋ドラッグで選択レイヤーを同一ページ内に複製し、Ctrl／⌘＋Shift＋ドラッグでは移動量の大きい軸へ拘束。元の位置を起点とする水色破線ガイドはプレビュー限定、PNGには描かない。
- 算出: `src/model.js:dragPlacement`。DOMの表示倍率に依存せず元画像座標系で扱い、単一のUndoチェックポイントで複製する。移動しないクリックは無変更、途中キャンセル時は複製を巻き戻す。
- ハンドルのサイズ変更・回転・テール調整、通常ドラッグ、テキスト入力のショートカット動作は維持。確認: `test/drag-placement.test.mjs` と `scripts/drag-duplicate-smoke.mjs`。


## SAM3追加（2026-10-11）

実装計画は[SOW](sow/SOW_20261011_sam3_segmentation.md)、設計変更は[ADR-0023](adr/0023-sam3-mask-effects-and-storage.md)、実機を含む検証結果は[検証記録](sam3-gpu-validation.md)を参照する。ユーザー指定の`feat/sam3_detect`で実装し、最新main `cf3437e8a1a494132806ca26258336712439f42e`に含まれる文字順とサムネイル機能を維持する。

文字順の仕様に版11が使用済みのため、マスク対応は版12／コンテナ版2。`normalizeLayer`の旧順移行条件（版11未満）を版12未満に変更しない。素材バイトはUndo履歴へ入れない。通常画面はrenderer末尾optionsにmaskEffects/maskAssets/draft/maskSelectionを渡し、書き出しにはdraftと選択を渡さない。変更時はPNGキャッシュとサムネイルを更新する。

IndexedDB版2は旧ストアを保持してmasksを追加する。確定マスク全件を圧縮Blobとメタデータの現行スナップショットにまとめ、画像・編集メタデータと同一トランザクションで置き換える。保存前に参照とchecksumを検証し、失敗時に前回の有効な保存を残す。`scripts/mask-storage-smoke.mjs`は版1からの移行、復元、失敗・中断と素材解放を検証する。

`npm run dev`はNode/FastAPIのプロセスグループを監視し、片方の異常終了やSIGINT/SIGTERMで両方を停止する。`SAM3_MOCK=1`だけがモックを有効にし、通常はgpu extraで固定版SAM3を使用する。`npm start`とGitHub PagesにはPythonを含めない。server/buildのES module許可リストと構文チェックに新moduleを含める。

コミットとPR作成はユーザーのコミット承認後。実機未確認・未完了の項目は検証記録のまま引き継ぎ、正式完成と表現しない。

2026-10-11の追加指示で、マスクカードも非選択時に短縮表示し、文字と共通の重なり順へ対応した。[ADR-0024](adr/0024-shared-mask-and-text-order.md)を参照。現在の出力は版13／コンテナ版2、旧JSON版12も読込可能。各オブジェクトの`layoutOrder`を保存する。配列を分けたまま共通`paintOrder`でカード・描画・Canvas選択を揃え、前面のマスクは文字を覆う。旧データの文字が前面にある見た目を維持し、順序変更時に全オブジェクトへ連番を付ける。版11未満の旧文字順移行は維持する。


## SFXグリフ編集の引継ぎ（部分実装）

対象ブランチ: docs/sow-20261013-sfx-glyph-editor。src/sfx-lettering-model.js（P1）、src/sfx-stroke-geometry.js（P3の原型）、src/renderer.js（新SFX描画分岐）、src/app.js（編集開始、グリフ/線設定、ドラッグ、Undo/Redo）の順に確認。全113要件の完了ではない。各runの数値制御点編集とv14 projectId/pageId保存まで追加。P3〜P8の残作業一覧はADR 0027。既存IndexedDB v2のデータ移行は検証なしで進めない。


## 2026-10-14 SFX/プロジェクト永続化の最新引継ぎ

前掲の部分実装・CI赤の記述は当初時点の履歴。H-01/H-02の復元・SAM3再検出を修正し、P1〜P7の残機能と専用回帰を追加した。最新状態は[SOW §0](sow/SOW_20261013_serifu_sfx_glyph_editor.md)、設計は[ADR-0027](adr/0027-sfx-lettering-foundation.md)、試験とUATの対応は[検証記録](sfx-validation.md)を参照する。実装先は `docs/sow-20261013-sfx-glyph-editor`。`main`へ別途指示なくpush・mergeしない。

- `sfx-lettering-model.js` は原文index・本文継承・単独／連続長音・上限検証、`sfx-edit-operations.js` は複数文字の変形・複製・Clipboard・縦横変換、`sfx-editor.js` は選択・Canvasハンドル・タッチ・詳細設定。
- `sfx-stroke-geometry.js` は実インク接続、de Casteljau分割、結合、点・幅・cap・固定距離。`sfx-outline-groups.js` は自動／手動ロックと合成外周。`renderer.js` は共通描画と変形後の質感・bounded cache。原文indexと描画順indexを混同しない。
- `project-history.js` はv3の原子的保存・同一read transactionでの復元・履歴・移行・GC。最新と直前履歴の比較を分ける。同じページIDの画像差替では `imageSaved` をfalseにして素材を渡す。
- `project-lock.js` はdocument別ownerとfencing。再読込のowner引継ぎは新tokenを発行する。タブのprojectIdをsessionStorageで固定し、DBのglobal activeを別タブの復元対象に流用しない。閲覧から編集への昇格は最新を再読込してから。
- 旧 `drafts/images/masks` は保持。GCで参照破損を発見したら回収中止。Quotaで履歴を自動削除しない。Blob非対応環境は失敗transactionをabortしてからバイト列保存へ切り替える。
- `bulk-pool.js` の起動・中断はgenerationを持つ。旧操作のcleanupが新Workerのhandlerを消さない。UI一括更新のcacheはページmount時に破棄し、文字サイズ設定もcache keyへ含める。
- 新moduleを `server.mjs`・`scripts/build.mjs`・`scripts/bulk-smoke.mjs` の許可リストへ追加済み。Playwrightは1.56.1、ChromiumとWebKit、日本語端末書体をCIで準備する。

実機iPhone／iPad SafariとPC主要ブラウザの正式受入は未確認。Chromium／Linux WebKitのモバイル寸法試験と実機合格を区別する。次は専用プロファイルと複製データでSOW UAT-16を確認し、検証記録へ端末・OS・ブラウザ版と結果を追記する。GPU試験は既存の適用条件を維持する。

2026-10-14のCI補正: `browser-wait.mjs`は非同期の保存確認を結果までawaitしてpollする。Promise自体を成功とみなす待機を使わない。元のassert・期待値・30秒の上限は維持。`image-worker.js`はglyph overridesの書体もロードする。最新版の成功／失敗は検証記録冒頭のcode SHAとChecksを照合する。

保存の追従補正: 進行中の保存を履歴照会前に確保し、成功後の追加編集を即時に次の保存へ渡す。画像hash・WebKitバイト変換後の`beforeCommit`でleaseを更新する。`ownerEpoch`は同documentの期限切れで維持し、writer交代・解放後の取得・reloadで変わる。古いtokenは常に拒否し、準備中に他writerが確定したlatestを上書きしない。編集権の再読込は進行中の保存が終わってから開始する。`test:autosave-catchup`で1秒／121秒保留中の追加編集、旧token、writer交代、latest再読込を検証する。

保存開始前にも最後のlease照会からのownerEpoch変更を検査する。別writerが次の心拍前に保存・解放した場合も、保存を拒否してlatestを再読込する。4ケースのautosave専用試験と既存回帰をChecksで実行する。最終コードとCIの照合先は[検証記録](sfx-validation.md)。

Clipboardのguardは`waitForDraft:false`で、同project内のコピー・カット・貼付け・次画像への複製を保存中も適用する。project切替・復元・消去等は保存を待つ。元`paged-smoke.mjs`の500ページ確認を保持し、autosave専用試験で画像hash保留中もClipboard操作が完了することを確認する。

PCブラウザ検証を追加（2026-10-14）: `npm run test:sfx-desktop`はChromium／WebKit／Firefoxで編集・曲線D&D・個別書体・PNG・JSON/.serifu・IndexedDB復元・3タブ排他を確認する。`sfx-test-support.mjs`は既定Chromiumを維持したままengineを切替可能にし、page作成を30秒で打ち切る。結果JSONにOS／ブラウザ版／起動overrideを残す。CIは3 engineを通常設定で実行する。モバイルログはWebKitで未実行のnative長押し／pinchをPASSに含めない。Linux headlessの合格と実機の正式受入は区別する。
