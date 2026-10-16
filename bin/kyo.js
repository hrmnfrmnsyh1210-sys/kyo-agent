#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { loadConfig, runSetup, updateConfig, chooseModel, CONFIG_FILE } from '../src/config.js';
import { Agent, estimateTokens, fmtK } from '../src/agent.js';
import { listModels } from '../src/llm.js';
import { c, accent, gradient, banner } from '../src/ui.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const cmd = (name, desc) => `  ${accent(0.45)(name.padEnd(22))}${c.dim(desc)}`;
const section = (title) => `\n${c.bold(title)}`;

const HELP = [
  '',
  `${gradient('kyo')} ${c.gray('—')} coding agent CLI ${c.gray(`v${version}`)}`,
  section('Pemakaian:'),
  cmd('kyo', 'mode interaktif di folder saat ini'),
  cmd('kyo "tugas kamu"', 'jalankan satu tugas lalu keluar'),
  cmd('kyo setup', 'atur provider, model, dan API key'),
  cmd('kyo models', 'tampilkan daftar model dari provider'),
  section('Opsi:'),
  cmd('-m, --model <nama>', 'pakai model ini untuk sesi ini saja'),
  cmd('-y, --yolo', 'izinkan semua edit & perintah tanpa konfirmasi'),
  cmd('-h, --help', 'tampilkan bantuan'),
  section('Perintah di mode interaktif:'),
  cmd('/help', 'bantuan'),
  cmd('/clear', 'hapus riwayat percakapan'),
  cmd('/compact', 'ringkas riwayat agar request berikutnya lebih hemat'),
  cmd('/tokens', 'pemakaian token sesi ini & ukuran konteks'),
  cmd('/model', 'pilih model dari daftar (disimpan sebagai default)'),
  cmd('/model <nama>', 'ganti model langsung (disimpan sebagai default)'),
  cmd('/yolo', 'nyalakan/matikan konfirmasi'),
  cmd('/config', 'lokasi file config'),
  cmd('/exit', 'keluar'),
  '',
].join('\n');

function parseArgs(argv) {
  const opts = { yolo: false, model: null, prompt: [], setup: false, models: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-y' || a === '--yolo') opts.yolo = true;
    else if (a === '-m' || a === '--model') opts.model = argv[++i];
    else if (a.startsWith('--model=')) opts.model = a.slice(8);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === 'setup' && i === 0 && argv.length === 1) opts.setup = true;
    else if (a === 'models' && i === 0 && argv.length === 1) opts.models = true;
    else opts.prompt.push(a);
  }
  return opts;
}

