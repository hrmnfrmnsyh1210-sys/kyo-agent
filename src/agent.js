import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chat } from './llm.js';
import { toolSchemas, runTool } from './tools.js';
import { DEFAULT_CONTEXT_BUDGET } from './config.js';
import { c, createSpinner, truncate, toolLabel } from './ui.js';

export const RULE_FILES = ['AGENT.md', 'KYO.md', 'CLAUDE.md'];

async function loadProjectRules(root) {
  // Aturan khusus proyek, mirip CLAUDE.md di Claude Code.
  let out = '';
  for (const name of RULE_FILES) {
    try {
      const text = await readFile(path.join(root, name), 'utf8');
      out += `\n\n# Aturan proyek (${name})\n${text.trim()}`;
    } catch {}
  }
  return out;
}

export async function buildSystemPrompt(root) {
  return `Kamu adalah kyo, coding agent yang berjalan di terminal pengguna.

Lingkungan:
- Folder kerja: ${root}
- OS: ${os.platform()} (${os.release()})${os.platform() === 'win32' ? ' — perintah dijalankan lewat cmd.exe' : ''}
- Tanggal: ${new Date().toISOString().slice(0, 10)}

Cara kerja:
- Pahami dulu proyeknya dengan list_files, search_code, dan read_file sebelum mengubah apa pun.
- Selalu baca file sebelum mengeditnya. Utamakan edit_file dengan perubahan kecil; write_file untuk file baru.
- Ikuti gaya kode, framework, dan konvensi yang sudah ada di proyek.
- Setelah mengubah kode, verifikasi bila memungkinkan (jalankan test, lint, atau build).
- Jangan menjalankan perintah yang tidak berhenti sendiri (dev server, watch mode).
- Jangan menjalankan perintah destruktif (rm -rf, git push --force, drop database) kecuali diminta jelas.
- Semua path relatif terhadap folder kerja; kamu tidak bisa mengakses file di luar folder kerja.
- Hemat langkah: cari lokasi dengan search_code lalu baca bagian yang relevan saja (offset/limit). Jangan membaca ulang file yang belum berubah.
- Panggil beberapa tool sekaligus dalam satu langkah bila tidak saling bergantung.
- Jika permintaan ambigu, tanyakan dulu ke pengguna.
- Jawab dengan bahasa yang sama dengan pengguna, singkat dan jelas. Akhiri dengan ringkasan apa yang diubah.${await loadProjectRules(root)}`;
}

const abortError = () => Object.assign(new Error('Dibatalkan'), { name: 'AbortError' });

// Perkiraan kasar jumlah token (±4 karakter per token) tanpa tokenizer.
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += String(m.content ?? '').length;
    for (const tc of m.tool_calls || []) chars += tc.function.name.length + tc.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

const KEEP_RECENT_TOOLS = 4; // hasil tool terbaru yang selalu dibiarkan utuh
const STUB_HEAD = 300;

const stub = (text, what) =>
  `${text.slice(0, STUB_HEAD)}\n…[${what} dipangkas untuk hemat token (${text.length} karakter). Panggil tool lagi jika perlu.]`;

// Argumen besar (isi write_file/edit_file) diringkas, JSON tetap valid.
function shrinkArgs(json) {
  try {
    const args = JSON.parse(json);
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length > STUB_HEAD) args[k] = v.slice(0, 120) + `…[${v.length} karakter]`;
    }
    return JSON.stringify(args);
  } catch {
    return json;
  }
}

const addUsage = (total, u) => {
  if (!u) return;
  total.input += u.input;
  total.output += u.output;
  total.cached += u.cached;
  total.requests++;
};
const emptyUsage = () => ({ input: 0, output: 0, cached: 0, requests: 0 });

export class Agent {
  constructor({ config, root, confirm, out = process.stdout }) {
    this.config = config;
    this.root = root;
    this.confirm = confirm;
    this.out = out;
    this.messages = [];
    this.usage = emptyUsage(); // total sesi
  }

  async init() {
    this.messages = [{ role: 'system', content: await buildSystemPrompt(this.root) }];
  }

  // Hapus riwayat, pertahankan system prompt.
  reset() {
    this.messages = this.messages.slice(0, 1);
  }

