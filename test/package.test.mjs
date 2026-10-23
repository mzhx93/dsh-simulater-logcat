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

test('Chinese-only README preserves upstream attribution and fork identity', async () => {
  const content = await read('README.md');
  assert.ok(content.includes('https://github.com/WindyPro-rourou/dsh-logcat'));
  assert.ok(content.includes('原项目作者为 **WindyPro-rourou**'));
  assert.ok(content.includes('上游基线版本为 **0.8.4**'));
  assert.ok(content.includes(manifest.name));
  assert.ok(content.includes('Apache-2.0'));
  assert.ok(content.includes('[LICENSE](LICENSE)'));
  assert.ok(!content.includes('README.en.md'));
  assert.ok(!manifest.files.includes('README.en.md'));
  await assert.rejects(read('README.en.md'), { code: 'ENOENT' });
});

test('release helper derives fork destination without renaming the package', async () => {
  const content = await read('publish.ps1');
  assert.ok(content.includes('$manifest.repository.url'));
  assert.ok(!content.includes('$pkg.name ='));
  assert.ok(!content.includes("$repo = 'dsh-logcat'"));
});