// Input berbasis antrean: baris yang datang sebelum ditanya (mis. stdin di-pipe)
// tidak hilang. ask() menghasilkan null jika input sudah ditutup atau dibatalkan.
function createInput() {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
  const queue = [];
  let waiter = null;
  let closed = false;
  const settle = (value) => {
    const w = waiter;
    waiter = null;
    w?.(value);
  };
  rl.on('line', (line) => (waiter ? settle(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    settle(null);
  });
  return {
    rl,
    ask(prompt) {
      if (queue.length) {
        const line = queue.shift();
        stdout.write(prompt + (stdin.isTTY ? '' : line + '\n'));
        return Promise.resolve(line);
      }
      if (closed) return Promise.resolve(null);
      rl.setPrompt(prompt);
      rl.prompt();
      return new Promise((resolve) => {
        waiter = stdin.isTTY ? resolve : (line) => (stdout.write((line ?? '') + '\n'), resolve(line));
      });
    },
    cancel() {
      if (waiter) settle(null);
    },
    close() {
      rl.close();
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);

  const input = createInput();
  let config = await loadConfig();

  if (opts.setup || !config.baseUrl || !config.model) {
    if (!opts.setup) console.log(c.yellow('Belum ada konfigurasi. Jalankan setup dulu.'));
    try {
      await runSetup(input.ask);
      config = await loadConfig();
    } catch (err) {
      console.log(c.red(`✖ ${err.message}`));
      process.exitCode = 1;
      return input.close();
    }
    if (opts.setup) return input.close();
  }
  if (opts.model) config.model = opts.model;

  if (opts.models) {
    try {
      const models = await listModels(config);
      models.forEach((m) => console.log(`${m === config.model ? c.green('●') : ' '} ${m}`));
      console.log(c.dim(`\n${models.length} model · ganti dengan: kyo -m <nama>  atau  /model di mode interaktif`));
    } catch (err) {
      console.log(c.red(`✖ ${err.message}`));
      process.exitCode = 1;
    }
    return input.close();
  }

  // Ganti model: tanpa argumen = pilih dari daftar provider. Pilihan disimpan ke config.
  const switchModel = async (arg) => {
    let name = arg;
    if (!name) {
      try {
        const models = await listModels(config);
        if (!models.length) throw new Error('provider mengembalikan daftar model kosong');
        console.log(c.dim(`Model tersedia (${models.length}):`));
        name = await chooseModel(input.ask, models, { current: config.model });
      } catch (err) {
        console.log(c.red(`✖ ${err.message}`) + c.dim('\nKetik langsung: /model <nama>'));
        return;
      }
      if (!name) return console.log(c.dim(`Model tetap: ${config.model}`));
    }
    config.model = name;
    await updateConfig({ model: name });
    console.log(c.green(`✔ Model: ${name}`) + c.dim(' (disimpan sebagai default)'));
    if (process.env.KYO_MODEL) console.log(c.yellow('⚠ KYO_MODEL diset, jadi env var itu tetap dipakai saat kyo dibuka lagi.'));
  };

  // Perizinan: y/Enter = sekali, a = selalu untuk sesi ini, n = tolak
  const allowAll = { edit: opts.yolo, command: opts.yolo };
  const confirm = async (kind) => {
    if (allowAll[kind]) return true;
    const label = kind === 'edit' ? 'Terapkan perubahan?' : 'Jalankan perintah?';
    const ans = await input.ask(c.bold(`${label} ${c.dim('[y]a / [n]o / [a]lways')} `));
    if (ans === null) return false; // input ditutup / dibatalkan
    const a = ans.trim().toLowerCase();
    if (a === 'a' || a === 'always') allowAll[kind] = true;
    const ok = ['', 'y', 'ya', 'yes', 'a', 'always'].includes(a);
    if (!ok) console.log(c.dim('  Ditolak.'));
    return ok;
  };

  const root = process.cwd();
  const agent = new Agent({ config, root, confirm });
  await agent.init();

  let controller = null;
  const onSigint = () => {
    if (controller) {
      controller.abort();
      input.cancel();
      console.log(c.yellow('\n⏹ Dihentikan.'));
    } else {
      input.close();
      process.exit(130);
    }
  };
  input.rl.on('SIGINT', onSigint); // terminal (raw mode)
  process.on('SIGINT', onSigint); // non-TTY

  // "↑12.3k ↓450 token (cache 8k)" — kosong jika provider tidak melaporkan usage.
  const usageText = (u) => {
    if (!u?.requests) return '';
    const cached = u.cached ? ` (cache ${fmtK(u.cached)})` : '';
    return ` · ↑${fmtK(u.input)} ↓${fmtK(u.output)} token${cached}`;
  };

  const runTask = async (text) => {
    controller = new AbortController();
    const t0 = Date.now();
    try {
      await agent.run(text, controller.signal);
      console.log(c.gray(`\n✓ selesai dalam ${((Date.now() - t0) / 1000).toFixed(1)}s${usageText(agent.lastUsage)}`));
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') console.log(c.red(`\n✖ ${err.message}`));
      return false;
    } finally {
      controller = null;
    }
  };

  // Mode satu tugas: header ringkas saja
  if (opts.prompt.length) {
    console.log(`\n${accent(0)('◆')} ${gradient('kyo')} ${c.gray('·')} ${config.model} ${c.gray('·')} ${c.dim(root)}`);
    if (!(await runTask(opts.prompt.join(' ')))) process.exitCode = 1;
    input.close();
    return;
  }

  // Mode interaktif
  console.log(banner({ model: config.model, provider: config.provider, root, version, yolo: opts.yolo }));

  while (true) {
    const line = await input.ask(c.gray(config.model) + ' ' + gradient('❯❯') + ' ');
    if (line === null) break; // stdin ditutup
    const text = line.trim();
    if (!text) continue;

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      if (cmd === '/exit' || cmd === '/quit') break;
      else if (cmd === '/help') console.log(HELP);
      else if (cmd === '/clear') {
        agent.reset();
        console.log(c.dim('Riwayat percakapan dihapus.'));
      } else if (cmd === '/compact') {
        controller = new AbortController();
        try {
          const r = await agent.compact(controller.signal);
          console.log(r ? c.green(`✔ Riwayat diringkas: ~${fmtK(r.before)} → ~${fmtK(r.after)} token`) : c.dim('Riwayat masih kosong.'));
        } catch (err) {
          if (err.name !== 'AbortError') console.log(c.red(`✖ ${err.message}`));
        } finally {
          controller = null;
        }
      } else if (cmd === '/tokens') {
        const u = agent.usage;
        console.log(c.dim(`Konteks saat ini: ~${fmtK(estimateTokens(agent.messages))} token`));
        console.log(
          u.requests
            ? c.dim(`Sesi ini: ${u.requests} request · ↑${fmtK(u.input)} input (cache ${fmtK(u.cached)}) · ↓${fmtK(u.output)} output`)
            : c.dim('Provider belum melaporkan pemakaian token.'),
        );
      } else if (cmd === '/model' || cmd === '/models') {
        await switchModel(rest.join(' ').trim());
      } else if (cmd === '/yolo') {
        allowAll.edit = allowAll.command = !(allowAll.edit && allowAll.command);
        console.log(allowAll.edit ? c.yellow('⚡ Mode yolo: aktif') : c.green('✔ Mode yolo: mati'));
      } else if (cmd === '/config') console.log(c.dim(CONFIG_FILE));
      else console.log(c.dim('Perintah tidak dikenal. /help'));
      continue;
    }

    await runTask(text);
    console.log();
  }

  console.log(c.dim('Sampai jumpa! ') + gradient('~ kyo'));
  input.close();
}

main().catch((err) => {
  console.error(c.red(err.stack || err.message));
  process.exit(1);
});
