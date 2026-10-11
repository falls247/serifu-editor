# SOW — SAM3セグメンテーションと非破壊マスク画像加工

| 項目 | 値 |
|---|---|
| 文書ID | `SOW_20261011_sam3_segmentation` |
| 作成日 | 2026-10-11 |
| 対象リポジトリ | [falls247/serifu-editor](https://github.com/falls247/serifu-editor) |
| 調査基準 | `main` / `a4f6f6b238339080a636b5ac9856d61289834ef5`（2026-10-11確認） |
| 文書予定配置 | `dev/docs/sow/SOW_20261011_sam3_segmentation.md` |
| 状態 | **実装指示書／インタビュー全27問確定**。実装・実機検証は未実施 |
| 対象環境 | Windowsブラウザ＋WSL2 Ubuntu、CUDA対応GPU、Node.js、Python 3.12＋uv |
| 実装ブランチ | `feat/sam3-segmentation-20261011`（作業開始時に最新`main`から作成） |

> **開発エージェントへの指示**：この文書を機能要求の一次仕様とする。最初に最新`main`を取得し、基準SHA以降の変更を確認する。既存のデータ、保存形式、ページング、文字描画、GitHub Pages公開を破壊しない。専用featureブランチで小さくコミットし、各Phaseの品質ゲートを通過させる。GPU実機未検証を「完了」にしない。`main`へ直接push・mergeしない。

## 0. ゴール・非ゴール・完了の定義

### 0.1 ゴール

1. 各ページの`ORIGINAL`画像下にSAM3カードを追加。テキストプロンプト、または元画像をクリックして前景／背景ポイントを入力し、SAM3で画像をセグメンテーション。
2. 複数の検出候補を色付き半透明マスクと輪郭で表示し、ユーザーが候補を個別選択・確認。`LIVE PREVIEW`に未確定の加工結果を表示。
3. ユーザーのOK操作で、選択した各候補を独立した「画像加工オブジェクト」に確定。ピクセレート／ぼかし／黒塗り／白塗りを非破壊で適用。
4. 確定後も位置・8方向リサイズ・マスク輪郭収縮／膨張・加工パラメータ・表示／削除を編集。再推論なしで加工変更可能。
5. マスクおよび効果を`.serifu`・JSON・一時保存に保存。再起動後もSAM3なしで復元・編集・PNG保存可能。
6. WSL2上のPython/FastAPIと既存Nodeサーバーを`npm run dev`で一括起動。GPUのアイドル解放、推論キャンセル・キャッシュ・エラー復旧を実装。
7. モックCI＋ローカルGPU実機テストを含め、既存編集機能への回帰なしでPR提出。

### 0.2 非ゴール（27問の確定判断）

- GitHub Pages単独でのSAM3推論、クラウド／LAN／Tailscaleへの推論API公開。
- マスク確定後のSAM3再推論・前景／背景ポイント再編集（必要なら新規検出）。
- 元画像以外のセリフ・吹き出し・キャプション・効果音に対するマスク加工。
- 加工オブジェクトの任意並べ替え、累積再加工、効果の透明度・フェザー・色変更。
- 高解像度画像のタイル分割推論、推論解像度のUI可変化、CPU推論フォールバック。
- ユーザー認証、GPU依存CI、SAM3重みの自動ダウンロード。
- マスクLRUキャッシュ・遅延デコード（編集中はデコード済みデータを保持）。
- 動画セグメンテーション、全ページ一括推論、既存の文字専用「一括コピー／ペースト」機能へのマスク混入。

### 0.3 完了判定

- **コード完成**：すべての必須受入試験が通り、モックE2E・保存互換・PNGピクセル一致が確認できた状態。
- **実機完成**：ユーザー指定の`sam3.pt`と対応ライブラリでテキスト・クリック・追加／除外・GPU解放／再ロード・OOM再試行を検証した状態。
- 実モデル、GPU、ユーザー固有checkpointが利用不可なら「コード完成／実機未検証」と報告し、正式完了にしない。実装が失敗する技術的ブロッカーはログと代替手順を記録してエスカレーション。

## 1. インタビュー結果：27問の決定記録（変更禁止）

| # | 確定選択 | 要求 |
|---|---|---|
| 01 | A | WSL2ローカルWebアプリ＋SAM3 Python推論サーバー |
| 02 | A | 複数候補すべて検出、個別選択し、個別オブジェクトで確定 |
| 03 | A | マスクの収縮／膨張（px）＋8方向自由変形・移動 |
| 04 | A | 加工対象は元画像のみ。文字系オブジェクトは常に前面 |
| 05 | A | マスクを編集データ（`.serifu`・JSON・一時保存）に保持し完全復元 |
| 06 | A | 前景／背景複数ポイント指定。テキスト検出候補もポイントで修正 |
| 07 | A | クリック入力は`ORIGINAL`のみ。`LIVE PREVIEW`は確認と確定オブジェクト編集 |
| 08 | A | 確定マスク編集カードは中央カラムに統合 |
| 09 | B | 確定後のSAM3再編集なし。新規検出でやり直す |
| 10 | A | ピクセレート初期20px、ぼかし半径初期12px、黒#000000、白#FFFFFF |
| 11 | A | 推論対象はクロップ・回転前の元画像全体、座標も元画像基準 |
| 12 | A | 最新入力優先非同期、古い結果無効化、キャンセル・再試行 |
| 13 | B | 起動時モデルロード、推論終了後10分のアイドルでVRAM解放、次回ロード |
| 14 | A | 信頼度しきい値0.50、0.00〜1.00を0.05刻み、候補選択UI |
| 15 | A | SAM3公式標準1008×1008推論、元解像度マスクへ復元 |
| 16 | A | 選択した候補を共通加工設定で一括確定後、個別編集 |
| 17 | A | 候補別の色＋35%半透明塗り＋輪郭線＋番号、表示ON/OFF |
| 18 | A | `npm run dev`でNode(5173)＋FastAPI(8765)一括起動、同一オリジンAPI |
| 19 | A | 元画像を初回1回転送し画像IDでキャッシュ、RAM TTL10分、容量上限 |
| 20 | A | CUDA OOMキャッシュ解放＆1回再試行、接続・timeout・モデルエラー復旧 |
| 21 | A | モック自動テスト＋GPU実機統合テスト、CIはGPU不要 |
| 22 | B | マスクを外接矩形内でロスレス圧縮保存、編集中はメモリ展開、LRUなし |
| 23 | A | 127.0.0.1限定、Origin・ファイル・寸法・値検証、認証なし |
| 24 | A | `backend/pyproject.toml`＋`uv.lock`＋`backend/.venv`、モデル自動DLなし |
| 25 | A | OK前から`LIVE PREVIEW`に仮加工を表示、キャンセルで破棄 |
| 26 | A | 追加順で後の加工を優先。常に元画像画素から各効果を生成 |
| 27 | A | Phase分割＋ゲート、featureブランチ、テスト後PR、GPU未検証は未完了 |

## 2. 現行コードの調査結果と影響範囲

2026-10-11時点の`main`における実体を確認。設計上の推測と区別する。

| ファイル／現行シンボル | 現状 | 必要な対応 |
|---|---|---|
| `index.html`：`#pageTemplate`, `.original-pane`, `.dialogue-pane`, `.preview-pane` | 各ページ3カラム。ORIGINALに`img.original`、LIVE PREVIEWに`canvas.preview` | `.original-pane`下部にSAM3カード、元画像上に選択ポイント・候補用Canvas overlay、中央にマスクカード |
| `src/app.js`：`createPage`, `mountPage`, `drawPage`, `connectCanvas` | ページ状態、カード生成、座標・Pointer操作 | maskEffects・候補ドラフトの状態／イベント／選択・描画を追加 |
| `src/model.js`：`PROJECT_VERSION=10`、`hasEdits`, `checkpoint`, `restore` | `layers`、`imageEdit`中心。UndoはJSONスナップショット最大100回 | 新しいマスク効果メタデータを編集状態・履歴へ追加。巨大なマスクの履歴複製回避 |
| `src/renderer.js`：`draw()` | 元画像 → `paintOrder(layers)` → 選択枠。Canvas変換は`imageMatrix` | 元画像 → maskEffects → 既存`layers`。通常／Worker／原寸／仮プレビューを一本化 |
| `src/image-edit.js`：`imagePoint`, `imageMatrix`, `imageSize` | 元座標からクロップ・90°回転と逆変換に対応 | ORIGINAL上は素の元画像座標、LIVE PREVIEW上は既存変換を継承 |
| `src/image-worker.js` | `draw()`でPNG作成、元画像Blobと画像編集情報を渡す | マスクのデータ転送・加工を追加、main threadとピクセル結果一致 |
| `src/project-io.js` | `.serifu`コンテナv1、ページ用原画像Blob。manifest上限16MiB。JSONはData URL元画像 | `.serifu`コンテナ拡張、別アセット化、JSON内Base64、旧版読込 |
| `src/project-worker.js`, `src/storage.js` | JSON処理Worker／一時保存（IndexedDB） | バイナリマスクBlobの格納と復元、制限値と整合性検証 |
| `src/preview-modal.js` | 100%原寸表示は既存`draw()`利用 | マスク処理を反映、選択枠・ドラフトUIは出さない |
| `src/export.js`, `src/bulk-pool.js`, `src/export-cache.js` | PNG書き出し、並列画像処理、キャッシュ | マスク含む書き出し、変更時キャッシュ失効、負荷制御 |
| `server.mjs` | 127.0.0.1:5173で静的ファイルをallowlist配信 | `/api/sam3/*`のみ127.0.0.1:8765へプロキシ、転送制限とOrigin確認 |
| `scripts/build.mjs`, `.github/workflows/pages.yml` | GitHub Pages静的配布 | 新規ES module配信に追従。Python/APIは静的出力へ含めない |
| `package.json`, `.github/workflows/ci.yml` | Nodeテスト・構文チェック・ブラウザE2E | Pythonテスト・APIモック・E2E・構文チェック追加 |
| `dev/docs/adr/0017-src-layout-and-static-assets.md` | JavaScriptを`src/`集約 | `src/`構成を維持し、バンドラ導入・大規模再編成は行わない |
| `dev/docs/adr/0019-multi-selection-and-image-edits.md` | 元画像を保持するクロップ・回転・座標管理 | maskEffectsも元座標・非破壊、同一Undo意図を維持 |
| `dev/docs/adr/0020-full-size-preview-and-numeric-ui.md` | 原寸モーダル、表示精度 | マスクも原寸1px=CSS1pxで再現 |

**重要な設計判断：既存`page.layers`へ`kind='mask'`を無理に流用しない。** 現行の`normalizeLayer`、`paintOrder`、文字入力・装飾・クローニングの多くが「レイヤーには文字がある」前提。事故を避け、`page.maskEffects`（加工オブジェクト）と`page.maskAssets`（非破壊の元マスク）を分離。UIでは中央の既存カード一覧に統合し、描画・保存は専用の分岐を追加する。既存の文字一括コピーは文字専用のまま維持。

**調査基準との差分**：実装時に`main`に更新があれば、上記のファイル・関数名・APIを新HEADに合わせる。差分の無言上書き禁止。

## 3. UX／画面仕様

### 3.1 画面配置

```text
┌──────────────────────┬──────────────────────┬──────────────────────┐
│ ORIGINAL             │ 編集カード             │ LIVE PREVIEW         │
│ [元画像]             │ [マスク加工 #1]        │ [加工仮プレビュー]    │
│  └ Canvas overlay    │  効果/強度/輪郭/表示    │ [確定マスクを操作]    │
│ [従来の元画像操作]    │ [マスク加工 #2]        │                      │
│ [SAM3 カード]        │ [既存のセリフ等カード] │ [従来の編集コントロール]│
│ プロンプト / 検出     │                      │                      │
│ モード:候補/追加/除外│                      │                      │
│ 信頼度:0.50          │                      │                      │
│ 候補一覧/全選択       │                      │                      │
│ 効果:ピクセレート20px│                      │                      │
│ [OK] [キャンセル]    │                      │                      │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

- SAM3カードは各ページのORIGINAL下へ追加。未接続時は状態・原因・再接続ボタンを表示。編集済みマスクカードは削除・変更できる。
- ORIGINALは`img.original`の上に同サイズ・同CSS変換の透明Canvas（またはpointer overlay）を置く。単純な`offsetX/Y`依存を避け、`getBoundingClientRect()`と画像の`naturalWidth/Height`からx/yを正規化。`object-fit: contain`、余白、スクロール、DPR、リサイズを検証。
- **ORIGINALへのポイント入力はSAM3の「候補選択／前景／背景」モードが有効なときだけ**。通常時の元画像操作を奪わない。前景は緑、背景は赤、各ポイントに削除・全消去手段を用意。
- 検出候補は番号・色・輪郭、選択中のみ塗り35%、未選択は輪郭のみ。hover強調、表示切替、一覧にスコア・チェックボックス・全選択／全解除を付ける。
- 候補色は固定パレットを循環し、色の違いだけに依存せず番号も表示。候補の並び順はスコア降順（同点は検出順）。
- テキストプロンプト（trim済み、空文字禁止）→検出ボタンで推論。クリックモードでは最初の前景ポイントを指定後に推論。背景のみでは推論開始不可。
- テキスト検出候補の**ポイント修正は「選択した1候補」を対象**とする。未選択複数候補の全件同時修正は行わない。元マスクを残して暫定プレビューへ差し替え可能だが、OK前まで確定しない。候補の識別はIDで維持。
- LIVE PREVIEWは確定済みマスクと未確定の選択候補への加工を同時描画。ドラフト加工は他の確定済み加工の「後」に配置（視覚確認用）。文字系はその上に描く。ドラフト中の元マスク編集（移動／リサイズ）は不可。
- OKは「最新の入力に対応した推論結果が存在」「少なくとも1候補選択」「有効なマスク」のときだけ許可。確定済み候補は個々に`maskEffect`を作り、一括Undo単位。
- キャンセル・画像切替・画像削除・別プロジェクト読込時に暫定ポイント・候補・仮加工を廃棄。古い結果はUIを上書きしない。
- 確定後は中央カードに方式、ブロックサイズ／ぼかし半径、輪郭補正px、表示ON/OFF、削除、加工対象名／番号を表示。LIVE PREVIEWで1件選択、移動、8ハンドルでリサイズ。X/Y/W/H数値編集も提供。オブジェクト選択中だけ範囲枠を表示し、PNGには含めない。
- クロップドラフトとマスクドラッグの同時操作は不可。既存`Ctrl/⌘`、`Shift`、キー操作を壊さない。Delete、矢印移動、Undo/Redoをマスクにも対応。文字専用のクリップボード操作は維持し、マスクをコピーしないことをUI説明に明記。

### 3.2 エフェクトパラメータ

| 種類 | コード値 | 初期 | 編集範囲（実装定数） | アルゴリズム |
|---|---|---|---|---|
| ピクセレート | `pixelate` | 20px | 整数1〜200px | 元画像ピクセル座標の(0,0)起点グリッド。各タイルを平均色→拡大（最近傍）。境界はマスクで切る |
| ぼかし | `blur` | 12px | 整数0〜100px | 元画像を対象範囲＋半径の余白からぼかし、マスク内のみ適用。0は無変化 |
| 黒塗り | `fill-black` | #000000 | 固定色、α=1 | マスク内の元画像を不透明な黒で置換 |
| 白塗り | `fill-white` | #FFFFFF | 固定色、α=1 | マスク内の元画像を不透明な白で置換 |
| 輪郭補正 | `marginPx` | 0px | 整数-100〜+100px（実装定数） | マスクへの収縮／膨張。エフェクトより先に適用 |

- 推論／加工座標は常に元画像pixel。表示上のズームやクロップで20pxの意味は変化しない。
- 操作順：元マスク → 外接矩形内の変形（元画像座標） → `marginPx`収縮／膨張 → 該当画素に加工。パラメータ0は加工の無効化ではない（ぼかし半径0の場合のみ無変化）。
- 変形は元マスク外接矩形を基準とした平行移動＋非等方スケール。回転ハンドルは必須でない（8方向リサイズのみ）。新しい範囲は元画像内へクリップ。マスク変形時は最近傍サンプリングで二値を保つ。
- 収縮／膨張の演算は**ユークリッド距離ベース**を推奨（距離変換などで輪郭から指定px）。処理は元マスクを上書きせず、その都度再生成。0pxは厳密に元マスク。穴・分離成分も維持。境界クリッピングあり。
- 高速実装できない場合、2-pass distance transform等の同等の決定的アルゴリズムを採用。大きな半径で単純な`O(r²·pixels)`の反復探索を行わない。
- 黒塗り／白塗りは非透明。ブラーは見た目の加工であり、情報隠蔽の完全性を保証しない。ピクセレートも匿名化の保証をしない旨をUI／READMEに明記。

### 3.3 重複の描画仕様（必須・要ピクセルテスト）

1. 各`maskEffect`の加工画素は**常に元画像の同一座標の画素**から計算する。先の加工結果を入力に再加工しない。
2. マスク効果を追加順（`createdOrder`、単調増加）で元画像へ不透明度100%のクリップ合成。重複部は後のマスク効果だけが優先。
3. 文字系の`page.layers`を最後に通常順序で描画。画像加工は文字や吹き出しに影響しない。
4. 未確定ドラフトは確定済み全加工の後、文字系の前に仮合成。
5. 非表示マスクは描画しない。変更がない場合、複数回描画しても結果が劣化しない。

## 4. フロントエンドのデータ設計

### 4.1 ページモデル（仕様案）

```ts
type Page = {
  // 従来どおり
  id: string; src: string; layers: ExistingTextLayer[]; imageEdit: ImageEdit | null;
  // 新規
  maskEffects: MaskEffect[];
  maskAssets: Record<string, MaskAsset>;  // 保存には参照単位で別asset化
  selectedMaskId: string | null;
  sam3Draft: Sam3Draft | null;             // 一時状態。保存・Undo対象外
};

type MaskEffect = {
  id: string; kind: 'mask-effect'; assetId: string;
  name: string; createdOrder: number; visible: boolean;
  effect: 'pixelate'|'blur'|'fill-black'|'fill-white';
  blockSize: number; blurRadius: number; marginPx: number;
  x: number; y: number; w: number; h: number;  // 元画像座標の変換先bbox（左上・幅高）
};

type MaskAsset = {
  id: string; imageWidth: number; imageHeight: number;
  bbox: {x:number;y:number;width:number;height:number};  // 元画像内
  codec: 'rle32le-v1'|'bitpack-lsb-v1';
  byteLength: number; sha256: string;            // integrity用
  data: Uint8Array;                             // 内部runtimeのデコード済み保持は別Mapでも可
};

type Sam3Draft = {
  imageId: string|null; requestSeq: number;
  mode: 'candidate'|'include'|'exclude';
  prompt: string; threshold: number;
  points: Array<{x:number;y:number;positive:boolean}>;
  candidates: Array<{id:string;score:number;selected:boolean;mask:MaskAsset}>;
  status: 'idle'|'uploading'|'loading'|'queued'|'running'|'ready'|'failed'|'cancelled';
  effect: MaskEffect['effect']; blockSize:number; blurRadius:number;
  displayCandidates: boolean;
};
```

- `MaskEffect.x/y/w/h`はマスクアセットの基準bboxからの平行移動・変形先。初期値はアセットbbox。初期化時・読込時に値の有限性、整数範囲、ID一意性、画像内最大サイズを検証。
- `selectedMaskId`と既存`selectedId/selectedIds`は互いに排他的。全選択解除、Undo後の存在検証、ページ切替、削除を処理。
- `createdOrder`は各ページで単調増加。Undo→再追加で同値ならIDを第二キーとして安定化。UIの並び替えはしない。
- マスク素材はeffectと独立、Undo履歴は巨大なbit列を直接複製しない。historyには`maskEffects`メタデータ・参照IDのみ保存し、素材を`maskAssets`に保持。
- Undoで削除した素材はRedoのため一定期間保持。履歴100件から参照されず、現行maskEffectsにも存在しない素材のみGC。Undo/Redoでは参照対象を欠落させない。
- 原画像Blobの複製機能は現行ルール維持（編集内容を複製しない）。画像削除／全ページリセット時、参照素材・候補ドラフトを解放。
- `hasEdits`は`page.layers.length>0 || !!page.imageEdit || page.maskEffects.length>0`。マスクの表示OFFもオブジェクトが残る限り編集済み扱い。効果更新後は`page.done=false`。
- プロジェクトデータの`PROJECT_VERSION`は**11**へ更新。旧1〜10を読み込み、maskEffectsのデフォルトは空。未来版は従来どおり拒否。

### 4.2 マスク符号化（Python/JavaScript共通）

- 予測器出力は元画像サイズの**二値マスク**（0/1）。SAM3マスクが`H×W`で返ることを検証し、閾値で二値化。
- bboxは1画素でも立っている全領域を包含する**半開区間**`[x, x+w) × [y, y+h)`。空マスク候補は破棄する。bbox=元画像内の整数値。
- bbox内を**行優先（row-major、x方向が先）**で展開。1bitは対象、0bitは背景。
- `bitpack-lsb-v1`：`n=w*h`ビットをLsb-firstで格納。画素`i`は`data[i>>3] >> (i&7) & 1`。使用しない末尾bitはゼロ。長さ`ceil(n/8)`。
- `rle32le-v1`：0のランから開始し、交互に0ラン／1ランを**uint32 little-endian**で格納。最初が1なら先頭0ランを明示。ラン長の合計が厳密に`n`でなければ拒否。ゼロ長は先頭のみ許す。上限`n`、オーバーフロー拒否。
- Python側で両方式のバイト数を比較し、**短いほうを保存**（同値ならbitpack）。従ってマスクはロスレスで、RLEが不利な画像でもbitpackへフォールバック。デコードは画素数上限を先に検証してから行う。
- SHA-256は圧縮payloadバイト列に対するhex。保存前・読込後検証（既知のchecksumがない旧版は対象外）。キャッシュやUndoで同一アセットを重複保存しない。
- runtimeはbbox内の二値`Uint8Array`（0/1）を原則保持。1画像の表示領域全体をマスクごとに必ず確保しない。メモリ使用量表示・解放テストで確認。
- マスク圧縮処理を`src/mask-codec.js`、Python対称処理を`backend/app/mask_codec.py`に置く。JS/Python共通fixtureで1bit単位の一致を試験する。

## 5. SAM3バックエンド仕様

### 5.1 実行と依存関係

- バックエンドは`backend/`、`uv`管理・Python 3.12専用`.venv`。`pyproject.toml`＋lockをコミットし、`.venv`をignore。
- `sam3.pt`の初期パスは`~/dev/models/vision/sam3.pt`（Python側`Path.expanduser()`）。`SAM3_MODEL_PATH`で上書き。**モデル重みをGitへ追加しない／自動ダウンロードしない**。
- SAM3 upstreamはコミットハッシュで固定し、ライセンス・必要なcheckpoint形式・トークナイザ素材を確認。PyTorchとtorchvisionはCUDA互換性の組合せでpin。セットアップスクリプトで`torch.cuda.is_available()`、GPU名、CUDA runtime、checkpoint存在、ディスク容量を検証。
- SAM3公式の2026-10時点の推奨条件はPython>=3.12、PyTorch>=2.7、CUDA>=12.6。`build_sam3_image_model(checkpoint_path=...,load_from_HF=False,enable_inst_interactivity=True)`を起点に検証。**SAM3.1専用checkpoint／APIを誤用しない**。
- テキスト検出：`sam3.model.sam3_image_processor.Sam3Processor`の`set_image` → `set_text_prompt`。出力`masks/boxes/scores`を利用。
- ポイント指定：公式`SAM3InteractiveImagePredictor`（モデル内の`inst_interactive_predictor`）に`set_image` → `predict(point_coords, point_labels, multimask_output=...)`を用いる。正=1、負=0。`Sam3Processor`単独に存在しないポイントAPIを捏造しない。
- テキスト候補のポイント修正：候補IDを固定し、その候補内部に前景点を自動補完するか候補へのユーザー前景点を必須にする。**元のテキスト候補マスクを別予測器で完全再現できる保証はない**。`predict`の出力から実際にユーザーがクリックした対象を選び、元候補を暫定差し替え。実機テストで一致が悪ければ候補への前景点必須とし、その制限をUI明記。候補群全件のマスクを自動的に変更しない。
- 同一画像に対して予測器の中間埋め込みをキャッシュできるかは使用するupstream commitの振る舞いで確認。テキスト予測器とインタラクティブ予測器の特徴量は**互換だと仮定しない**。
- GPU推論は`torch.inference_mode()`、model.eval()。同時実行は1件。`Sam3Processor.confidence_threshold`はmutableなのでリクエストを直列化し、別要求による競合を防ぐ。外部へ状態テンソルを返さない。

### 5.2 API（契約）

プレフィックスはブラウザ側`/api/sam3`、FastAPI側も同名でよい。エラーは共通`{error:{code,message,retryable,requestId}}`。

| Method | Path | 要求 | 応答／用途 |
|---|---|---|---|
| GET | `/api/sam3/health` | なし | `{status:'ready'|'loading'|'unloaded'|'error',modelLoaded,gpuAvailable,version}`。GPU未ロードでも接続状態は健全と判定可能 |
| POST | `/api/sam3/images` | multipart、元画像1ファイル | `{imageId,width,height,expiresAt}`。SHA-256で重複排除可 |
| POST | `/api/sam3/infer` | `{imageId,requestId,mode:'text'|'points'|'refine',prompt?,threshold?,points?,candidateId?}` | `{jobId,status:'queued'|'running'}`。最新入力を優先 |
| GET | `/api/sam3/jobs/{jobId}` | なし | `{jobId,status,requestId,candidates?,error?}`。readyなら複数候補＋mask payload |
| DELETE | `/api/sam3/jobs/{jobId}` | なし | `{cancelled:true}`。実GPU推論停止までは保証しない |
| DELETE | `/api/sam3/images/{imageId}` | なし | `{deleted:true}`。ページ破棄時の明示削除（TTLでも削除） |

入出力の必須フィールドと例：

```json
{
  "imageId": "2a774ec1-b27b-4f82-a1e0-d7af021e08f3",
  "requestId": "page123:17",
  "mode": "text",
  "prompt": "face",
  "threshold": 0.50,
  "points": []
}
```

```json
{
  "jobId": "67972d3d-2495-4edf-bb62-6fb116451795",
  "status": "ready",
  "requestId": "page123:17",
  "candidates": [{
    "candidateId": "c1",
    "score": 0.94,
    "bbox": {"x": 14, "y": 30, "width": 54, "height": 80},
    "mask": {"codec": "bitpack-lsb-v1", "byteLength": 540, "dataBase64": "...", "sha256": "<64-hex>"}
  }]
}
```

- `threshold` 0.00〜1.00。現行公式`Sam3Processor`のデフォルトは0.5。しきい値のUI変更時は**現在の画像・プロンプトで再問い合わせ**（250ms程度debounce）。候補のすべてを低しきい値で常時保持する必要はない。
- `mode='points'`は1点以上の前景点が必須。`mode='refine'`は`candidateId`とクリック点を受け、選択中の1候補に適用する。APIではプレビュー用の候補IDとマスクを紐付け、元の候補は旧スナップショットとして保持。
- 新規`infer`は即時`jobId`返却。UIはpoll（例：500ms間隔、急増防止）、最終状態取得後poll終了。SSEは今回必須でない。HTTP 202/200の使い分けをテストで固定。
- `GET /jobs`のready返却後は同じ結果を短期保持し、複数pollで同じマスクを繰り返し転送しないよう条件付き取得または結果取得後poll停止。候補データはローカルのみ。
- コンテンツ長・JSON/ファイルの実サイズ検証。初期運用ガード例：最大アップロード30MiB、最大画像40Mpx、画像1枚最大幅・高さ30000px、プロンプト最大500字、ポイント最大128点／要求、RAMキャッシュ512MiB。**これらはセキュリティ実装の初期値案**であり、GPU実機で性能を測定した後、環境変数で調整可能にする。閾値0.00では候補が多くなり得るためレスポンス総量上限も設け、候補省略時は明示的な警告を表示。
- 画像デコードはPillowで安全に行い、拡張子を信用しない。EXIF orientation、アルファ、色空間は正規化後の**元画像表示ピクセル**との整合を検証する。元データを勝手にcropしない。ページが保持する`img.width/height`とサーバー認識サイズが違えば推論しない。

### 5.3 GPUモデル・画像キャッシュ・ジョブキュー

**起動**：`npm run dev`がNodeとFastAPIを起動、サーバー準備完了を待ってヘルスチェック。モデルは起動後の初期化で読み込み、フロント表示は非ブロッキング。モデルロード失敗時は`health.status='error'`で理由を返す。モデル再ロード時は`loading`。

**アイドル解放**：最後の**推論終了時刻**から600秒間、新たな推論要求がなければ、実行中ジョブがゼロであることを確認してモデル・予測器・GPUテンソル／特徴量参照を解放。`torch.cuda.empty_cache()`だけで終了扱いしない。次回ジョブ時に1回だけモデルロードし、他ジョブはそのロードの完了待ち。CPU上の元画像キャッシュは別のTTLまで残してよい。`torch.cuda.memory_allocated/reserved`と`nvidia-smi`でVRAM変化を記録。

**画像キャッシュ**：初回画像送信→UUID画像ID。PIL/RGB画像をRAM上で保持。最終アクセスから600秒で自動消去、合計容量上限512MiB（暫定）を超える場合は最終アクセスが古い画像から削除。画像IDを推測不能なUUIDにし、ポートを外部公開しない。画像失効時はAPI `IMAGE_EXPIRED` / HTTP 410を返し、フロントが一度だけ再アップロードして同じ最新版推論を再要求。旧画像IDは失効。GPU featuresをRAMキャッシュとみなして保持し続けない。

**キュー**：GPUワーカー並列数1。ページID＋セッション単位の`requestSeq`で最新入力を識別。未実行の旧ジョブは`superseded`、実行中旧ジョブは結果を破棄。必要なら終了までGPU利用を継続するが、旧ジョブ完了を待たずUI操作は可能。プロセスシャットダウン時はキューとジョブの参照を解放。サーバー全体での無制限キュー蓄積禁止。

**CUDA OOM**：原因追跡のログを残して、一時特徴量／不要キャッシュ解放→`gc.collect()`→`torch.cuda.empty_cache()`→最大1回だけ**同条件**で再試行。使用中のデータ・モデル参照が残るとVRAMが減らないため、復旧成功を保証しない。再試行失敗時は`GPU_OOM`、`retryable=true`を返す。**CPUへ自動fallbackしない**。

**GPU負荷**：実行環境GPUのVRAM使用量を計測。SAM3のモデルサイズが16GB VRAMで必ず動くとは保証しない。モデルロード直後・テキスト推論・ポイント推論の最大VRAMを記録。必要な追加要件が出た場合は、確認なく仕様を変えずissue化。

### 5.4 フロント状態遷移

```text
idle → uploading → queued → loading/running → ready
  │           │                  ├→ failed → retry
  │           └→ cancelled       └→ cancelled/superseded
  └──────────────────────────────→ idle
ready → (point/threshold/prompt change) → queued → ready
ready → OK → committed → idle
ready → cancel → idle（ドラフト破棄）
```

- クライアントの`requestSeq`は連続増分。画像ID、pageID、requestSeqが現在値と一致した**最新ready結果だけ**適用。古い結果は処理しない。
- 新入力後は前回マスクを「前回結果」として表示可能。ただし**最新の入力が未反映の間はOK不可**。失敗時は前回結果を保持し、明示的に入力を元に戻せばOK可能。
- コンポーネント破棄時は`AbortController`でポーリング中断し、可能な範囲でジョブDELETE。AbortはGPUカーネルの即時停止と同義ではない。
- ポイントはクリック時点でローカル状態に記録し、最新の**全ポイント集合**を都度送る。キューに積む入力は参照ではなくimmutable snapshot。
- すべての異常で既存プロジェクトの確定済みマスク・レイヤー・画像・Undo/Redoは変更しない。

## 6. PNG／Canvasの加工パイプライン

### 6.1 描画インターフェース

既存の`draw(ctx,img,layers,selected,scale,selectionScale,imageEdit,originalSize)`を大幅変更する場合は、既存呼び出しの回帰テストを通す。推奨：後方互換を維持した引数末尾`options={maskEffects,maskAssets,draft,maskSelection}`、または`drawPageComposite({ ... })`ラッパーを導入。**メインスレッド・画像Worker・原寸モーダル・サムネイル・全件PNGで同じcompositorを利用**。

```text
[原画像不変Blob]
  ├─ 元画素を読取 → 加工オブジェクトごとに原画素から効果を算出
  ├─ マスク変形/輪郭補正 → alpha clip
  ├─ 追加順に加工領域を合成 → 一時ドラフト（画面のみ）
  └─ imageEditのクロップ/回転を同一座標変換で適用
       └─ 既存文字/吹き出し/キャプション/SFXを最後に描画
            ├─ LIVE PREVIEW（選択ハンドル付き）
            ├─ FULL PREVIEW（選択ハンドルなし）
            ├─ PNG・Worker（ドラフト・選択なし）
            └─ サムネイル（ドラフト・選択なし）
```

- `imageMatrix`適用の順序を固定。マスクは**原画像座標**で加工してからクロップ／回転で画面へ投影する。画像編集によってマスクの元座標を書き換えない。
- 元画像のピクセレート時、原画像全体を20pxグリッドで算出。マスクbboxの左上から20pxを数えると、移動でモザイクグリッドが変わるため禁止。
- ブラーは周辺画素を正しく参照するためROIを半径以上拡張。ROI境界での黒ハロー・エッジ欠け禁止。ブラー有効／無効でマスク外のpixelは元の合成値と一致する。
- 後勝ち重複は各加工の対象部分だけで上書き。マスクの**外側は一切書換えない**。イメージ全域の画像加工を合成すると元の先行加工が消えるため禁止。
- 元マスクの二値輪郭にCanvasで意図しないフェザーを入れない（今回フェザーなし）。拡大表示時の境界見た目と元解像度の実際のピクセルをテスト。
- `maskEffects`変更でサムネイル・PNGキャッシュを失効。無関係なフォント読み込み等の無駄な再レンダリングは現行最適化を維持。
- 確定前プレビューは最終PNGに含めない。全ページ一括保存、編集済みページだけの保存、ページ単体保存に確定マスクを反映。
- Workerへ生の`Uint8Array`を複数ジョブで転送する場合は所有権移転によるメイン側バッファdetachを避ける（clone／SharedArrayBufferのCORS設定依存なしで設計）。

### 6.2 性能対策と障害時動作

- 第22問によりマスク素材を編集中メモリ保持。画像規模に比例してRAMが必要。4,000×6,000の全域8bitマスクは24MB／件（rawの場合）、bbox保持で節約。
- Canvas描画は「画像1回の再描画で効果を再計算」より、画像内容・マスク・効果パラメータの署名を使った中間キャッシュを検討。導入時も**LRU／遅延マスクデコードは実装しない**。
- マスクが100件あるページ、4K以上、Undo連打、保存・再読込のメモリピークを測定し、結果を性能レポートへ記録。100件は**性能検証条件**であって製品上限ではない。
- Canvas allocation／OffscreenCanvas／画像エンコード失敗時は対象ページの書き出しを明示失敗にし、成功扱いで不完全PNGを保存しない。元のデータは維持。

## 7. 永続化・互換性・自動保存

### 7.1 スキーマと形式

1. `PROJECT_VERSION`を10→11へ。`maskEffects`はページmanifest内のメタデータ、`maskAssets`はバイト列アセットを参照。
2. `.serifu`の`containerVersion`を1→2へ（先頭magicは既存を保持）。v2のレイアウトは`[12byte header][JSON manifest][image Blob 1..N][mask Blob 1..M]`。manifestには`assets`（従来画像）、`maskAssets`（codec/bbox/byteLength/checksum）を別配列として記録。バイト位置は元画像総サイズと各mask byteLengthから厳密に計算。
3. v1の読込は旧レイアウトを維持。v2読込では`maskAssetIndex`とページ内のasset参照を検証。`manifest`16MiB上限維持。マスクの圧縮payloadはmanifestへBase64で埋め込まない。
4. JSON保存は各ページ`maskAssets`にcodec・bbox・sha256・`dataBase64`を格納。インポート時にBase64検証・サイズ検証・checksum照合。旧JSON v1〜v10読込可能。巨大JSONについてブラウザメモリ使用量の注意とテスト。
5. 自動保存はIndexedDBに元画像Blob＋圧縮マスクBlob＋metadataを保存。ページ単位の一時保存時に画像／マスク／メタデータの参照整合性を保ち、失敗時に古い有効な一時保存を破壊しない。
6. 旧アプリに新形式を渡す場合に無言でマスクが消えないよう、版11／コンテナv2を**旧版拒否**とする。v10へダウングレードして保存しない。
7. 旧1〜10の読込・編集・再保存で失われるフィールドがないこと、既存設定・プリセット・元画像・クロップ情報が不変であることをテスト。

### 7.2 保存／Undoの整合性

- 追加OK・削除・表示切替・効果変更・margin変更・移動・リサイズはUndo/Redo対象。1回の操作で1履歴（ドラッグはpointerupで確定、連続値入力は適切にまとめる）。
- 第16問の一括OKで全選択マスクを**1件の履歴チェックポイント**として登録。
- 履歴スナップショットはeffect情報・assetIdのみにする。`MaskAsset`を100世代分文字列化しない。Undo後も参照素材がない状況を作らない。
- 一時保存時の下書き候補・画像ID・GPU jobIdは保存しない。確定したマスクだけ永続化。
- 画像変更時、`page.edited`、確認済み`page.done`、サムネイル、編集済み一括保存対象、ページフィルターを同期する。

## 8. 開発サーバー・起動・アクセス制御

### 8.1 起動

`npm run dev`を追加。既存`npm start`は従来の静的開発サーバーとして残す。NodeとPythonのプロセスを監視し、片方が異常終了したらもう片方を停止する。SIGINT/SIGTERMの子プロセス残留禁止。起動ログにUI URL、FastAPI status、モデルパス、GPU接続可否を表示。Windows PowerShellからWSL2経由でlocalhostブラウザ接続できることを確認。

セットアップ導線：

```bash
# リポジトリルート
uv python install 3.12
cd backend
uv sync --locked
cd ..
npm run dev
# ブラウザ: http://localhost:5173
```

セットアップスクリプトはuv未インストール・モデル不在・CUDA不一致のエラーを対処可能な形で表示。Python環境・pip cache・モデルはGitのtrackedファイルに含めない。

### 8.2 セキュリティ契約

- NodeとFastAPIはともに`127.0.0.1`bind。FastAPIの直通ブラウザアクセスは不要。Node側は`/api/sam3/`固定prefix以外へのproxy禁止。任意URL/proxyのopen redirectを作らない。
- Nodeは`Host`をlocalhost系に限定、POST/DELETEには`Origin`ヘッダーで同一originを検証。**Originがない要求**は非ブラウザ利用を許すか明文化し、同等のHost/Fetch Metadata検査を適用。DNS rebindingを考慮。
- 外部ネットワークへモデルや画像を送信しない。FastAPI CORSは不用／無効。GitHub Pages上はAI新規検出カードを「ローカル推論利用不可」と明示し、クリックで意図せずlocalhost APIへ送らない。
- multipartの実サイズ・画像形式・dim・pixel count・gzip/解凍爆弾・処理時間・ジョブ数を制限。Server stack trace、画像バイト、プロンプト原文をログに残さない（必要時に安全なdebug設定で限定）。
- `SAM3_MODEL_PATH`はサーバー管理者が環境変数で指定したファイルのみ使用。HTTPパラメータで任意ファイルパスを受け取らない。

## 9. エラーコード・復旧契約

| ケース | API/code | フロントの挙動 |
|---|---|---|
| モデル不在 | `MODEL_NOT_FOUND` (503) | パスとセットアップ手順を表示。確定マスクは編集可能 |
| 初期化失敗／互換性 | `MODEL_LOAD_FAILED` (503) | 推論停止、詳細（安全に整形）、再接続可能 |
| CUDA OOM | `GPU_OOM` (503) | 自動1回再試行後、理由を表示・手動再試行可能 |
| 画像キャッシュ失効 | `IMAGE_EXPIRED` (410) | 元画像を再転送し、最新要求を一度だけ再送 |
| 入力不正 | `INVALID_IMAGE`/`INVALID_PROMPT`/`INVALID_POINTS` (400/413/422) | 項目を指示、不要なretryなし |
| 推論タイムアウト | `INFERENCE_TIMEOUT` (504) | 最新入力を保持、再試行。遅延結果は破棄 |
| 接続断 | browser network error | ステータス未接続へ更新。確定マスク編集継続 |
| 古い推論 | `SUPERSEDED` (409/状態) | UI更新せず、最新ジョブのみ待つ |
| キャンセル | `CANCELLED` | 暫定候補はキャンセル操作なら破棄、確定マスク不変 |
| 保存不整合 | `INVALID_MASK_ASSET`（読込時JS例外） | 対象プロジェクトの一部を無言で欠落させず読込中止。既存編集状態維持 |

APIのHTTP状態は表を初期規約として確定し、`backend/tests`で固定。再試行の無限ループを禁止。

## 10. 実装ファイル構成（予定）

```text
serifu-editor/
├─ index.html                   # SAM3カード／overlay UI
├─ style.css                    # 画面内レイアウト・候補表示
├─ server.mjs                   # localhost API proxy
├─ package.json                 # dev/start/check/test追加
├─ scripts/
│  ├─ dev.mjs                   # Node+FastAPI起動監視
│  └─ sam3-browser-smoke.mjs    # モックE2E
├─ src/
│  ├─ app.js                    # ページ・選択・入力との統合
│  ├─ renderer.js               # compositor統合
│  ├─ model.js                  # maskEffects・履歴
│  ├─ mask-codec.js             # RLE/bitpackのコーデック
│  ├─ mask-geometry.js          # transform/収縮/膨張
│  ├─ mask-effects.js           # Canvas画像加工・合成
│  ├─ sam3-client.js            # API通信・ジョブpoll
│  ├─ sam3-ui.js                # 候補・ポイントoverlay UI
│  ├─ project-io.js             # v11／.serifu v2／JSON
│  ├─ storage.js                # 圧縮マスクの一時保存
│  ├─ image-worker.js           # マスク付きPNG
│  ├─ preview-modal.js          # 原寸結果
│  └─ export-cache.js           # mask署名
├─ backend/
│  ├─ pyproject.toml
│  ├─ uv.lock
│  ├─ .python-version           # 3.12
│  ├─ app/
│  │  ├─ main.py                # FastAPI routes
│  │  ├─ schemas.py             # Pydantic request/response
│  │  ├─ engine.py              # SAM3読み込み・推論adapter
│  │  ├─ jobs.py                # latest-wins queue
│  │  ├─ image_cache.py         # TTL・RAM上限
│  │  ├─ mask_codec.py          # JS互換mask codec
│  │  └─ settings.py            # env・validation
│  └─ tests/                    # API/engine/mock/codec/tests
├─ test/
│  ├─ mask-codec.test.mjs
│  ├─ mask-geometry.test.mjs
│  ├─ mask-effects.test.mjs
│  ├─ sam3-state.test.mjs
│  └─ mask-project.test.mjs
├─ dev/docs/
│  ├─ sow/SOW_20261011_sam3_segmentation.md
│  ├─ adr/0022-sam3-mask-effects-and-storage.md
│  └─ sam3-gpu-validation.md
└─ .github/workflows/ci.yml  # Python/mock追加
```

> ファイル名は担当エージェントが責務分割上の理由で変更可能。ただし変更はADR/READMEへ反映し、`server.mjs`のallowlist、`scripts/build.mjs`、Node構文チェックの新規ES module参照を必ず更新。未使用ファイル／重複実装を残さない。

## 11. 作業フェーズと品質ゲート

### Phase 0：preflight・契約確定（実装開始前）

- 最新`main`からfeatureブランチ作成、`git status`クリーン確認。ローカル未コミットの変更を勝手に上書きしない。
- SAM3 upstream commitをpinし、`sam3.pt`の存在・チェックポイント形式・PyTorch+CUDA組合せ・ライセンスを確認。
- `build_sam3_image_model(...enable_inst_interactivity=True)`＋テキスト＋ポイント単体の**最小スモーク**を先に実施。SAM3公式のAPIを実機で確認できない場合は、モックを進めつつ実機ブロッカーを明記。
- JSON/API/mask codecのfixtureを定義、`dev/docs/adr/0022-...md`を追加。

**Gate 0**：公式API参照箇所・依存バージョン・checkpointパス・mock/実機境界が文書化済み。

### Phase 1：Python環境／SAM3 API／運用

- uvによる独立環境、FastAPI、画像登録・画像ID・TTL・RAM上限、latest-winsキュー、job polling、health、error schema、プロキシ、`npm run dev`を実装。
- モデル起動・10分アイドル解放・再ロード、OOM一回再試行、タイムアウト・キャンセルを実装。
- 公式テキスト検出とポイント予測器をadapterに隔離。テキスト候補からポイント修正への挙動は実機fixtureで確認。

**Gate 1**：FastAPIのmock単体テスト成功、Node proxy/Origin/Host制御、`npm run dev`で両サーバー起動停止。モデル無しでもhealthとエラー表示可能。

### Phase 2：SAM3カード／候補ドラフトUI

- ORIGINAL下のカード、入力プロンプト、信頼度、point modes、Canvas overlay、画像アップロード、推論結果一覧／色分け／複数選択を実装。
- ポイント修正、連続クリック最新優先、候補番号・スコア・hover、表示ON/OFF、キャンセルを実装。
- LIVE PREVIEWへ加工前の候補と仮加工を安全に描画。OKは最新readyのみ許可。

**Gate 2**：モックE2Eでテキスト/ポイント/複数/追加除外/連打/キャンセル/再試行を通す。既存のORIGINAL操作・LIVE PREVIEWドラッグ正常。

### Phase 3：マスク効果・ジオメトリ・描画

- `maskEffects`、codec、中央カード、4効果、bbox変形・輪郭調整、重複後勝ち、座標変換を実装。
- `draw()`とWorker／原寸／サムネイルの加工を一致させ、仮加工・確定加工を分離。
- マスクOFF・削除、選択・ドラッグ・8方向リサイズ、数値編集、Undo/Redo対応。

**Gate 3**：ピクセル単位の期待値テスト（元画像保持、効果4種、境界、重複、crop・90°回転、Worker一致）成功。

### Phase 4：保存・復元・履歴

- v11／コンテナv2、JSON、IndexedDB、一括保存、編集済み判定、素材GC、checksumを実装。
- 旧1〜10／コンテナv1読込、マスク含むv11完全ラウンドトリップ。壊れたmask blobは安全に拒否。
- README・HANDOFF・ADR・リポジトリ内の開発ドキュメント更新。

**Gate 4**：再起動・API停止状態で全効果を再編集・PNG保存可能。保存→読込→保存でマスクshapeと効果値一致。旧データ復元で回帰なし。

### Phase 5：総合検証・実機GPU・PR

- 既存Nodeテスト・ブラウザテスト・GitHub Pages静的ビルドとSAM3なし動作を全実行。
- Pythonテスト・モックE2E・GPU実機スモークを実行。peak VRAM、アイドル後残VRAM、推論時間、キャッシュ再利用、再ロード時間を測定。
- 4K/6K画像、複数候補、100マスク編集・保存、高速Undo/Redo、OOMを検証。測定値は`dev/docs/sam3-gpu-validation.md`へ記録。
- コードレビュー、`git diff --check`、README/ADR整合性確認後PR作成。`main`へのmergeはユーザー承認待ち。

**Gate 5**：後述の必須受入テスト全通過、実GPU検証記録、既知制限記載。GPUを使えない場合は未完了テストと再現コマンド付きPR（正式完了とは表現しない）。

## 12. 必須テストケース（Given／When／Then）

| ID | 条件・操作 | 期待結果 |
|---|---|---|
| FE-01 | ORIGINALの下にページ表示 | SAM3カードが各ページに1つ存在、画像と対応 |
| FE-02 | 「face」で3候補をmock検出 | スコア降順・3色・番号・35%選択塗り・チェックボックス |
| FE-03 | 3候補中2候補を選択しOK | 独立maskEffectsを2件追加。Undo1回で2件とも消える |
| FE-04 | 連続クリック中に古いjobが遅れて終了 | 最新requestSeqだけを反映。旧結果で上書きされない |
| FE-05 | 前景2点・背景1点 | 3点が保持され、全点を送信。前景緑／背景赤 |
| FE-06 | 候補選択モードでクリック | クリックはpoint追加でなく候補選択のみを実行 |
| FE-07 | point追加直後に古いreadyを保持 | OK不可。最新ready後OK可能 |
| FE-08 | 推論中にキャンセル／ページ切替 | 確定済みは不変、ドラフト破棄、遅延応答無視 |
| FE-09 | threshold0.50→0.25 | 再問い合わせし候補一覧更新、スコア表示 |
| FX-01 | ピクセレート20px、ブロック境界 | 原画像基準の正確な20×20ブロック、周囲の非マスク画素不変 |
| FX-02 | blur12pxとblur0px | マスク内だけ適用、境界に黒ハローなし、0pxは原画素 |
| FX-03 | 黒塗り／白塗り | マスク内部RGBがそれぞれ0/255、alpha=1、外部は変更なし |
| FX-04 | マスクAの後にBを重ねる | 交差部はBだけ、Aのみの領域はA、Bを削除するとAが復帰 |
| FX-05 | マスクの-5px/+5px | 輪郭収縮／膨張、元マスク不変、0pxで元形状へ厳密復元 |
| FX-06 | 8方向ハンドルと移動 | bbox数値が更新、変形済みshapeが見た目とPNGで一致 |
| FX-07 | 0/90/180/270度回転・クロップ変更 | マスクと元画像の同一位置を保持、crop変更で消失しない |
| FX-08 | セリフと顔マスクを同じ位置に配置 | セリフが前面、セリフ自体にモザイクなし |
| FX-09 | マスクを追加・非表示・削除 | 編集済み・確認済み・thumbnail・undoを正しく更新 |
| FX-10 | 仮加工ありでPNGを保存 | 仮加工は含まれず確定加工のみ出力 |
| IO-01 | 各mask codecで乱数・全0・全1・1pixel・穴ありを往復 | JS/Pythonで完全一致、checksum一致、異常データ拒否 |
| IO-02 | `.serifu v2`とJSONと一時保存を往復 | mask shape・effect値・bbox・原画素を完全復元 |
| IO-03 | v1/旧JSON v1〜10を読み込む | マスク空扱い、旧画像・文字・クロップ等のデータ保持 |
| IO-04 | 圧縮payload/sha/offsetを破壊して読込 | 例外とエラーを表示。既存開いている編集内容は保護 |
| IO-05 | API停止後にv11を再読込 | モザイクを移動・調整・PNG出力できる |
| IO-06 | 過去100回の編集・Undo/RedoとGC | 参照中mask assetを消さず、Undo後に完全復元 |
| IO-07 | 一括保存・単体保存・Worker/browser・原寸表示 | 同条件で画素が一致、候補／操作枠は含まれない |
| BE-01 | 画像ID期限切れでinfer | HTTP410、フロント自動再アップロード一回、最新job正常 |
| BE-02 | model file不在 | MODEL_NOT_FOUND。静的編集・画像保存は正常 |
| BE-03 | mock CUDA OOM 1回 | cache解放→同条件で1回再試行。2回目失敗はエラー表示 |
| BE-04 | 同じpageでrequestSeq=1,2,3連投 | 実行待ちの古いjobは破棄、結果3のみ有効 |
| BE-05 | POST／DELETEを別Origin・不正Hostから送信 | リクエスト拒否、任意proxyや外部ネットワーク露出なし |
| BE-06 | 大きすぎるファイル/悪意あるmask/座標nan | 400/413/422系で拒否、サーバーは生存 |
| GPU-01 | 実checkpointでtext/points/refine実行 | 検出マスクとクリック対象が表示される（検出精度は画像例で確認） |
| GPU-02 | 推論後10分アイドル | モデル／特徴量参照を解放しVRAM使用量が有意に減少。再ロード後推論成功 |
| GPU-03 | 他プロセスVRAM圧迫または注入OOM | リトライと失敗表示、データ保持。CPU fallbackなし |
| REG-01 | 既存全Nodeテスト・ブラウザE2E・静的ビルド | 全合格。GitHub Pagesは推論無しで既存編集機能を維持 |

### 自動化コマンドの要件

```bash
npm run check
npm test
npm run build
npm run test:browser
npm run test:bulk
npm run test:sam3-browser
cd backend && uv run pytest -q
# 実GPU限定：
cd backend && uv run pytest -m gpu -v
```

- 既存の`scripts/browser-smoke.mjs`が長時間の場合はSAM3 E2Eのみ個別実行してもよいが、最終ゲートでは既存回帰スイートを実行。GitHub Actionsでは`pytest -m 'not gpu'`を使用。
- GPU-01は「チェックポイントが無いからスキップ」を正式合格としない。`SAM3_MODEL_PATH`と実環境バージョンをテスト記録に残す。
- PNG比較にはRGB等の既知色fixtureを使用。blurなど実装差異がある場合は許容差の理由をテストコメントに明記。マスク領域内外の選択は厳密検証。

## 13. リスク台帳・対処（必須）

| リスク | 重要度 | 対処・判定 |
|---|---|---|
| SAM3公式APIがupstream更新で変化 | 高 | commitをpin。テキストとポイントのadapterを分離。Phase 0実機スモークを先に実行 |
| `sam3.pt`が期待形式でない／SAM3.1用 | 高 | `load_from_HF=False`、checkpointロードの厳密テスト。勝手にモデルDLや別モデルへの置換をしない |
| 16GB級GPUでOOM | 高 | 1ジョブ直列、features解放、VRAM計測、失敗時の再試行。性能未達はissue化 |
| 大量マスクでブラウザRAM膨張 | 高 | bboxでデコード済み保持、上限ガードと100件ストレステスト。無音クラッシュ禁止 |
| クロップ・回転で画素ずれ | 高 | 原画像座標統一、各90°とcropのgolden pixelテスト |
| 保存v2により旧アプリと非互換 | 高 | PROJECT_VERSION=11／コンテナv2の明示的拒否、旧版読込維持。保存形式ADR |
| 大量・壊れたマスクでデコード過負荷 | 高 | `n=w*h`事前検証、bit length/ラン長/checksum確認、割当量制限 |
| 弱いブラー・小ブロックで被写体を識別できる | 中 | 匿名化保証なしの注意書き。黒塗りを選択可能にする |
| ポイント予測でテキスト候補が変わる | 高 | candidate対象とpoints predictorを分離、前景点明示、実機で有効性検証 |
| 重複領域で先行加工が消える | 高 | 加工効果を必ず原画像から生成、クリップ合成、交差・差集合のピクセルテスト |
| GPU解放してもVRAM占有が残る | 中 | model/processor/feature参照とCUDA allocatorを検査。nvidia-smiで観測 |
| localhost proxyへの悪意あるWebアクセス | 高 | Host/Origin/Fetch Metadata、認証不要の範囲限定、API rate limit、外部bind禁止 |
| GIF/EXIF/色空間の寸法不一致 | 中 | サーバーとブラウザのデコード規約と元画像座標を統一。不一致時は拒否 |
| Windows↔WSL2 localhost転送失敗 | 中 | `127.0.0.1`両bind、Windowsブラウザで実証し手順をREADME化 |
| モックだけ通り実checkpoint失敗 | 高 | 完了条件に実GPUを必須化、性能記録とblockerをPRへ明示 |

## 14. PR・成果物・引継ぎ条件

PRに必須：

1. 説明：27問の確定仕様への追従・採用アーキテクチャ・主な変更ファイル・影響範囲。
2. テスト：すべてのGate結果、CIリンク、実機ログ／VRAM／処理時間（モデル未検証ならその理由と実行方法）。
3. 互換性：旧版編集データ、`.serifu v2`、新JSON、一時保存、GitHub Pagesの検証結果。
4. Docs：README起動手順、`dev/docs/HANDOFF.md`、`dev/docs/adr/0022-...md`、本SOW、`dev/docs/sam3-gpu-validation.md`更新。
5. リスク：未解決制約、メモリ上限、SAM3 API commit、残作業issue。個人画像、重みファイル、巨大生成ファイルをcommitしない。
6. 禁止：`main`への直接push、既存のフォント/プリセット/画像書出し仕様の変更、テスト未実施を「確認済み」とする表現。

### 完了時の報告テンプレート

```text
実装ブランチ: feat/sam3-segmentation-20261011
PR: <URL>
対象main SHA: <SHA>
Nodeテスト: PASS/FAIL/未実施
Pythonテスト: PASS/FAIL/未実施
Browser/Playwright: PASS/FAIL/未実施
GPU実機: PASS/FAIL/未実施（sam3.pt形式、GPU名、peak VRAM、アイドル後VRAM）
旧データ互換: PASS/FAIL/未実施
保存/復元とPNG: PASS/FAIL/未実施
未解決事項: <issues>
正式完成: YES/NO（GPU未実施ならNO）
```

## 15. 公式資料・設計根拠

- [Meta公式SAM3 README](https://github.com/facebookresearch/sam3/blob/main/README.md) — 公式環境条件、SAM3の画像／テキスト推論、モデルの位置付け。2026-10-11参照。
- [sam3/model/sam3_image_processor.py](https://github.com/facebookresearch/sam3/blob/main/sam3/model/sam3_image_processor.py) — `Sam3Processor`, 解像度1008、しきい値0.5、`set_text_prompt`の実装。
- [sam3/model/sam1_task_predictor.py](https://github.com/facebookresearch/sam3/blob/main/sam3/model/sam1_task_predictor.py) — `SAM3InteractiveImagePredictor`、前景／背景ポイント推論。
- [sam3/model_builder.py](https://github.com/facebookresearch/sam3/blob/main/sam3/model_builder.py) — `checkpoint_path`, `load_from_HF`, `enable_inst_interactivity`。SAM3.1との差異に注意。
- [serifu-editor: ADR-0017](https://github.com/falls247/serifu-editor/blob/main/dev/docs/adr/0017-src-layout-and-static-assets.md) — 静的構成・配信。
- [serifu-editor: ADR-0019](https://github.com/falls247/serifu-editor/blob/main/dev/docs/adr/0019-multi-selection-and-image-edits.md) — 非破壊crop/rotationと元座標。
- [serifu-editor: ADR-0020](https://github.com/falls247/serifu-editor/blob/main/dev/docs/adr/0020-full-size-preview-and-numeric-ui.md) — 原寸プレビューと数値UI。

### 15.1 インタビューで未指定だったためSOWが初期値として定めた項目

これらは実装の再現性確保のための**設計案**であり、インタビューで明示確定した要件とは区別する。エージェントはデフォルトで採用し、技術的に不合理ならADRで理由と代案を記録。

- ピクセレート1〜200px、ぼかし0〜100px、輪郭補正-100〜+100pxの範囲。
- 画像アップロード30MiB、画像最大40Mpx、RAMキャッシュ512MiB、最大ポイント128件、プロンプト500字。
- マスクの`bitpack-lsb-v1`／`rle32le-v1`の詳細バイト仕様、コンテナv2バイナリ構成。
- マスク効果を`page.maskEffects`として文字の`page.layers`と分離、コピー操作の対象範囲。
- mask alphaの二値化、フェザーなし、変形時最近傍、Euclidean距離基準の輪郭補正。
- ジョブのpoll方式、受入テストでの数値範囲、GPU性能指標は実機測定後に報告。

---

**最終指示**：本SOWは仕様書。これを作成した時点ではアプリコード／モデル／GitHubリポジトリは変更しない。実装指示を受けたエージェントがfeatureブランチを切り、Phase 0から順番に進めること。
