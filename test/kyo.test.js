// Jalankan: npm test   (atau: node --test test/kyo.test.js)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';
import { runTool, resolveSafe, MAX_OUTPUT } from '../src/tools.js';
import { chat } from '../src/llm.js';
import { Agent } from '../src/agent.js';

const KYO = fileURLToPath(new URL('../bin/kyo.js', import.meta.url));
const APP_JS = "export const greet = (n) => 'Halo ' + n;\n";

let base; // folder sementara: base/secret.txt (di luar), base/proj (folder kerja), base/home
async function freshProject(name) {
  const proj = path.join(base, name);
  await mkdir(path.join(proj, 'src'), { recursive: true });
  await writeFile(path.join(proj, 'src', 'app.js'), APP_JS);
  await writeFile(path.join(proj, 'package.json'), '{ "name": "demo" }\n');
  await mkdir(path.join(proj, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(proj, 'node_modules', 'x', 'index.js'), 'greet');
  return proj;
}

function runKyo(args, { cwd, input = '', env = {}, home } = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KYO_')));
  const h = home || path.join(base, 'home');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [KYO, ...args], {
      cwd,
      env: { ...cleanEnv, HOME: h, USERPROFILE: h, NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`kyo timeout\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const mockEnv = (mock, extra = {}) => ({
  KYO_BASE_URL: mock.url,
  KYO_API_KEY: 'test-key',
  KYO_MODEL: 'mock-model',
  ...extra,
});
const toolMsgs = (req) => req.body.messages.filter((m) => m.role === 'tool');
const allowAll = { confirm: async () => true };

before(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'kyo-test-'));
  await writeFile(path.join(base, 'secret.txt'), 'RAHASIA-JANGAN-DIBACA');
  await mkdir(path.join(base, 'home'));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('alur lengkap agent (mode satu tugas)', () => {
  test('list_files → read_file → edit_file → run_command → jawaban akhir', async () => {
    const proj = await freshProject('full');
    const NEW = '`Halo ${n} $& $1`'; // "$" tidak boleh rusak
    const mock = await startMockServer((body, n) => {
      if (n === 0)
        return {
          text: 'Saya cek dulu struktur proyek.',
          toolCalls: [
            { name: 'list_files', args: {} },
            { name: 'read_file', args: { path: 'src/app.js' } },
          ],
        };
      if (n === 1)
        return {
          noIndex: true, // uji cadangan id saat provider tidak mengirim index
          toolCalls: [{ name: 'edit_file', args: { path: 'src/app.js', old_str: "'Halo ' + n", new_str: NEW } }],
        };
      if (n === 2) return { toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(\'TES-OK\')"' } }] };
      return { text: 'Selesai: fungsi greet sudah diperbarui dan diverifikasi.' };
    });

    try {
      const r = await runKyo(['ubah greet'], { cwd: proj, input: 'y\ny\n', env: mockEnv(mock) });
      assert.equal(r.code, 0, r.stdout + r.stderr);

      // Header & tampilan ringkas pemanggilan tool
      assert.match(r.stdout, new RegExp(`kyo · mock-model · ${proj.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
      assert.match(r.stdout, /▤ list_files \./);
      assert.match(r.stdout, /◉ read_file src\/app\.js/);
      assert.match(r.stdout, /✎ edit_file src\/app\.js/);
      assert.match(r.stdout, /❯ run_command node -e/);
      assert.match(r.stdout, /Selesai: fungsi greet sudah diperbarui dan diverifikasi\./);

      // File benar-benar berubah, "$" utuh
      assert.equal(await readFile(path.join(proj, 'src', 'app.js'), 'utf8'), `export const greet = (n) => ${NEW};\n`);

      // Riwayat yang dikirim ke LLM
      const reqs = mock.requests;
      assert.equal(reqs.length, 4);
      assert.equal(reqs[0].headers.authorization, 'Bearer test-key');
      assert.equal(reqs[0].body.model, 'mock-model');
      assert.equal(reqs[0].body.stream, true);
      assert.equal(reqs[0].body.tools.length, 6);
      assert.equal(reqs[0].body.messages[0].role, 'system');
      assert.ok(reqs[0].body.messages[0].content.includes(proj));

      // Tool call hasil akumulasi delta (dengan index, diselang-seling)
      const asst1 = reqs[1].body.messages.find((m) => m.role === 'assistant');
      assert.equal(asst1.content, 'Saya cek dulu struktur proyek.');
      assert.deepEqual(
        asst1.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)]),
        [['list_files', {}], ['read_file', { path: 'src/app.js' }]],
      );
      const [listRes, readRes] = toolMsgs(reqs[1]);
      assert.equal(listRes.tool_call_id, asst1.tool_calls[0].id);
      assert.equal(readRes.tool_call_id, asst1.tool_calls[1].id);
      assert.match(listRes.content, /^src\/app\.js$/m);
      assert.match(listRes.content, /^package\.json$/m);
      assert.doesNotMatch(listRes.content, /node_modules/);
      assert.match(readRes.content, /^\s+1 {2}export const greet/);

      // Tool call tanpa index (mode cadangan id)
      const asst2 = reqs[2].body.messages.filter((m) => m.role === 'assistant')[1];
      assert.deepEqual(JSON.parse(asst2.tool_calls[0].function.arguments).new_str, NEW);
      assert.equal(toolMsgs(reqs[2]).at(-1).content, 'OK: src/app.js diperbarui');

      const cmdRes = toolMsgs(reqs[3]).at(-1).content;
      assert.match(cmdRes, /exit code: 0/);
      assert.match(cmdRes, /TES-OK/);
    } finally {
      await mock.close();
    }
  });

  test('batas langkah tercapai → minta ketik "lanjutkan"', async () => {
    const proj = await freshProject('steps');
    const mock = await startMockServer(() => ({ toolCalls: [{ name: 'list_files', args: {} }] }));
    try {
      const r = await runKyo(['loop terus'], { cwd: proj, env: mockEnv(mock, { KYO_MAX_STEPS: '2' }) });
      assert.equal(mock.requests.length, 2);
      assert.match(r.stdout, /Batas 2 langkah tercapai\. Ketik "lanjutkan"/);
    } finally {
      await mock.close();
    }
  });

  test('error API ditampilkan jelas (status + isi body)', async () => {
    const proj = await freshProject('apierr');
    const mock = await startMockServer(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }));
    try {
      const r = await runKyo(['halo'], { cwd: proj, env: mockEnv(mock) });
      assert.equal(r.code, 1);
      assert.match(r.stdout, /LLM error 401.*Invalid API key/);
    } finally {
      await mock.close();
    }
  });

  test('server tidak bisa dihubungi → pesan koneksi', async () => {
    const proj = await freshProject('noconn');
    const r = await runKyo(['halo'], {
      cwd: proj,
      env: { KYO_BASE_URL: 'http://127.0.0.1:1/v1', KYO_API_KEY: 'x', KYO_MODEL: 'm' },
    });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Gagal terhubung ke http:\/\/127\.0\.0\.1:1\/v1\/chat\/completions/);
  });
});

