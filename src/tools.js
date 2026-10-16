import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { exec } from 'node:child_process';
import path from 'node:path';
import { c, showDiff, truncate } from './ui.js';

const IGNORE = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '.nuxt', '.output',
  '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
]);
export const MAX_OUTPUT = 12_000; // batasi output agar konteks LLM tidak penuh
const MAX_LINE = 1000; // baris super panjang (file minified) dipotong
const MAX_HITS = 100;

const isInside = (root, full) => {
  const rel = path.relative(root, full);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};

// Pastikan path tidak keluar dari folder kerja (cwd saat kyo dipanggil),
// termasuk trik "../", path absolut, drive lain (Windows), dan symlink.
export function resolveSafe(root, p) {
  if (typeof p !== 'string' || !p.trim()) p = '.';
  const full = path.resolve(root, p);
  const denied = new Error(`Akses ditolak: "${p}" berada di luar folder kerja`);
  if (!isInside(root, full)) throw denied;

  // Cek symlink: realpath dari bagian path yang sudah ada harus tetap di dalam root.
  let probe = full;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    if (!isInside(realpathSync(root), realpathSync(probe))) throw denied;
  } catch (err) {
    if (err === denied) throw err;
  }
  return full;
}

// Simpan awal & akhir: error/ringkasan perintah biasanya ada di bagian akhir.
export function cut(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const head = Math.floor(MAX_OUTPUT * 0.7);
  const tail = MAX_OUTPUT - head - 100;
  return `${s.slice(0, head)}\n…[output dipotong ${s.length - head - tail} karakter]…\n${s.slice(-tail)}`;
}

// Bersihkan output terminal: kode warna ANSI, progress bar (\r), baris kosong beruntun.
export const cleanOutput = (s) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.replace(/\r+$/, '').split('\r').pop())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

async function walk(root, dir, depth, maxDepth, out, limit = 300) {
  if (depth > maxDepth || out.length >= limit) return;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (IGNORE.has(e.name) || out.length >= limit) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push(rel + '/');
      await walk(root, full, depth + 1, maxDepth, out, limit);
    } else {
      out.push(rel);
    }
  }
}

// ---------- Skema tools yang dikirim ke LLM ----------
export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Tampilkan struktur file & folder (rekursif). Abaikan node_modules, .git, vendor, dll.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relatif, default "."' },
          depth: { type: 'number', description: 'Kedalaman maksimal, default 3' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Baca isi file dengan nomor baris. Untuk file besar gunakan offset & limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'Baris awal (mulai 1)' },
          limit: { type: 'number', description: 'Jumlah baris, default 400' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Buat file baru atau timpa seluruh isi file. Untuk perubahan kecil, pakai edit_file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Ganti potongan teks di file. old_str harus sama persis (termasuk spasi/indentasi) dan unik di file. Baca file dulu sebelum mengedit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Cari teks/regex (case-insensitive) di semua file proyek. Mengembalikan file:baris: isi.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex (JavaScript)' },
          path: { type: 'string', description: 'Folder relatif, default "."' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Jalankan perintah shell di folder kerja (misal: npm test, git status, php artisan migrate). Jangan jalankan server yang tidak berhenti (npm run dev).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', description: 'Detik, default 120' },
        },
        required: ['command'],
      },
    },
  },
];

// ---------- Implementasi ----------
// ctx = { root, confirm(kind, detail) => Promise<boolean>, signal? }
export async function runTool(name, args, ctx) {
  return cut(String(await execTool(name, args || {}, ctx)));
}

