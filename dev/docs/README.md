# 開発ドキュメント

ローカルリポジトリで作業を継続するエージェント向けの入口。

**アプリ改修時は[操作説明書の更新ルール](documentation-maintenance.md)を確認し、利用者向けの変更を同じ変更内で`docs/index.html`へ反映する。READMEは起動に必要な情報に絞る。**

2026-10-16：吹き出しの多角形モード・3〜60頂点の指定とランダム生成は [ADR-0029](adr/0029-polygon-balloons.md) を参照。保存版は15、ブラウザ検証は `npm run test:polygon-browser`。

2026-10-16：画像別JSON下書きの自動取り込み・配置は [ADR-0028](adr/0028-annotation-draft-import.md) を参照。対応する外部ファイル名は `画像のファイル名.jpg.json`。検証は `npm run test:annotation-drafts`。

| 文書 | 用途 |
|---|---|
| [SAM3再読み込みのSOW](SOW_20261018_sam3_reload_lifecycle.md) | 取消後の再解放防止・画像間の共有監視・ロード計測の実装。CPU待機は未採用 |
| [JSのsrc移行SOW](sow/SOW_20261011_src_reorganization.md) | 22件の移動・パス整合性・Worker/書体・互換性の受入条件 |
| [引継書](HANDOFF.md) | 現在地、ローカル起動、コード構成、変更時の確認先、検証、編集データの移行 |
| [一括処理の実装後報告](bulk-performance-report.md) | Worker・進捗・高速形式の検証と性能比較 |
| [編集操作の応答性改善](editor-interaction-performance.md) | プリセット変更・画像選択・サイズ変化の調査、修正と性能比較 |
| [文字配置・ブラシ輪郭の実装報告](lettering-brush-report.md) | アルゴリズム、推奨値、互換性、比較画像、検証結果 |
| [ADR一覧](adr/README.md) | 採用済みの設計と、その理由・制約 |
| [起動用README](../../README.md) | アプリ概要、公開版、ローカル起動・SAM3起動 |
| [操作説明書（HTML）](../../docs/index.html) | 利用者向けの操作手順・保存・復元・ショートカット |
| [操作説明書の更新ルール](documentation-maintenance.md) | アプリ改修と同時に説明書を更新する運用・確認方法 |
| [操作説明書の更新漏れ調査](manual-maintenance-audit.md) | SAM3 FOCUSの記載漏れの根拠、Enter入力対応、再発防止と検証 |

記録日：2026-10-10（日本時間）。実装の基準コミットは `b721ad78a7c658f23b83a0da1f6ed13c950c9696`。

引継書は現行コードの説明、ADR-0001〜0006は既存実装の事後記録。2026-10-10の本文出力・ページ順・一括保存先はADR-0007、表示件数・サムネイル・キャプション輪郭・DeleteはADR-0008、全4種類の名前付きプリセットはADR-0009へ記録した。一括処理のWorker化・容量制限・進捗・高速編集データ形式はADR-0010へ記録した。次の作業では実際のコード、適用される `AGENTS.md`、最新のユーザー指示を確認する。仕様や保存形式を変えた場合は、関連する文書と互換性の検証も更新する。

2026-10-11：ブラウザ用JavaScriptを `src/` に集約。経緯は [ADR-0017](adr/0017-src-layout-and-static-assets.md)、現在の参照関係は [引継書](HANDOFF.md) を参照。過去の基準コミットはその記録時点のもの。

2026-10-11 SAM3追加：[実装SOW](sow/SOW_20261011_sam3_segmentation.md)、[ADR-0023](adr/0023-sam3-mask-effects-and-storage.md)、[GPU・総合検証記録](sam3-gpu-validation.md)。マスク初期対応は版12。マスクと文字の共通順序、短縮カード、版13への更新は[ADR-0024](adr/0024-shared-mask-and-text-order.md)。