  // Pangkas output tool & argumen besar yang sudah lama bila riwayat melewati budget.
  // Dilakukan sekaligus (bukan sedikit-sedikit tiap langkah) agar awalan riwayat
  // jarang berubah sehingga prompt caching provider tetap efektif.
  prune({ force = false } = {}) {
    const budget = this.config.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const before = estimateTokens(this.messages);
    if (!force && (!budget || before <= budget)) return null;

    const toolIdx = this.messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
    const cutoff = toolIdx.length > KEEP_RECENT_TOOLS ? toolIdx[toolIdx.length - KEEP_RECENT_TOOLS] : 0;
    for (let i = 1; i < cutoff; i++) {
      const m = this.messages[i];
      // Stub lebih pendek dari ambang ini, jadi pesan yang sudah dipangkas tidak diproses ulang.
      if (m.role === 'tool' && m.content.length > STUB_HEAD * 2) {
        this.messages[i] = { ...m, content: stub(m.content, 'output lama') };
      }
      if (m.tool_calls?.some((tc) => tc.function.arguments.length > STUB_HEAD * 2)) {
        this.messages[i] = {
          ...m,
          tool_calls: m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function, arguments: shrinkArgs(tc.function.arguments) } })),
        };
      }
    }
    const after = estimateTokens(this.messages);
    return after < before ? { before, after } : null;
  }

  // Ringkas seluruh percakapan jadi satu pesan (perintah /compact).
  async compact(signal) {
    if (this.messages.length <= 2) return null;
    const before = estimateTokens(this.messages);
    const { content, usage } = await chat({
      config: this.config,
      signal,
      messages: [
        ...this.messages,
        {
          role: 'user',
          content:
            'Ringkas percakapan di atas untuk melanjutkan pekerjaan nanti: tujuan pengguna, keputusan penting, file yang dibaca/diubah beserta perubahannya, status terakhir, dan langkah berikutnya. Padat, poin-poin, tanpa basa-basi. Jangan memanggil tool.',
        },
      ],
    });
    addUsage(this.usage, usage);
    if (!content.trim()) throw new Error('Ringkasan kosong dari LLM.');
    this.messages = [
      this.messages[0],
      { role: 'user', content: `Ringkasan percakapan sebelumnya:\n${content.trim()}` },
      { role: 'assistant', content: 'Siap, saya lanjutkan dari ringkasan ini.' },
    ];
    return { before, after: estimateTokens(this.messages) };
  }

  async run(userInput, signal) {
    const checkpoint = this.messages.length;
    this.messages.push({ role: 'user', content: userInput });
    this.lastUsage = emptyUsage();
    try {
      return await this.#loop(signal);
    } catch (err) {
      // Batalkan giliran ini seluruhnya agar riwayat tetap valid
      // (tidak ada tool_calls yang tertinggal tanpa hasil).
      if (err.name === 'AbortError') this.messages.length = checkpoint;
      throw err;
    }
  }

  async #loop(signal) {
    const maxSteps = this.config.maxSteps || 30;
    for (let step = 0; step < maxSteps; step++) {
      const pruned = this.prune();
      if (pruned) console.log(c.gray(`♻ konteks dipangkas: ~${fmtK(pruned.before)} → ~${fmtK(pruned.after)} token`));

      const spinner = createSpinner(step === 0 ? 'berpikir' : 'melanjutkan');
      spinner.start();
      let started = false;

      let result;
      try {
        result = await chat({
          config: this.config,
          messages: this.messages,
          tools: toolSchemas,
          signal,
          onText: (t) => {
            if (!started) {
              spinner.stop();
              this.out.write('\n');
              started = true;
            }
            this.out.write(t);
          },
        });
      } finally {
        spinner.stop();
      }
      const { content, toolCalls, usage } = result;
      addUsage(this.usage, usage);
      addUsage(this.lastUsage, usage);
      if (started) this.out.write('\n');

      const assistantMsg = { role: 'assistant', content: content || null };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      this.messages.push(assistantMsg);

      if (!toolCalls.length) return { done: true }; // selesai: LLM tidak memanggil tool lagi

      for (const call of toolCalls) {
        if (signal?.aborted) throw abortError();
        const name = call.function.name;
        let args;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          console.log(c.red(`● ${name}`) + c.gray(' (argumen JSON tidak valid)'));
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Error: argumen bukan JSON yang valid. Kirim ulang dengan JSON yang benar.',
          });
          continue;
        }

        console.log(toolLabel(name) + c.gray(' ' + truncate(summarize(name, args), 120)));

        let output;
        try {
          output = await runTool(name, args, { root: this.root, confirm: this.confirm, signal });
        } catch (err) {
          output = `Error: ${err.code === 'ENOENT' ? `file/folder tidak ditemukan: ${args.path}` : err.message}`;
          console.log(c.red(`  ✖ ${output.slice(7)}`));
        }
        if (signal?.aborted) throw abortError();
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }

    console.log(c.yellow(`\n⚠ Batas ${maxSteps} langkah tercapai. Ketik "lanjutkan" untuk meneruskan.`));
    return { done: false };
  }
}

export const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));

function summarize(name, a) {
  if (name === 'run_command') return String(a.command ?? '');
  if (name === 'search_code') return `/${a.pattern}/ ${a.path || ''}`.trim();
  return String(a.path || '.');
}