async function execTool(name, args, ctx) {
  const { root } = ctx;

  switch (name) {
    case 'list_files': {
      const dir = resolveSafe(root, args.path);
      const out = [];
      await walk(root, dir, 1, Number(args.depth) || 3, out);
      return out.length ? out.join('\n') : '(folder kosong atau tidak ditemukan)';
    }

    case 'read_file': {
      const file = resolveSafe(root, args.path);
      const text = await readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, Number(args.offset) || 1);
      const end = Math.min(lines.length, start - 1 + (Number(args.limit) || 400));
      if (start > lines.length) return `File hanya punya ${lines.length} baris.`;
      const body = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}  ${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l}`)
        .join('\n');
      const more =
        end < lines.length ? `\n…(${lines.length - end} baris lagi, gunakan offset=${end + 1})` : '';
      return body + more;
    }

    case 'write_file': {
      const file = resolveSafe(root, args.path);
      const content = String(args.content ?? '');
      const exists = existsSync(file);
      console.log(c.yellow(`\n✎ ${exists ? 'Timpa' : 'Buat'} file: ${args.path}`));
      showDiff('', content, 25);
      if (!(await ctx.confirm('edit', args.path))) return 'Ditolak oleh pengguna.';
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      return `OK: ${args.path} ditulis (${content.split('\n').length} baris)`;
    }

    case 'edit_file': {
      const file = resolveSafe(root, args.path);
      const text = await readFile(file, 'utf8');
      let oldStr = String(args.old_str ?? '');
      let newStr = String(args.new_str ?? '');
      if (!oldStr) return 'Gagal: old_str kosong. Untuk file baru gunakan write_file.';
      // File CRLF (Windows) sementara LLM biasanya mengirim "\n".
      if (!text.includes(oldStr) && text.includes('\r\n')) {
        oldStr = oldStr.replace(/\r?\n/g, '\r\n');
        newStr = newStr.replace(/\r?\n/g, '\r\n');
      }
      const count = text.split(oldStr).length - 1;
      if (count === 0)
        return 'Gagal: old_str tidak ditemukan di file. Baca ulang file dengan read_file lalu salin teks persis (termasuk spasi/indentasi, tanpa nomor baris).';
      if (count > 1)
        return `Gagal: old_str muncul ${count} kali. Tambahkan beberapa baris konteks di sekitarnya agar unik.`;
      console.log(c.yellow(`\n✎ Edit file: ${args.path}`));
      showDiff(args.old_str, args.new_str);
      if (!(await ctx.confirm('edit', args.path))) return 'Ditolak oleh pengguna.';
      // Replacer function: karakter "$" di new_str tidak diinterpretasi sebagai pola.
      await writeFile(file, text.replace(oldStr, () => newStr), 'utf8');
      return `OK: ${args.path} diperbarui`;
    }

    case 'search_code': {
      const dir = resolveSafe(root, args.path);
      let re;
      try {
        re = new RegExp(String(args.pattern ?? ''), 'i');
      } catch (e) {
        return `Regex tidak valid: ${e.message}`;
      }
      const files = [];
      await walk(root, dir, 1, 20, files, 5000);
      const hits = [];
      for (const rel of files) {
        if (hits.length >= MAX_HITS) break;
        if (rel.endsWith('/')) continue;
        const full = path.join(root, rel);
        try {
          if ((await stat(full)).size > 1_000_000) continue; // lewati file besar
          const text = await readFile(full, 'utf8');
          if (text.includes('\0')) continue; // lewati file binary
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
            if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        } catch {}
      }
      const note = hits.length >= MAX_HITS ? `\n…(dibatasi ${MAX_HITS} hasil, persempit pencarian)` : '';
      return hits.length ? hits.join('\n') + note : 'Tidak ada hasil.';
    }

    case 'run_command': {
      const command = String(args.command ?? '').trim();
      if (!command) return 'Gagal: command kosong.';
      console.log(c.yellow(`\n$ ${command}`));
      if (!(await ctx.confirm('command', command))) return 'Ditolak oleh pengguna.';
      const timeout = (Number(args.timeout) || 120) * 1000;
      return await new Promise((resolve) => {
        exec(
          command,
          { cwd: root, timeout, maxBuffer: 10 * 1024 * 1024, signal: ctx.signal, windowsHide: true },
          (err, stdout, stderr) => {
            const out = cleanOutput([stdout, stderr].filter(Boolean).join('\n')).trim();
            if (out) console.log(c.gray(truncate(out, 800)));
            let code = 0;
            if (err) code = err.name === 'AbortError' ? 'dibatalkan' : err.killed ? 'timeout' : err.code ?? 1;
            resolve(`exit code: ${code}\n${out || '(tidak ada output)'}`);
          },
        );
      });
    }

    default:
      return `Tool tidak dikenal: ${name}`;
  }
}
