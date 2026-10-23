import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('package.json'));

test('fork package identity is consistent with the DSH bundle and client', async () => {
  assert.equal(manifest.name, '@mzhx93/dsh-simulater-logcat');
  assert.equal(manifest.version, '0.9.0');
  assert.equal(manifest.repository.url, 'git+https://github.com/mzhx93/dsh-simulater-logcat.git');
  assert.equal(manifest.bugs.url, 'https://github.com/mzhx93/dsh-simulater-logcat/issues');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.ok((await read('cordis.patch.yml')).includes("name: '" + manifest.name + "'"));
  assert.ok((await read('lib/client.js')).includes('id: "' + manifest.name + '"'));
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-tools']);
  const host = await read('lib/index.js');
  assert.ok(host.includes('add ${OWN_MANIFEST.name}@'));
  assert.ok(!host.includes('add @windypro-rourou/dsh-logcat'));
});

test('fork documents upstream attribution and distinguishes unpublished registry commands', async () => {
  for (const file of ['README.md', 'README.en.md']) {
    const content = await read(file);
    assert.ok(content.includes('https://github.com/WindyPro-rourou/dsh-logcat'));
    assert.ok(content.includes(manifest.name));
    assert.ok(content.includes('Apache-2.0'));
  }
});

test('release helper derives fork destination without renaming the package', async () => {
  const content = await read('publish.ps1');
  assert.ok(content.includes('$manifest.repository.url'));
  assert.ok(!content.includes('$pkg.name ='));
  assert.ok(!content.includes("$repo = 'dsh-logcat'"));
});