// ---------------------------------------------------------------------------
describe('pembatasan folder kerja', () => {
  test('tools menolak "../", path absolut, dan path campuran', async () => {
    const proj = await freshProject('sandbox');
    const ctx = { root: proj, ...allowAll };
    const outside = path.join(base, 'secret.txt');
    for (const p of ['../secret.txt', 'src/../../secret.txt', outside, '..']) {
      await assert.rejects(runTool('read_file', { path: p }, ctx), /Akses ditolak/, p);
    }
    await assert.rejects(runTool('list_files', { path: '..' }, ctx), /Akses ditolak/);
    await assert.rejects(runTool('search_code', { pattern: 'x', path: '../' }, ctx), /Akses ditolak/);
    await assert.rejects(runTool('write_file', { path: '../evil.txt', content: 'x' }, ctx), /Akses ditolak/);
    await assert.rejects(
      runTool('edit_file', { path: outside, old_str: 'RAHASIA', new_str: 'X' }, ctx),
      /Akses ditolak/,
    );
    assert.equal(existsSync(path.join(base, 'evil.txt')), false);
    assert.equal(await readFile(outside, 'utf8'), 'RAHASIA-JANGAN-DIBACA');

    // Path di dalam folder kerja tetap boleh, termasuk yang memakai ".." di tengah.
    assert.equal(resolveSafe(proj, 'src/../package.json'), path.join(proj, 'package.json'));
    assert.equal(resolveSafe(proj, '..foo'), path.join(proj, '..foo'));
  });

  test('symlink/junction ke luar folder kerja ditolak', async (t) => {
    const proj = await freshProject('symlink');
    try {
      await symlink(base, path.join(proj, 'tautan'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`tidak bisa membuat symlink: ${err.code}`);
      return;
    }
    await assert.rejects(runTool('read_file', { path: 'tautan/secret.txt' }, { root: proj, ...allowAll }), /Akses ditolak/);
  });

  test('agent mengembalikan error ke LLM, isi file di luar tidak bocor', async () => {
    const proj = await freshProject('sandbox-agent');
    const mock = await startMockServer((body, n) =>
      n === 0 ? { toolCalls: [{ name: 'read_file', args: { path: '../secret.txt' } }] } : { text: 'Tidak bisa.' },
    );
    try {
      const r = await runKyo(['baca secret'], { cwd: proj, env: mockEnv(mock) });
      assert.equal(r.code, 0);
      const res = toolMsgs(mock.requests[1])[0].content;
      assert.match(res, /Akses ditolak/);
      assert.doesNotMatch(JSON.stringify(mock.requests), /RAHASIA-JANGAN-DIBACA/);
    } finally {
      await mock.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('perizinan', () => {
  const editScenario = (calls) => (body, n) => (n === 0 ? { toolCalls: calls } : { text: 'ok' });

  test('n = tolak: file tidak berubah, LLM menerima "Ditolak oleh pengguna."', async () => {
    const proj = await freshProject('deny');
    const mock = await startMockServer(
      editScenario([
        { name: 'edit_file', args: { path: 'src/app.js', old_str: 'Halo', new_str: 'Hai' } },
        { name: 'run_command', args: { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\')"' } },
      ]),
    );
    try {
      const r = await runKyo(['ubah'], { cwd: proj, input: 'n\nn\n', env: mockEnv(mock) });
      assert.equal(r.code, 0);
      assert.equal(await readFile(path.join(proj, 'src', 'app.js'), 'utf8'), APP_JS);
      assert.equal(existsSync(path.join(proj, 'ran.txt')), false);
      assert.deepEqual(toolMsgs(mock.requests[1]).map((m) => m.content), ['Ditolak oleh pengguna.', 'Ditolak oleh pengguna.']);
      assert.match(r.stdout, /- export const greet = \(n\) => 'Halo ' \+ n;|- Halo/); // diff tampil sebelum izin
      assert.match(r.stdout, /\+ Hai/);
    } finally {
      await mock.close();
    }
  });

  test('Enter = izinkan sekali; a = selalu untuk jenis aksi itu', async () => {
    const proj = await freshProject('always');
    await writeFile(path.join(proj, 'b.txt'), 'satu\ndua\n');
    const mock = await startMockServer(
      editScenario([
        { name: 'edit_file', args: { path: 'src/app.js', old_str: 'Halo', new_str: 'Hai' } }, // jawab "a"
        { name: 'edit_file', args: { path: 'b.txt', old_str: 'dua', new_str: 'DUA' } }, // tanpa prompt
        { name: 'write_file', args: { path: 'baru/c.txt', content: 'c' } }, // tanpa prompt
        { name: 'run_command', args: { command: 'node -e "console.log(1)"' } }, // jawab Enter
      ]),
    );
    try {
      const r = await runKyo(['ubah'], { cwd: proj, input: 'a\n\n', env: mockEnv(mock) });
      assert.equal(r.code, 0);
      assert.equal((r.stdout.match(/Terapkan perubahan\?/g) || []).length, 1);
      assert.equal((r.stdout.match(/Jalankan perintah\?/g) || []).length, 1);
      assert.match(await readFile(path.join(proj, 'src', 'app.js'), 'utf8'), /Hai/);
      assert.equal(await readFile(path.join(proj, 'b.txt'), 'utf8'), 'satu\nDUA\n');
      assert.equal(await readFile(path.join(proj, 'baru', 'c.txt'), 'utf8'), 'c');
      assert.match(toolMsgs(mock.requests[1]).at(-1).content, /exit code: 0/);
    } finally {
      await mock.close();
    }
  });

  test('--yolo melewati semua konfirmasi', async () => {
    const proj = await freshProject('yolo');
    const mock = await startMockServer(
      editScenario([{ name: 'edit_file', args: { path: 'src/app.js', old_str: 'Halo', new_str: 'Hai' } }]),
    );
    try {
      const r = await runKyo(['--yolo', 'ubah'], { cwd: proj, env: mockEnv(mock) });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, /Terapkan perubahan\?/);
      assert.match(await readFile(path.join(proj, 'src', 'app.js'), 'utf8'), /Hai/);
    } finally {
      await mock.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('mode interaktif', () => {
  test('REPL: slash command, riwayat, /model, /clear, /exit', async () => {
    const proj = await freshProject('repl');
    await writeFile(path.join(proj, 'AGENT.md'), 'Selalu pakai titik koma.');
    const mock = await startMockServer((body, n) => ({ text: `Balasan ke-${n + 1}` }));
    try {
      const input = ['/help', 'halo', '', '/model model-lain', 'lagi', '/tokens', '/clear', 'ketiga', '/yolo', '/config', '/exit', 'tidak-terkirim'].join('\n') + '\n';
      const r = await runKyo([], { cwd: proj, input, env: mockEnv(mock) });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /● model +mock-model/); // banner
      assert.match(r.stdout, /Perintah di mode interaktif/); // /help
      assert.match(r.stdout, /Balasan ke-1[\s\S]*Balasan ke-2[\s\S]*Balasan ke-3/);
      assert.match(r.stdout, /Model: model-lain/);
      assert.match(r.stdout, /Riwayat percakapan dihapus\./);
      assert.match(r.stdout, /✓ selesai dalam [\d.]+s · ↑\d+ ↓7 token \(cache 3\)/);
      assert.match(r.stdout, /Sesi ini: 2 request · ↑\d+ input \(cache 6\) · ↓14 output/);
      assert.match(r.stdout, /Mode yolo: aktif/);
      assert.ok(r.stdout.includes(path.join(path.join(base, 'home'), '.kyo-agent', 'config.json')));

      const reqs = mock.requests;
      assert.equal(reqs.length, 3);
      assert.match(reqs[0].body.messages[0].content, /Aturan proyek \(AGENT\.md\)\nSelalu pakai titik koma\./);
      assert.equal(reqs[1].body.model, 'model-lain');
      assert.deepEqual(
        reqs[1].body.messages.slice(1).map((m) => [m.role, m.content]),
        [['user', 'halo'], ['assistant', 'Balasan ke-1'], ['user', 'lagi']],
      );
      // Setelah /clear hanya tersisa system prompt + pesan baru
      assert.deepEqual(reqs[2].body.messages.map((m) => m.role), ['system', 'user']);
      assert.equal(reqs[2].body.messages[0].content, reqs[0].body.messages[0].content);
    } finally {
      await mock.close();
    }
  });

  test('config belum ada → setup otomatis, lalu masuk REPL', async () => {
    const proj = await freshProject('firstrun');
    const home = path.join(base, 'home-firstrun');
    await mkdir(home);
    const mock = await startMockServer(() => ({ text: 'Siap!' }), { models: ['model-a', 'model-custom'] });
    try {
      // provider, base URL, API key, lalu pilih model nomor 2 dari daftar
      const input = ['custom', mock.url, 'kunci-rahasia', '2', 'halo', '/exit'].join('\n') + '\n';
      const r = await runKyo([], { cwd: proj, input, home });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Belum ada konfigurasi/);
      assert.match(r.stdout, /2 model tersedia/);
      const file = path.join(home, '.kyo-agent', 'config.json');
      const cfg = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(cfg, { provider: 'custom', baseUrl: mock.url, model: 'model-custom', apiKey: 'kunci-rahasia', maxSteps: 30 });
      if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.match(r.stdout, /● model +model-custom/);
      assert.match(r.stdout, /Siap!/);
      assert.equal(mock.requests[0].headers.authorization, 'Bearer kunci-rahasia');
    } finally {
      await mock.close();
    }
  });

  test('/model tanpa argumen: pilih dari daftar, tersimpan sebagai default', async () => {
    const proj = await freshProject('pickmodel');
    const home = path.join(base, 'home-pickmodel');
    await mkdir(path.join(home, '.kyo-agent'), { recursive: true });
    const mock = await startMockServer((body) => ({ text: `Dijawab oleh ${body.model}` }), {
      models: ['gpt-4o-mini', 'claude-sonnet-5', 'text-embedding-3-small', 'deepseek-v4-pro'],
    });
    await writeFile(
      path.join(home, '.kyo-agent', 'config.json'),
      JSON.stringify({ provider: 'custom', baseUrl: mock.url, apiKey: 'k', model: 'gpt-4o-mini', maxSteps: 30 }),
    );
    try {
      const input = ['/model', '99', '1', 'halo', '/model', '', '/model deepseek-v4-pro', 'lagi', '/exit'].join('\n') + '\n';
      const r = await runKyo([], { cwd: proj, input, home });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Model tersedia \(3\)/); // embedding disembunyikan
      assert.doesNotMatch(r.stdout, /text-embedding/);
      assert.match(r.stdout, /● 3\. gpt-4o-mini/); // model aktif ditandai (urut abjad)
      assert.match(r.stdout, /Nomor harus 1–3/);
      assert.match(r.stdout, /✔ Model: claude-sonnet-5/);
      assert.match(r.stdout, /Model tetap: claude-sonnet-5/); // Enter = batal
      assert.match(r.stdout, /claude-sonnet-5 ❯❯ /); // model tampil di prompt
      assert.deepEqual(mock.requests.map((q) => q.body.model), ['claude-sonnet-5', 'deepseek-v4-pro']);
      const cfg = JSON.parse(await readFile(path.join(home, '.kyo-agent', 'config.json'), 'utf8'));
      assert.equal(cfg.model, 'deepseek-v4-pro');
      assert.equal(cfg.apiKey, 'k'); // field lain tidak berubah

      // Saat dibuka lagi model terakhir dipakai; -m hanya untuk sesi itu.
      const r2 = await runKyo(['-m', 'gpt-4o-mini', 'tes'], { cwd: proj, home });
      assert.match(r2.stdout, /kyo · gpt-4o-mini/);
      const r3 = await runKyo(['models'], { cwd: proj, home });
      assert.equal(r3.code, 0);
      assert.match(r3.stdout, /● deepseek-v4-pro/);
      assert.match(r3.stdout, /3 model/);
    } finally {
      await mock.close();
    }
  });

  test('kyo setup dengan nama preset (ollama, tanpa API key)', async () => {
    const proj = await freshProject('setup');
    const home = path.join(base, 'home-setup');
    await mkdir(home);
    const r = await runKyo(['setup'], { cwd: proj, input: 'ollama\n\nllama3.2\n', home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const cfg = JSON.parse(await readFile(path.join(home, '.kyo-agent', 'config.json'), 'utf8'));
    assert.equal(cfg.baseUrl, 'http://localhost:11434/v1');
    assert.equal(cfg.model, 'llama3.2');
    assert.equal(cfg.apiKey, 'ollama');
    assert.doesNotMatch(r.stdout, /API key:/);
  });

  test('--help', async () => {
    const r = await runKyo(['--help'], { cwd: base });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /kyo "tugas kamu"/);
  });
});

// ---------------------------------------------------------------------------
describe('unit: tools', () => {
  test('read_file: nomor baris, offset/limit, info sisa baris, CRLF', async () => {
    const proj = await freshProject('read');
    await writeFile(path.join(proj, 'n.txt'), Array.from({ length: 10 }, (_, i) => `baris ${i + 1}`).join('\r\n'));
    const out = await runTool('read_file', { path: 'n.txt', offset: 3, limit: 2 }, { root: proj });
    assert.equal(out, '    3  baris 3\n    4  baris 4\n…(6 baris lagi, gunakan offset=5)');
  });

  test('edit_file: pesan error membantu & mendukung file CRLF', async () => {
    const proj = await freshProject('edit');
    const ctx = { root: proj, ...allowAll };
    await writeFile(path.join(proj, 'd.txt'), 'a = 1\r\nb = 1\r\nc = 2\r\n');
    assert.match(await runTool('edit_file', { path: 'd.txt', old_str: 'zzz', new_str: 'y' }, ctx), /tidak ditemukan.*read_file/);
    assert.match(await runTool('edit_file', { path: 'd.txt', old_str: '= 1', new_str: '= 9' }, ctx), /muncul 2 kali/);
    assert.match(await runTool('edit_file', { path: 'd.txt', old_str: 'b = 1\nc = 2', new_str: 'b = $1\nc = $$' }, ctx), /^OK/);
    assert.equal(await readFile(path.join(proj, 'd.txt'), 'utf8'), 'a = 1\r\nb = $1\r\nc = $$\r\n');
  });

  test('search_code: case-insensitive, format file:baris: isi, abaikan node_modules', async () => {
    const proj = await freshProject('search');
    const out = await runTool('search_code', { pattern: 'GREET\\s*=' }, { root: proj });
    assert.equal(out, "src/app.js:1: export const greet = (n) => 'Halo ' + n;");
    assert.equal(await runTool('search_code', { pattern: 'tidakada123' }, { root: proj }), 'Tidak ada hasil.');
    assert.match(await runTool('search_code', { pattern: '(' }, { root: proj }), /Regex tidak valid/);
  });

  test('output tool besar dipotong, bagian awal & akhir dipertahankan', async () => {
    const proj = await freshProject('big');
    await writeFile(path.join(proj, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `baris ke-${i + 1}`).join('\n'));
    const out = await runTool('read_file', { path: 'big.txt', limit: 5000 }, { root: proj });
    assert.ok(out.length <= MAX_OUTPUT + 50);
    assert.match(out, /output dipotong \d+ karakter/);
    assert.match(out, /^ +1  baris ke-1\n/);
    assert.match(out, /baris ke-5000$/);
  });

  test('read_file memotong baris yang sangat panjang (file minified)', async () => {
    const proj = await freshProject('minified');
    await writeFile(path.join(proj, 'min.js'), 'x'.repeat(5000));
    const out = await runTool('read_file', { path: 'min.js' }, { root: proj });
    assert.ok(out.length < 1100);
    assert.match(out, /…$/);
  });

  test('run_command: kode warna ANSI & progress bar dibersihkan', async () => {
    const proj = await freshProject('ansi');
    const script = "process.stdout.write('\\x1b[32mHIJAU\\x1b[0m\\n10%\\r50%\\r100%\\n')";
    const out = await runTool('run_command', { command: `node -e "${script}"` }, { root: proj, ...allowAll });
    assert.equal(out, 'exit code: 0\nHIJAU\n100%');
  });

  test('run_command: exit code non-zero dan stderr', async () => {
    const proj = await freshProject('cmd');
    const out = await runTool('run_command', { command: 'node -e "console.error(\'GAGAL\');process.exit(3)"' }, { root: proj, ...allowAll });
    assert.match(out, /^exit code: 3\nGAGAL/);
  });
});

describe('unit: llm & agent', () => {
  test('chat(): beberapa tool call tanpa index dipisahkan lewat id', async () => {
    const mock = await startMockServer(() => ({
      noIndex: true,
      text: 'dua tool',
      toolCalls: [
        { name: 'read_file', args: { path: 'a.js' } },
        { name: 'read_file', args: { path: 'b.js' } },
      ],
    }));
    try {
      let streamed = '';
      const { content, toolCalls } = await chat({
        config: { baseUrl: mock.url + '/', model: 'm', apiKey: 'k' },
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        onText: (t) => (streamed += t),
      });
      assert.equal(content, 'dua tool');
      assert.equal(streamed, 'dua tool');
      assert.deepEqual(toolCalls.map((t) => JSON.parse(t.function.arguments).path), ['a.js', 'b.js']);
      assert.notEqual(toolCalls[0].id, toolCalls[1].id);
      assert.equal(mock.requests[0].body.tools, undefined); // tools kosong tidak dikirim
    } finally {
      await mock.close();
    }
  });

  test('chat(): meminta & membaca usage token', async () => {
    const mock = await startMockServer(() => ({ text: 'ok' }));
    try {
      const { usage } = await chat({ config: { baseUrl: mock.url, model: 'm', apiKey: 'k', maxTokens: 500 }, messages: [{ role: 'user', content: 'x' }] });
      assert.deepEqual(mock.requests[0].body.stream_options, { include_usage: true });
      assert.equal(mock.requests[0].body.max_tokens, 500);
      assert.equal(usage.output, 7);
      assert.equal(usage.cached, 3);
      assert.ok(usage.input > 0);
    } finally {
      await mock.close();
    }
  });

  test('chat(): provider yang menolak stream_options → diulang tanpa field itu', async () => {
    const mock = await startMockServer((body) =>
      body.stream_options ? { status: 400, body: { error: { message: 'Unrecognized request argument: stream_options' } } } : { text: 'ok' },
    );
    try {
      const config = { baseUrl: mock.url, model: 'm', apiKey: 'k' };
      const { content, usage } = await chat({ config, messages: [{ role: 'user', content: 'x' }] });
      assert.equal(content, 'ok');
      assert.equal(usage, null);
      await chat({ config, messages: [{ role: 'user', content: 'y' }] });
      assert.equal(mock.requests.length, 3); // request berikutnya langsung tanpa stream_options
    } finally {
      await mock.close();
    }
  });

  test('riwayat melewati contextBudget → output tool lama dipangkas, yang terbaru utuh', async () => {
    const proj = await freshProject('prune');
    await writeFile(path.join(proj, 'besar.txt'), 'isi panjang\n'.repeat(800));
    const mock = await startMockServer((body, n) =>
      n < 6 ? { toolCalls: [{ name: 'read_file', args: { path: 'besar.txt' } }] } : { text: 'beres' },
    );
    try {
      const agent = new Agent({ config: { baseUrl: mock.url, model: 'm', apiKey: 'k', maxSteps: 10, contextBudget: 5000 }, root: proj, confirm: async () => true });
      await agent.init();
      await agent.run('baca berulang');
      const tools = toolMsgs(mock.requests.at(-1));
      assert.equal(tools.length, 6);
      assert.ok(tools.slice(0, 2).every((m) => /dipangkas untuk hemat token/.test(m.content)));
      assert.ok(tools.slice(-4).every((m) => !/dipangkas/.test(m.content)));
      assert.equal(agent.lastUsage.requests, 7);
      assert.equal(agent.lastUsage.output, 49);
    } finally {
      await mock.close();
    }
  });

  test('compact(): riwayat diganti ringkasan dari LLM', async () => {
    const mock = await startMockServer((body, n) => ({ text: n === 0 ? 'jawaban panjang '.repeat(50) : 'RINGKASAN' }));
    try {
      const agent = new Agent({ config: { baseUrl: mock.url, model: 'm', apiKey: 'k' }, root: base, confirm: async () => true });
      await agent.init();
      await agent.run('halo');
      const r = await agent.compact();
      assert.ok(r.after < r.before);
      assert.deepEqual(agent.messages.map((m) => m.role), ['system', 'user', 'assistant']);
      assert.match(agent.messages[1].content, /RINGKASAN/);
      assert.equal(mock.requests[1].body.tools, undefined);
      assert.equal(agent.usage.requests, 2);
    } finally {
      await mock.close();
    }
  });

  test('Ctrl+C (abort) membatalkan request dan riwayat dikembalikan', async () => {
    const mock = await startMockServer(() => ({ delay: 3000, text: 'lambat' }));
    try {
      const agent = new Agent({ config: { baseUrl: mock.url, model: 'm', apiKey: 'k', maxSteps: 5 }, root: base, confirm: async () => true });
      await agent.init();
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 200);
      const t0 = Date.now();
      await assert.rejects(agent.run('halo', ctrl.signal), { name: 'AbortError' });
      assert.ok(Date.now() - t0 < 2500);
      assert.equal(agent.messages.length, 1); // hanya system prompt
    } finally {
      await mock.close();
    }
  });
});
