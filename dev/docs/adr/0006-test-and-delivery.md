# ADR-0006: ローカル検証とGitHub Pagesの公開経路を分ける

- 状態：採用済み（既存実装の事後記録）
- 記録日：2026-10-10（日本時間）
- コード基準：`b721ad78a7c658f23b83a0da1f6ed13c950c9696`

## 背景

画像編集はコード上の値だけでなく、実書体の描画、フォーカス、ドラッグ、保存の非同期処理で不具合が起こる。ローカル側リポジトリへ作業を引き継ぎ、静的アプリをGitHub Pagesで継続して配信する。将来のエージェントが過去のクラウド環境を前提にしない手順を残す。

## 決定：開発・検証

ローカルの実ファイルとGit差分を起点に作業し、変更中のファイルを強制リセットで消さない。コミット・push・公開の範囲は最新のユーザー指示に従う。引継書やADRは将来の公開を自動で許可する文書ではない。

Node.js 22を基準に、通常起動はフォント準備と `npm start`、基本検証は以下を使う。

```bash
npm run check
npm test
npm run build
git diff --check
```

`npm run check` は明示したJavaScriptの構文検証、`npm test` はNode標準の単体テスト。基準コミットでは49件。描画・フォント・保存・操作を変更したときは、Playwright 1.56.1とChromiumをテスト用に入れ、`npm run test:browser` も実行する。アプリ本体に依存として追加しない。

| ブラウザスクリプト | 主な検証 |
|---|---|
| `browser-smoke.mjs` | 複数画像、入力、プリセット、コピー／カット、縦横比変更、復元、フォルダAPI |
| `balloon-smoke.mjs` | 吹き出し、透過、順序、単体・編集済み保存、書体待ち・失敗、PNG一致 |
| `caption-smoke.mjs` | キャプション、自動追従と手動サイズ、揃え方、クリップ、コピー、互換性 |
| `typography-smoke.mjs` | 添付TTFの一致、句読点の実位置、装飾なし、先細りの描画と復元 |
| `export-smoke.mjs` | 対象別TXT、ページ順、連番、保存先、順序の復元、モバイル配置（ADR-0007で追加） |

フォルダ保存・元画像削除は模擬ハンドルで検証し、利用者の実画像を削除しない。スクリーンショットはGit管理外の `artifacts/` へ出す。同一環境で選択枠なしのプレビューとPNGを比較し、異なる端末フォント間のバイト一致は要求しない。

## 決定：ビルド・公開

`scripts/build.mjs` は配布するHTML・CSS・JSと準備済みフォントを `_site/` へコピーし、`.nojekyll` を置く。ソースの自動探索ではなく明示リストを使い、`dev/docs`、テスト、元フォント原本、開発サーバーは公開物へ含めない。新しいブラウザ用JSはビルドと開発サーバーの許可リストを両方更新する。

| 経路 | 起動条件と処理 |
|---|---|
| `.github/workflows/ci.yml` | push／pull_request。Node 22で構文と単体を検証 |
| `.github/workflows/pages.yml` | mainへのpush／手動。構文・単体、Playwright／Chromium／日本語フォールバック準備、フォント準備、5本のブラウザ検証、静的ビルド |
| Pages deploy | build成功後、`_site/` のartifactを `github-pages` 環境へ公開 |

ブラウザのスクリーンショットartifactは成功・失敗時ともアップロードし、保持期間は7日。公開ジョブだけにPages書込みとIDトークンの権限を与える。同時公開のキャンセルはしない設定。

現行workflowにはパスによる除外がないため、文書だけのmain更新でもPages処理が起動する。文書の作成自体はアプリを変更せず、`dev/docs` は配信されない。ローカルのブラウザ実行にはブラウザバイナリとOS依存も必要で、npmパッケージだけでは揃わない。

## 代替案と比較

- 単体検証だけでは、実フォントの句読点位置やプレビューとPNGの差を捉えきれない。操作と描画をブラウザで検証する。
- すべてのpush／PRでフォント取得とブラウザ検証を実行すると待ち時間が増える。通常CIは基本検証、Pages経路は描画も確認する。
- 手動で公開ファイルをコピーすると、書体や追加モジュールの漏れが起こる。明示ビルドとPages artifactの経路を使う。

## 結果と制約

ブラウザ環境を準備できない場合は、未実行の検証を合格と報告しない。構文・単体・ビルドの成功と、実ブラウザでの確認を区別する。大画像・多数画像の網羅的な性能測定、全ブラウザへの互換保証は現行検証の範囲外。

基準コミットの [Pages実行38016273473](https://github.com/falls247/serifu-editor/actions/runs/38016273473) はbuild／deploy成功、4本のブラウザ検証も成功。主要配信コードと添付TTFの一致を確認済み。この実績を将来の変更後の検証結果として使い回さない。

## 関連コードと手順

- [package.json](../../../package.json) / [test](../../../test) / [scripts](../../../scripts)
- [server.mjs](../../../server.mjs) / [build.mjs](../../../scripts/build.mjs) / [fetch-font.mjs](../../../scripts/fetch-font.mjs)
- [ci.yml](../../../.github/workflows/ci.yml) / [pages.yml](../../../.github/workflows/pages.yml)
- [引継書](../HANDOFF.md)：ローカル導入、コマンド、編集データ移行、制約
- [ADR一覧](README.md)
