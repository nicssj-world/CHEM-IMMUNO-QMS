import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const readSource = (path: string) => readFile(join(process.cwd(), path), 'utf8');
const contains = (source: string, pattern: RegExp, message: string) => assert.ok(pattern.test(source), message);

test('Initial Import workspace only treats staged batches as current', async () => {
  const page = await readSource('src/app/(app)/import/page.tsx');
  contains(page, /\.eq\(['"]status['"],\s*['"]staged['"]\)/, 'current Initial batch query must exclude Applied batches');
});

test('Incremental Import workspace only treats preview batches as current', async () => {
  const page = await readSource('src/app/(app)/import/incremental/page.tsx');
  contains(page, /\.eq\(['"]status['"],\s*['"]preview['"]\)/, 'current Incremental batch query must exclude Applied batches');
});

test('unapplied batches expose confirmed cancellation and prevent another upload', async () => {
  const [initial, incremental] = await Promise.all([
    readSource('src/app/(app)/import/page.tsx'),
    readSource('src/app/(app)/import/incremental/page.tsx'),
  ]);
  contains(initial, /ConfirmSubmitForm[\s\S]*ยกเลิกชุดตรวจทาน/, 'Initial active batch needs a confirmed cancel action');
  contains(incremental, /ConfirmSubmitForm[\s\S]*ยกเลิก Preview/, 'Incremental active batch needs a confirmed cancel action');
  contains(initial, /disabled=\{uploadBlocked\}/, 'Initial upload must be blocked while a batch is active or its state is unknown');
  contains(incremental, /disabled=\{uploadBlocked\}/, 'Incremental upload must be blocked while a batch is active or its state is unknown');
});

test('cancel and Apply return to the upload workspace without selecting a completed batch', async () => {
  const [initial, incremental] = await Promise.all([
    readSource('src/app/actions/import.ts'),
    readSource('src/app/actions/incremental-import.ts'),
  ]);
  contains(initial, /redirect\(['"]\/import\?cancelled=1['"]\)/, 'Initial cancellation must return to the upload workspace');
  contains(incremental, /redirect\(\`\$\{basePath\}\?cancelled=1\`\)/, 'Incremental cancellation must return to the upload workspace');
  contains(initial, /redirect\(['"]\/import\?applied=1['"]\)/, 'Initial Apply must clear the selected batch from the URL');
  contains(incremental, /redirect\(\`\$\{basePath\}\?applied=1\`\)/, 'Incremental Apply must clear the selected batch from the URL');
});
