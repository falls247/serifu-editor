import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const manual = 'docs/index.html';
const impactReport = 'dev/docs/documentation-impact.md';
const applicationFile = /^(?:src\/.*\.js$|backend\/app\/.*\.py$|assets\/|index\.html$|style\.css$|server\.mjs$|scripts\/(?:build|dev|fetch-font)\.mjs$)/;

export function assessDocumentation({ changedFiles, updatedFiles, addedImpactLines = '' }) {
  const applicationChanges = changedFiles.filter(file => applicationFile.test(file));
  if (!applicationChanges.length) return { required: false, satisfied: true };
  const manualUpdated = updatedFiles.includes(manual);
  const noImpactRecorded = updatedFiles.includes(impactReport)
    && /^\s*- 操作説明書への影響なし[：:]\s*\S.+$/m.test(addedImpactLines);
  return { required: true, satisfied: manualUpdated || noImpactRecorded, applicationChanges };
}

export function runDocumentationCheck({ cwd = fileURLToPath(new URL('../', import.meta.url)), base = process.env.DOCUMENTATION_BASE || 'HEAD' } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { git('rev-parse', '--show-toplevel'); }
  catch { throw new Error('操作説明書チェックにはGitリポジトリが必要。比較元を確認する。'); }
  const reference = /^0+$/.test(base)
    ? git('merge-base', 'HEAD', 'origin/main').trim()
    : git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim();
  const splitPaths = value => value.split('\0').filter(Boolean);
  const untracked = splitPaths(git('ls-files', '--others', '--exclude-standard', '-z'));
  const changedFiles = [...new Set([...splitPaths(git('diff', '--no-renames', '--name-only', '-z', reference, '--')), ...untracked])];
  const updatedFiles = [...new Set([...splitPaths(git('diff', '--no-renames', '--name-only', '--diff-filter=AM', '-z', reference, '--')), ...untracked])];
  const addedImpactLines = untracked.includes(impactReport)
    ? readFileSync(new URL(impactReport, pathToFileURL(`${cwd}/`)), 'utf8')
    : git('diff', '--unified=0', reference, '--', impactReport).split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const result = assessDocumentation({ changedFiles, updatedFiles, addedImpactLines });
  if (!result.satisfied) throw new Error(`操作説明書の更新漏れ: ${result.applicationChanges.join(', ')}\n利用者向けの変更はdocs/index.htmlへ反映する。影響がなければdev/docs/documentation-impact.mdに日付・変更対象と「- 操作説明書への影響なし：具体的な理由」を追記する。`);
  console.log(`操作説明書チェック: PASS（${result.required ? '説明書更新または影響なしの理由あり' : 'アプリ実装の変更なし'}）`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--base')) throw new Error('使い方: node scripts/check-documentation.mjs [--base <比較元コミット>]');
    runDocumentationCheck(args.length ? { base: args[1] } : {});
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
