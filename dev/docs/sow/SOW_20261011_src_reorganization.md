# SOW: JavaScriptソースの `src/` 集約と文書整合性の更新

- **識別子**: SOW-20261011-SRC
- **対象**: [falls247/serifu-editor](https://github.com/falls247/serifu-editor)
- **作成日**: 2026-10-11 (JST)
- **区分**: リファクタリング／ファイル配置変更（機能追加なし）
- **調査基準**: `main` — `2988d8e1972bb040f0887e2669d08ddd4dbf6c71`（実装前に再取得）
- **ステータス**: 実装待ち。本書の作成自体は実装着手・変更承認を意味しない
- **関連資料**: [HANDOFF](../HANDOFF.md) / [ADR一覧](../adr/README.md) / [既存SOW一覧](./)
- **成果物**: `src/` 移設済みコード、参照更新、テスト結果、文書改訂、ADR-0017、変更一覧とPR

## 1. 目的・背景

現在はブラウザ用 `.js` ファイル **22件** がリポジトリ直下にあり、HTML・CSS・アセット・開発サーバーと同列に並ぶ。アプリケーションの実装を `src/` 配下に集約し、ルートの見通しと今後の保守性を改善する。

**優先事項は互換性維持。** 本件は配置変更と必要最小限の参照修正だけとし、UI仕様・操作・描画・保存内容・公開URL（サイトのベースパス）を変えない。

### 現行構成の制約（実コード確認済み）

- ブラウザはネイティブES Modules、Canvas 2D。バンドラーなし。Node.js 22の `npm start` で `server.mjs` が明示的な静的配信リストを使用。
- `index.html` が `app.js` を起点として読み込む。
- `scripts/build.mjs` が明示リストから `_site/` にコピーし、Pagesへデプロイ。
- `package.json` の `check` がJSファイルのパスを列挙。単体テストは `test/*.mjs`、ブラウザテストは `scripts/*smoke.mjs`。
- `bulk-pool.js` と `project-io.js` が `import.meta.url` 基準でWorkerを生成する。
- `image-worker.js` が `import.meta.url` 基準でフォントを探す。移動すると `./assets/fonts/` の解決先が変わる。
- `fonts.js` がインライン `<style>` 用の `url('./assets/fonts/...')` を生成する。こちらのURLは文書基準のためWorkerと修正方針が異なる。
- `scripts/bulk-smoke.mjs` が `_site/` 配下の公開ファイルを独自に許可リスト化し、`/serifu-editor/` サブパスのWorker・書体配信を検証する。

## 2. スコープ

### 2.1 移動対象（全22件、ファイル名を維持）

| 変更前 | 変更後 |
|---|---|
| `app.js` | `src/app.js` |
| `balloons.js` | `src/balloons.js` |
| `brush-stroke.js` | `src/brush-stroke.js` |
| `bulk-pool.js` | `src/bulk-pool.js` |
| `bulk-task.js` | `src/bulk-task.js` |
| `captions.js` | `src/captions.js` |
| `export-cache.js` | `src/export-cache.js` |
| `export.js` | `src/export.js` |
| `fonts.js` | `src/fonts.js` |
| `glyph-layout.js` | `src/glyph-layout.js` |
| `image-metadata.js` | `src/image-metadata.js` |
| `image-worker.js` | `src/image-worker.js` |
| `ink.js` | `src/ink.js` |
| `model.js` | `src/model.js` |
| `presets.js` | `src/presets.js` |
| `project-filenames.js` | `src/project-filenames.js` |
| `project-io.js` | `src/project-io.js` |
| `project-worker.js` | `src/project-worker.js` |
| `renderer.js` | `src/renderer.js` |
| `storage.js` | `src/storage.js` |
| `typography.js` | `src/typography.js` |
| `zip.js` | `src/zip.js` |

- `git mv` を使用して履歴追跡を容易にする。上記と実装時の `git ls-files '*.js'` を照合し、差分がある場合は新規ファイルも調査して対象を確定する。
- 移動直後は **`src/` 直下のフラット配置** とする。ディレクトリ階層の増加・責務別モジュール分割・命名変更は別SOWに分離。
- `src/` 内の相互参照（例: `./renderer.js`）は移動前と同じ相対関係を保つため、原則そのまま。別階層のアセット・WorkerへのURLは個別検査。

### 2.2 ルート等に残す対象

- `index.html`, `style.css`, `favicon-32.png`, `apple-touch-icon.png`, `assets/`: 静的公開リソース
- `server.mjs`: ローカル開発サーバー
- `scripts/*.mjs`: 構築・書体生成・回帰/ブラウザ検証
- `test/*.test.mjs`: Node単体テスト
- `package.json`, `.github/workflows/`, `README.md`, `dev/docs/`: 設定・文書
- `_site/`, `artifacts/`, `assets/fonts/`, `node_modules/`: 生成物／Git管理外（`.gitignore` を維持）

### 2.3 非対象・禁止

- 新機能、UI/UX変更、描画アルゴリズム変更、性能最適化、コード整形の一括実行、大規模ファイル分割
- Vite/Webpack等のバンドラー導入、npm本番依存追加、TypeScript化
- `PROJECT_VERSION` の更新、`IndexedDB` のDB名・ストア名・キー変更、`localStorage` のキー名変更、プリセット・一時保存・JSON/`.serifu` 形式変更
- フォントの追加・削除・原本変更・ライセンス変更
- ルート旧URL向けの空のプロキシJS/複製ファイルを作ること（別途互換要件が見つかった場合は報告・合意）
- `main` への直接実装、force push、未コミットのローカル変更の破棄

## 3. 実装仕様と必須修正箇所

| 対象 | 指示 | 重要な注意 |
|---|---|---|
| `index.html` | module entryを `./src/app.js` に変更 | Pagesの `/serifu-editor/` でも動く相対URLを使用 |
| `server.mjs` | `FONT_FILES` のimportを `./src/fonts.js` に変更。配信許可リストのJSを `src/*.js` に置換 | 明示リストによる公開範囲を維持。CSS、HTML、画像、書体のURLは現状維持 |
| `scripts/build.mjs` | JSを `_site/src/*.js` に同じ階層でコピー。HTML/CSS/favicon等と `assets/fonts/` は既存どおり | 既存のコピー対象22件が欠けないこと。旧 `_site/*.js` を出力しない |
| `package.json` | `check` 対象JSを `src/*.js` へ変更 | 全22件の構文検査を維持。serverとscriptsの `.mjs` も維持 |
| `scripts/fetch-font.mjs` | `../fonts.js` を `../src/fonts.js` に更新 | `assets/font-sources/` と出力 `assets/fonts/` は移動しない |
| `test/*.test.mjs` | ルートJS向け `../foo.js` を `../src/foo.js` に更新 | テストケース・期待値は変えない |
| `scripts/*smoke.mjs`, `scripts/bulk-benchmark.mjs` | Node側の直接import、ブラウザ `page.evaluate` / `waitForFunction` 内の `import('./foo.js')` を漏れなく修正 | ブラウザ文書からは `./src/foo.js`、Nodeのscriptsからは `../src/foo.js`。パスの基準を混同しない |
| `scripts/bulk-smoke.mjs` | サブパス配信テストの公開ファイル許可リストを `src/*.js` へ更新 | `/serifu-editor/src/` への要求、Worker生成、フォント読み込みを実通信で確認 |
| `scripts/text-position-smoke.mjs` | 文書URL基準で生成する `./image-worker.js` を `./src/image-worker.js` に修正 | 直接Workerをnewするケースなので必須 |
| `src/bulk-pool.js` | `new URL('./image-worker.js', import.meta.url)` の解決結果を確認 | Workerも同階層なのでコード変更不要な見込み。動作実測で判断 |
| `src/project-io.js` | `new URL('./project-worker.js', import.meta.url)` の解決結果を確認 | Worker失敗時の既存フォールバックも維持 |
| `src/image-worker.js` | フォントURLを `new URL('../assets/fonts/<filename>', import.meta.url)` 相当に修正 | `src/` 移動に伴う相対パスずれを必ず解消。ローカルとPagesサブパスの両方で検証 |
| `src/fonts.js` | インラインCSSの `url('./assets/fonts/...')` は文書基準で現状維持を第一候補 | `import.meta.url` 基準と誤認して `../assets/` に変えない。全書体のロードを確認 |
| `.github/workflows/ci.yml`, `pages.yml` | 既存ジョブ・コマンドのパス依存有無を確認。必要な変更のみ | Pagesはmain pushで公開。PR段階ではCI/ローカルの検証結果を提示 |

**横断探索必須**: `import`、`import()`、`new URL()`、`new Worker()`、`fetch()`、`FONT_STYLES`、`readFile`、`<script src>`、`_site/`、旧JSへの直接HTTPアクセス、およびJSパスを含むテストの文字列定数。import文字列だけの一括置換は禁止。

## 4. ドキュメント更新仕様

**実装後の事実を記載し、文書だけ先走らせない。**

| 文書 | 更新内容 |
|---|---|
| `README.md` | 開発者向けディレクトリ構成、エントリポイント、起動・ビルド・配信説明を新構成に合わせる |
| `dev/docs/HANDOFF.md` | 現行ソースの表とリンク（`../../src/*.js`）、モジュール責務、変更時の修正箇所、検証手順、Worker/フォント配信経路 |
| `dev/docs/README.md` | 本SOW・新ADR・更新済み引継書への導線。過去の基準コミット表記を現状と混同させない |
| `dev/docs/adr/README.md` | 新規 `0017` を追加し、リンク切れや一覧の体裁を修正 |
| `dev/docs/adr/0017-src-layout-and-static-assets.md`（新規） | 背景、配置判断、代替案（ルート維持／srcフラット／責務別多層）、採用理由、静的配信・Worker・フォントURLの扱い、互換性、検証、戻し方 |
| `dev/docs/adr/0001〜0016` | 現行コードへの相対リンク・「現在の構成」のパスを点検。参照例: ADRからソースは `../../../src/*.js` |
| `dev/docs/bulk-performance-report.md`, `lettering-brush-report.md`, `sow/*.md` | 現行コードへの参照リンクを点検。過去の作業計画・測定時点のパスは履歴として維持し、必要なら「現在はsrcへ移設」の注記 |

- **過去の設計判断・時点の動作記録を、当時からsrc構成だったかのように改変しない。** 記載対象が「現在の実装」なら新パス、過去のリポジトリ状態を指すなら当時のパスを保持し、必要に応じて新ADRへ誘導。
- 相対リンクの解決、古い `app.js` / `renderer.js` / `fonts.js` などの現行パス説明の取りこぼしを監査。
- `README.md` と `HANDOFF.md` に、更新後のサンプルツリーを記載。 `src/`・`test/`・`scripts/`・`assets/`・`server.mjs`・`index.html`・`style.css` の責務を区別。
- 古いSOWの過去時点の記述を書き換える場合は歴史的正確性を優先。文書への一律置換は禁止。

## 5. エージェント作業手順

1. **調査と作業分離**: 適用される `AGENTS.md` とユーザー指示を確認。`git status --short --branch`、追跡ファイル、main最新SHAを記録。作業ツリーに未保存変更がある場合、上書き・強制クリーンせず分離ワークツリー等を選択。
2. **専用feature branch**: 最新の実装元から `refactor/move-js-to-src` 相当を作成。既存ブランチと衝突時は名前を変える。docs-only SOWブランチでそのまま実装しない（必要ならSOWをcherry-pick）。
3. **変更前ベースライン**: `npm run check`、`npm test`、`npm run fonts`、`npm run build`、`npm run test:bulk`、`npm run test:browser`。実行不可なら理由を記録し、変更後の合格を推測しない。
4. **移動**: 対象 `.js` を `git mv` で `src/` に集約。非対象は移動しない。
5. **参照修正**: 本書§3に従ってアプリ起動・配信・ビルド・構文チェック・単体・ブラウザテスト・フォント生成の各参照を更新。差分は配置とパスの修正に限定。
6. **ドキュメント**: §4の全文書を監査し、必要な改訂とADR-0017を追加。コードとの突き合わせを実施。
7. **回帰テスト・配信テスト**: §6の受入条件を実測。失敗は原因と再実行結果を残す。レビュー可能なコミットへ整理。
8. **PR提出**: 変更前後のファイル対応、影響箇所、テスト結果、残課題、互換性/リスク、Pages動作確認を報告。**ユーザーの明示的な指示なしにmainへマージしない。**

## 6. 検証・受入条件（Definition of Done）

### 6.1 構成・静的配信

- [ ] 元ルートの対象22ファイル（実装時の増分を含む）が **同名・同内容を基本として** `src/` に存在し、ルート直下にアプリ用 `.js` が残らない
- [ ] `npm run check`、`npm test`、`npm run fonts`、`npm run build`、`npm run test:bulk`、`npm run test:browser` が成功（フォント・Playwright環境要件を満たした上で）
- [ ] `_site/index.html`、`_site/src/app.js` など全モジュール、`_site/style.css`、`_site/assets/fonts/` が生成され、旧 `_site/app.js` は生成されない
- [ ] `npm start` のトップページに成功し、ブラウザNetworkにコード・Worker・フォントの404/MIMEエラーがない
- [ ] `/serifu-editor/` のサブパス模擬公開でモジュール、Worker、フォントが正常（`scripts/bulk-smoke.mjs` のケースを維持）
- [ ] 許可していないパスのリクエストが開発サーバーで404（配信リストを無制限なファイルサーバーに変えない）
- [ ] 必要に応じて移動後のJS全件の静的参照整合性テストを追加。旧ルートのJSへのHTTP参照を残さない
- [ ] 文書の現行コードへのMarkdownリンクに404/存在しない相対パスがない

### 6.2 機能・保存互換性

- [ ] 画像読込、各種レイヤー（台詞・効果音・吹き出し・キャプション）、テキスト編集、ドラッグ、Undo/Redo、プリセットを回帰検証
- [ ] プレビュー、単体PNG、一括PNG、TXT、JSON、`.serifu`、フォルダ保存、キャンセル、Worker失敗時の代替経路を回帰検証
- [ ] 全書体の読み込みとWorkerでのCanvas描画成功、可能なテスト対象でプレビュー/出力の一致
- [ ] `IndexedDB` の自動/一時保存、`localStorage` のユーザープリセットが**配置変更前のブラウザデータから**復元可能。キー・バージョン・形式は不変
- [ ] 旧編集データの読み込みと保存形式に回帰なし。表示・画像処理・書体の基準結果が変更されない
- [ ] GitHub ActionsのPRチェック成功。mainへ将来マージする場合のPagesビルド/公開まで実測して完了報告（PR段階で未公開なら未確認と明記）

### 6.3 PRレビュー資料

- [ ] `git diff --find-renames --stat` と代表的な差分を示し、純粋移動と必要なパス修正を区別
- [ ] 変更前後テストコマンドと結果（pass/fail/未実施）、ブラウザテスト件数、未確認項目を明記
- [ ] 文書更新一覧とADR-0017、将来の責務別分割への提案（本件では実施しない）を添付
- [ ] 既存ブランチ・ローカル未コミット作業を保護し、不要な仕様変更が混入していない

## 7. リスク・回避策・ロールバック

| リスク | 起因 | 対策 |
|---|---|---|
| 画面がロードされない | `index.html` と明示配信リストが旧パス | HTML・開発サーバー・ビルドの3点セットを同一コミットで修正 |
| Workerが起動せず処理が低速化 | Worker URLとスクリプト配信の不整合。フォールバックが成功して不具合を隠す | Worker生成回数・成功実績・fallbackJobs等を確認。成功のみを合格としない |
| 漫画フォントが落ちる | `image-worker.js` のURL基準がsrcへ変化 | `../assets/fonts/` を採用。CSSの文書基準URLは維持 |
| GitHub Pagesでのみ失敗 | `/serifu-editor/` サブパスに絶対URLが非対応 | サブパス配信のブラウザ検証を必須化 |
| テストだけ古いURLを参照 | ブラウザ内動的importと擬似サーバー許可リスト | `scripts/*smoke.mjs` の文字列も全探索 |
| 自動保存・プリセットの消失 | 意図しないキー変更や配信オリジン変更 | 保存形式とキー、配信ベースパスを不変にし既存データで復元確認 |
| 文書内リンク切れ・歴史改変 | Markdown相対リンクと旧ADRの時点混同 | 全文書監査、現況リンクだけ新パス、過去記録は注記 |
| 実装中のローカル作業喪失 | 未コミット変更を上書き | 別ブランチ／worktreeを使い、reset/clean/forceをしない |

**ロールバック**: PRをマージせず破棄できる状態で検証する。公開後に障害が出た場合は対象リファクタリングのコミットをrevertし、従来の静的配信構成へ戻す。ブラウザ保存データのスキーマ変更は実施しないためデータ移行の逆操作は不要。

## 8. 完了報告テンプレート

```text
Base commit:
Branch / PR:
移動ファイル数 / 変更後ルートJS数:
変更したコード / 設定 / テスト / 文書:
構文チェック:
単体テスト:
フォント準備:
静的ビルド / _site内容:
ブラウザ検証 / サブパス公開:
Worker正常稼働 / フォールバック:
既存保存データ・プリセット互換性:
Markdownリンク検査:
ADR-0017:
未確認事項・残リスク:
```

## 9. エージェントへの実行指示（要約）

> 本SOWを唯一の作業範囲基準として読み、最新コードと照合したうえで専用feature branchに着手。まず回帰ベースラインを計測し、22件のルートJSを `git mv` で `src/` へ移動。HTML・開発サーバー・静的ビルド・package check・単体・ブラウザスモーク・WorkerフォントURL・フォント生成スクリプトのパスを修正。保存形式と画面仕様は一切変更しない。README・HANDOFF・ADR・その他関連資料の現行参照を更新し、新規ADR-0017を記録。ローカルと `/serifu-editor/` サブパス双方のWorker・フォント・保存互換性を実測。変更一覧と全検証結果を添えたPRまで作成し、mainへはマージしない。
