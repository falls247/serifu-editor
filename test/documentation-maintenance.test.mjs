import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assessDocumentation, runDocumentationCheck } from '../scripts/check-documentation.mjs';

test('application changes require a manual update or a newly added no-impact reason', () => {
  for (const file of ['src/app.js', 'src/sam3-ui.js', 'backend/app/main.py', 'index.html', 'style.css', 'server.mjs', 'scripts/dev.mjs', 'scripts/build.mjs', 'assets/fonts/example.ttf']) {
    const changedFiles = [file];
    assert.equal(assessDocumentation({ changedFiles, updatedFiles: [] }).satisfied, false, file);
    assert.equal(assessDocumentation({ changedFiles, updatedFiles: ['docs/index.html'] }).satisfied, true, file);
    assert.equal(assessDocumentation({ changedFiles, updatedFiles: ['dev/docs/documentation-impact.md'], addedImpactLines: '- 操作説明書への影響なし：描画結果を変えず計算の重複だけを削減。' }).satisfied, true, file);
  }
  for (const addedImpactLines of ['', '- 操作説明書への影響なし：', '- 検証した。']) {
    assert.equal(assessDocumentation({ changedFiles: ['src/app.js'], updatedFiles: ['dev/docs/documentation-impact.md'], addedImpactLines }).satisfied, false);
  }
  assert.equal(assessDocumentation({ changedFiles: ['test/example.test.mjs', 'AGENTS.md', 'dev/docs/HANDOFF.md'], updatedFiles: [] }).required, false);
});

test('Git comparison includes staged, unstaged, untracked and committed changes without reusing old reasons', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'serifu-doc-check-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commitFixture = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); };
  try {
    git('init', '-q');
    for (const directory of ['src', 'docs', 'dev/docs']) mkdirSync(join(cwd, directory), { recursive: true });
    write('src/app.js', 'original'); write('docs/index.html', '<html>original</html>');
    write('dev/docs/documentation-impact.md', '- 操作説明書への影響なし：以前の内部変更についての理由。\n');
    commitFixture(); const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', base);
    write('src/app.js', 'unstaged');
    assert.throws(() => runDocumentationCheck({ cwd }), /更新漏れ/);
    git('add', 'src/app.js');
    assert.throws(() => runDocumentationCheck({ cwd }), /更新漏れ/);
    write('dev/docs/documentation-impact.md', '- 操作説明書への影響なし：以前の内部変更についての理由。\n検証記録だけを追加。\n');
    assert.throws(() => runDocumentationCheck({ cwd }), /更新漏れ/, 'old reasons cannot satisfy new changes');
    write('dev/docs/documentation-impact.md', '- 操作説明書への影響なし：以前の内部変更についての理由。\n- 操作説明書への影響なし：今回は描画結果を変えずキャッシュを再利用。\n');
    assert.equal(runDocumentationCheck({ cwd }).satisfied, true);
    git('restore', '--source=HEAD', '--staged', '--worktree', '.');
    write('src/new.js', 'untracked');
    assert.throws(() => runDocumentationCheck({ cwd }), /更新漏れ/);
    write('docs/index.html', '<html>updated instructions</html>');
    assert.equal(runDocumentationCheck({ cwd }).satisfied, true);
    commitFixture();
    assert.equal(runDocumentationCheck({ cwd, base }).satisfied, true, 'CI compares committed changes');
    assert.equal(runDocumentationCheck({ cwd, base: '0'.repeat(40) }).satisfied, true, 'first branch push compares against the main merge base');
    rmSync(join(cwd, 'docs/index.html'));
    assert.throws(() => runDocumentationCheck({ cwd, base }), /更新漏れ/, 'deleting the manual does not count as updating it');
    git('restore', '--source=HEAD', '--worktree', '.');
    git('mv', 'src/new.js', 'dev/new.js');
    assert.throws(() => runDocumentationCheck({ cwd }), /更新漏れ/, 'moving application code out of src is still an application change');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
