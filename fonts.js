// Bundled, OFL-licensed Japanese fonts, pinned to verified Google Fonts blobs.
export const FONT_COMMIT='7085eb89a950e85db5b166b7a58d414544b4140c';
export const FONT_CATALOG=Object.freeze({
  comic:{label:'漫画・極太（Dela Gothic One）',group:'太字・インパクト',family:'MangaBold',fallback:'"Noto Sans CJK JP", "Yu Gothic", sans-serif',weight:900,faceWeight:'100 900',directory:'delagothicone',file:'DelaGothicOne-Regular.ttf',sha:'258f93526667223b6fd9476258d42ace60c7bfd6',license:'OFL.txt',licenseSha:'87fae845f60599624117220cf9477a0eca0785c2'},
  pop:{label:'丸太・ポップ（Mochiy Pop One）',group:'太字・インパクト',family:'MangaPop',fallback:'sans-serif',weight:400,directory:'mochiypopone',file:'MochiyPopOne-Regular.ttf',sha:'f239f79ceabc9badc25538ab578b81fcc1f116fa',license:'MochiyPopOne-OFL.txt',licenseSha:'86795012f007cabeb9436324516df761ca239d3e'},
  angular:{label:'鋭角・力強い（Reggae One）',group:'太字・インパクト',family:'MangaAngular',fallback:'sans-serif',weight:400,directory:'reggaeone',file:'ReggaeOne-Regular.ttf',sha:'f4f626ef844f87b114e452bbd20a8cbf18fc288d',license:'ReggaeOne-OFL.txt',licenseSha:'e0eee2be4b495dc76f687f68f2d530535d61ab52'},
  rock:{label:'手描き角字（RocknRoll One）',group:'太字・インパクト',family:'MangaRock',fallback:'sans-serif',weight:400,directory:'rocknrollone',file:'RocknRollOne-Regular.ttf',sha:'95f92adda0d50a5255a552e528f4aff05e414b6c',license:'RocknRollOne-OFL.txt',licenseSha:'7533550f40651462bb8b30d2770318ac22ea587e'},
  hand:{label:'やわらかい手書き（Klee One）',group:'手書き・丸文字',family:'MangaHand',fallback:'sans-serif',weight:600,directory:'kleeone',file:'KleeOne-SemiBold.ttf',sha:'aa30525e375c811d763675277cb3ae3ed56ddcbc',license:'KleeOne-OFL.txt',licenseSha:'cb9ced3f0aad10958824080d84c391100bc53986'},
  round:{label:'細い丸文字（Hachi Maru Pop）',group:'手書き・丸文字',family:'MangaRound',fallback:'sans-serif',weight:400,directory:'hachimarupop',file:'HachiMaruPop-Regular.ttf',sha:'1339bf206111860f1d3867146aa53662bdbd1919',license:'HachiMaruPop-OFL.txt',licenseSha:'6a4c49354dcd5ad707eac83a8be787c10221db59'},
  brush:{label:'筆文字・ハネ（Yuji Boku）',group:'筆文字・明朝',family:'MangaBrush',fallback:'"Yu Mincho", serif',weight:400,directory:'yujiboku',file:'YujiBoku-Regular.ttf',sha:'3a8cb821f00c7c03ac2eb90915898749b9bce4df',license:'YujiBoku-OFL.txt',licenseSha:'cff4fd743037483847e8d10afbc7ebc5e9226553'},
  flowing:{label:'流れる筆文字（Yuji Mai）',group:'筆文字・明朝',family:'MangaFlowing',fallback:'serif',weight:400,directory:'yujimai',file:'YujiMai-Regular.ttf',sha:'5d1d1e6899c3c1483f8ed774551e324d9785ca03',license:'YujiMai-OFL.txt',licenseSha:'cff4fd743037483847e8d10afbc7ebc5e9226553'},
  decorative:{label:'飾り明朝・太字（Kaisei Decol）',group:'筆文字・明朝',family:'MangaDecorative',fallback:'serif',weight:700,directory:'kaiseidecol',file:'KaiseiDecol-Bold.ttf',sha:'e2062d66f31dd00a82e71bce529c63bfbe12b8f8',license:'KaiseiDecol-OFL.txt',licenseSha:'60ad1b2898d1e02903ea7f55380b5a9ce30cee77'},
  sans:{label:'ゴシック（端末の書体）',group:'基本書体',family:'"Noto Sans JP", "Yu Gothic", sans-serif'},
  serif:{label:'明朝（端末の書体）',group:'基本書体',family:'"Yu Mincho", "Hiragino Mincho ProN", serif'},
});
export const FONT_CHOICES=Object.freeze(Object.fromEntries(Object.entries(FONT_CATALOG).map(([key,font])=>[key,font.label])));
export const FONT_FILES=Object.values(FONT_CATALOG).filter(font=>font.file).flatMap(font=>[
  {directory:font.directory,source:font.file,file:font.file,sha:font.sha},
  {directory:font.directory,source:'OFL.txt',file:font.license,sha:font.licenseSha},
]);
export const FONT_STYLES=Object.values(FONT_CATALOG).filter(font=>font.file).map(font=>`@font-face{font-family:${font.family};src:url('./assets/fonts/${font.file}') format('truetype');font-weight:${font.faceWeight||font.weight};font-display:swap}`).join('\n');
export function fontDescription(layer) {
  const font=FONT_CATALOG[layer.font]||FONT_CATALOG.sans;
  return {family:font.file?`"${font.family}", ${font.fallback}`:font.family,weight:font.weight||(layer.kind==='sfx'?900:700),load:font.file?`${font.weight} 64px ${font.family}`:null};
}
