# ADR-0017: JavaScriptソースをsrcに集約し、静的配信経路を維持する

- 日付: 2026-10-11
- 状態: 採用（実装ブランチ: `refactor/move-js-to-src-20261011`）
- 関連: [SOW](../sow/SOW_20261011_src_reorganization.md)、[ADR-0001](0001-static-app-and-export.md)、[ADR-0004](0004-edit-data-and-drafts.md)、[ADR-0006](0006-test-and-delivery.md)、[ADR-0010](0010-bulk-processing-and-progress.md)

## 背景

実装用JavaScript 22件がリポジトリ直下でHTML・CSS・アセット・開発サーバー等と混在。構造を整理しつつ、静的公開・Worker・テスト・保存データの互換性を保つ必要がある。アプリはES ModulesとCanvasを使用。バンドラーなし・明示的な静的配信リストを採用している。

## 決定

1. ルート直下のアプリ用 `.js` 22件を**ファイル名を維持して `src/` 直下**へ移す。互いの `./foo.js` importはそのまま使う。
2. `index.html` は `./src/app.js` を読み込む。`server.mjs` の配信許可リストと `scripts/build.mjs` のコピーリストを `src/*.js` へ更新し、配布物を `_site/src/` に出力する。
3. Node側のテスト・スクリプトは `../src/foo.js`、ブラウザからの動的importは `./src/foo.js` に変更。GitHub Pagesの `/serifu-editor/` サブパスで実際に検証する。
4. `src/bulk-pool.js` と `src/project-io.js` の `import.meta.url` 基準のWorker間相対パスは同階層なので維持。`src/image-worker.js` 内のフォントURLは階層が増えるため `../assets/fonts/` に補正。
5. `src/fonts.js` のインラインCSSが生成する `url('./assets/fonts/...')` は**文書URL基準**なので維持。WorkerのURLと基準が違うことを明示。
6. `scripts/*.mjs`、`test/*.test.mjs`、HTML、CSS、フォント、生成物の配置は変更しない。`package.json` の構文チェック対象は移動先に更新。
7. UI・描画・IndexedDBストア/キー・localStorageキー・編集JSON/`.serifu` 形式・PROJECT_VERSION・公開サイトのベースURLを変更しない。

## 変更後の構成

```text
src/
  app.js, renderer.js, model.js, storage.js, presets.js, fonts.js
  balloons.js, captions.js, ink.js, glyph-layout.js, brush-stroke.js, typography.js
  bulk-task.js, bulk-pool.js, image-worker.js, image-metadata.js
  project-io.js, project-worker.js, project-filenames.js
  export.js, export-cache.js, zip.js
index.html / style.css / server.mjs / package.json
scripts/ / test/ / assets/ / dev/docs/
```

## 代替案

| 案 | 利点 | 欠点 | 結論 |
|---|---|---|---|
| A. 直下に維持 | 既存パスを保てる | ルート混在が継続 | 不採用 |
| B. `src/` フラット | 移設と参照変更が限定的、Git追跡も明瞭 | 責務別階層化は未実施 | **採用** |
| C. `src/ui`・`src/core` 等の多層化 | 機能ごとに整理可能 | 多数のimport/Worker URL変更と検証が必要 | 別SOWへ |
| D. Vite等の導入 | アセット処理の自動化 | 配布・依存と開発構成の変更が大きい | 本件では不採用 |

## 帰結とリスク

静的ホスティングを維持しつつルートを整理。旧コード位置を直接指定するURL（例: `/app.js`）は提供しないが、ユーザーがアクセスする `/serifu-editor/` は変更しない。オリジン・保存キーを維持し、ユーザープリセットと一時保存は移行不要の設計。Worker失敗時はフォールバックにより外見上成功する可能性があるためWorker自身の成功を監査する。

## 検証と関連実装

- [エントリHTML](../../../index.html)、[開発サーバー](../../../server.mjs)、[静的ビルド](../../../scripts/build.mjs)、[package scripts](../../../package.json)
- [アプリ](../../../src/app.js)、[画像Worker](../../../src/image-worker.js)、[フォント定義](../../../src/fonts.js)
- [一括検証・Pagesサブパス](../../../scripts/bulk-smoke.mjs)、[ブラウザ検証](../../../scripts/browser-smoke.mjs)、[単体検証](../../../test/renderer.test.mjs)
- 受入: `npm run check`・`npm test`・`npm run fonts`・`npm run build`・`npm run test:bulk`・`npm run test:browser`。既存ブラウザプロファイルの保存データ復元はCIからは直接証明できない。
- 履歴の過去時点のパスと検証結果は改変せず、現行ソースへの文書リンクだけを更新。

## ロールバック

関連する配置変更コミットをrevertし、HTML・配信リスト・テスト参照を元に戻す。永続データのスキーマ変更はないためデータ変換は不要。
