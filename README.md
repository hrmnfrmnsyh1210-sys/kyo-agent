# kyo-agent

Coding agent CLI ringan ala Claude Code, dengan LLM pilihan sendiri.

- **Tanpa dependency.** Cukup Node.js 18+, tanpa `npm install` dan tanpa build step.
- **Satu klien untuk semua provider** yang berformat OpenAI-compatible (`/chat/completions`): OpenAI, Anthropic (Claude), Gemini, Groq, DeepSeek, OpenRouter, SumoPod, Ollama (lokal/offline), atau server custom.
- **Bisa dipakai di folder mana pun** dengan perintah global `kyo`. Agent hanya bisa mengakses folder tempat `kyo` dipanggil.
- Berjalan di Windows, Linux, dan macOS.

## Instalasi

```bash
git clone <repo> kyo-agent
cd kyo-agent
npm link          # atau: npm install -g .
kyo setup         # pilih provider, model, dan isi API key
```

Jika config belum ada, `kyo` otomatis masuk ke setup saat pertama kali dijalankan.

### Konfigurasi

Config disimpan di `~/.kyo-agent/config.json` (permission `0600`):

```json
{
  "provider": "openrouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen3-coder",
  "apiKey": "sk-or-...",
  "maxSteps": 30
}
```

Environment variable menimpa isi config:

| Variabel | Fungsi |
|---|---|
| `KYO_PROVIDER` | Nama preset; otomatis memakai base URL & model bawaan preset tersebut |
| `KYO_BASE_URL` | Base URL API (tanpa `/chat/completions`) |
| `KYO_API_KEY` | API key |
| `KYO_MODEL` | Nama model |
| `KYO_MAX_STEPS` | Batas langkah agent per permintaan (default 30) |
| `KYO_MAX_TOKENS` | Batas token jawaban per request (default: bawaan provider) |
| `KYO_CONTEXT_BUDGET` | Perkiraan token riwayat sebelum output tool lama dipangkas (default 32000, `0` = matikan) |
| `NO_COLOR` | Matikan warna |

Field `maxTokens` dan `contextBudget` juga bisa ditulis langsung di `config.json`.

### Preset provider

| Preset | Base URL | Contoh model |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| `anthropic` | `https://api.anthropic.com/v1` | `claude-sonnet-5-5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| `groq` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `openrouter` | `https://openrouter.ai/api/v1` | `qwen/qwen3-coder` |
| `sumopod` | `https://ai.sumopod.com/v1` | `gpt-4o-mini` |
| `ollama` | `http://localhost:11434/v1` | `qwen2.5-coder:7b` (tanpa API key) |
| `custom` | isi sendiri | isi sendiri |

Pilih model yang mendukung *tool calling*. Untuk Ollama, jalankan dulu `ollama pull <model>` dan pastikan `ollama serve` aktif.

## Pemakaian

```bash
cd D:\proyek\aplikasi-saya
kyo                                               # mode interaktif (REPL)
kyo "tambahkan validasi email di form register"   # satu tugas lalu keluar
kyo -m claude-sonnet-5                            # pakai model lain untuk sesi ini saja
kyo models                                        # daftar model yang tersedia di provider
kyo --yolo "perbaiki test yang gagal"             # tanpa konfirmasi (hati-hati)
kyo setup                                         # atur ulang provider/model/API key
```

| Opsi | Fungsi |
|---|---|
| `-m, --model <nama>` | Pakai model ini untuk sesi ini saja (default tidak berubah) |
| `-y, --yolo` | Lewati semua konfirmasi |
| `-h, --help` | Bantuan |

### Perintah di mode interaktif

| Perintah | Fungsi |
|---|---|
| `/help` | Bantuan |
| `/clear` | Hapus riwayat percakapan (system prompt tetap) |
| `/compact` | Ringkas riwayat jadi satu pesan agar request berikutnya lebih hemat |
| `/tokens` | Pemakaian token sesi ini & perkiraan ukuran konteks |
| `/model` | Pilih model dari daftar provider (nomor atau nama) |
| `/model <nama>` | Ganti model langsung |
| `/yolo` | Nyalakan/matikan konfirmasi |
| `/config` | Tampilkan lokasi file config |
| `/exit` | Keluar |

### Ganti-ganti model

Model aktif selalu tampil di prompt, misalnya `gpt-4o-mini › `. Ketik `/model` untuk memilih dari daftar:

```
gpt-4o-mini › /model
Model tersedia (61):
     1. claude-haiku-4-5
     2. claude-opus-5
     ...
  ● 27. gpt-4o-mini
     ...
Pilih model [nomor/nama, Enter = batal]: 2
✔ Model: claude-opus-5 (disimpan sebagai default)
claude-opus-5 ›
```

- Model yang dipilih lewat `/model` (dan saat `kyo setup`) disimpan ke config, jadi tetap dipakai saat kyo dibuka lagi. Riwayat percakapan tidak hilang saat ganti model.
- `kyo -m <nama>` hanya berlaku untuk satu sesi.
- Daftar diambil dari `GET /models` milik provider. Model embedding, gambar, dan audio disembunyikan. Jika provider tidak menyediakan daftar, ketik nama model langsung: `/model <nama>`.
- Jika `KYO_MODEL` diset, env var itu tetap menang saat kyo dibuka lagi.

**Ctrl+C** saat agent bekerja membatalkan permintaan itu; giliran yang dibatalkan dihapus dari riwayat. Saat idle, Ctrl+C keluar dari kyo.

Jika batas langkah tercapai, ketik `lanjutkan` agar agent meneruskan pekerjaannya.

### Perizinan

Sebelum `write_file`, `edit_file`, dan `run_command`, kyo menampilkan diff atau perintahnya lalu bertanya:

```
Terapkan perubahan? [y]a / [n]o / [a]lways
```

- `y` / Enter: izinkan sekali
- `n`: tolak (agent menerima pesan "Ditolak oleh pengguna.")
- `a`: selalu izinkan jenis aksi itu (edit atau perintah) selama sesi

## Tools yang dimiliki agent

| Tool | Parameter | Fungsi | Perlu izin |
|---|---|---|---|
| `list_files` | `path?`, `depth?` (3) | Struktur folder rekursif; mengabaikan `node_modules`, `.git`, `vendor`, `dist`, `build`, dll. | Tidak |
| `read_file` | `path`, `offset?`, `limit?` (400) | Baca file dengan nomor baris | Tidak |
| `search_code` | `pattern`, `path?` | Regex case-insensitive, maks 100 hasil, format `file:baris: isi` | Tidak |
| `edit_file` | `path`, `old_str`, `new_str` | Ganti potongan teks yang persis & unik (diff ditampilkan) | Ya |
| `write_file` | `path`, `content` | Buat atau timpa file (folder induk dibuat otomatis) | Ya |
| `run_command` | `command`, `timeout?` (120 dtk) | Jalankan perintah shell di folder kerja | Ya |

Keamanan:
- Semua path divalidasi agar tidak keluar dari folder kerja, termasuk `../`, path absolut, drive lain di Windows, dan symlink/junction.
- Di Windows, perintah dijalankan lewat `cmd.exe`; di Linux/macOS lewat `/bin/sh`.

## Hemat token

Setiap langkah agent mengirim ulang seluruh riwayat ke LLM, jadi ukuran riwayat paling menentukan biaya. kyo menjaganya tetap kecil:

- **Output tool dibatasi 12.000 karakter**, dengan bagian awal & akhir dipertahankan (error biasanya di akhir log). Baris di atas 1.000 karakter (file minified) dipotong.
- **Output perintah dibersihkan** dari kode warna ANSI dan progress bar.
- **Pemangkasan otomatis**: jika riwayat melewati `contextBudget`, output tool lama diganti cuplikan pendek; 4 hasil tool terbaru tetap utuh. Pemangkasan dilakukan sekaligus (tidak tiap langkah) agar *prompt caching* provider tetap efektif.
- **`/compact`** meringkas seluruh percakapan menjadi satu pesan, cocok sebelum pindah ke tugas berikutnya di sesi yang sama. Untuk tugas yang tidak berhubungan, `/clear` lebih hemat lagi.
- **Pemakaian token ditampilkan** setelah tiap tugas (`↑input ↓output (cache)`) dan lewat `/tokens`, jika provider melaporkannya.
- System prompt mengarahkan agent untuk membaca seperlunya dan memanggil beberapa tool sekaligus, sehingga jumlah langkah (round-trip) berkurang.

## Aturan per proyek (AGENT.md)

Buat `AGENT.md` (atau `KYO.md` / `CLAUDE.md`) di root proyek. Isinya otomatis ditambahkan ke system prompt. Contoh:

```md
# Proyek: Toko Online

- Stack: Laravel 11 + Inertia + Vue 3, database MySQL.
- Gaya kode: PSR-12 untuk PHP, Prettier (2 spasi, tanpa titik koma) untuk JS/Vue.
- Komentar dan pesan commit dalam Bahasa Indonesia.
- Setelah mengubah PHP, jalankan `php artisan test`.
- Setelah mengubah frontend, jalankan `npm run build` (jangan `npm run dev`).
- Jangan ubah file di `database/migrations` yang sudah ada; buat migration baru.
```

## Menambah tool baru

Semua tool ada di `src/tools.js`. Contoh menambah tool `git_diff`:

1. Tambahkan skemanya ke array `toolSchemas`:

   ```js
   {
     type: 'function',
     function: {
       name: 'git_diff',
       description: 'Tampilkan perubahan yang belum di-commit (git diff).',
       parameters: {
         type: 'object',
         properties: { path: { type: 'string', description: 'File/folder opsional' } },
       },
     },
   },
   ```

2. Tambahkan implementasinya sebagai `case` baru di `execTool`:

   ```js
   case 'git_diff': {
     const target = args.path ? resolveSafe(root, args.path) : root; // wajib untuk path
     return await new Promise((resolve) =>
       execFile('git', ['diff', '--', target], { cwd: root }, (err, out, errOut) =>
         resolve(out || errOut || '(tidak ada perubahan)'),
       ),
     );
   }
   ```

   (impor `execFile` dari `node:child_process`).

Hal yang perlu diperhatikan:
- Selalu lewatkan path dari LLM ke `resolveSafe(root, path)`.
- Untuk aksi yang mengubah sesuatu, panggil `await ctx.confirm('edit' | 'command', detail)` dan kembalikan `'Ditolak oleh pengguna.'` jika hasilnya `false`.
- Kembalikan string. Pemotongan 20.000 karakter dilakukan otomatis oleh `runTool`.
- Opsional: atur ringkasan baris `● nama_tool ...` di fungsi `summarize` (`src/agent.js`).

## Pengembangan & pengujian

```bash
npm test           # node --test test/kyo.test.js
npm run mock       # jalankan mock server untuk mencoba kyo tanpa API key
```

Test memakai mock server OpenAI-compatible (`test/mock-server.js`) yang mengirim SSE terpecah-pecah: teks per beberapa karakter, argumen `tool_calls` per potongan (dengan dan tanpa `index`), dan baris SSE dipotong di tengah. Yang diuji:

- alur lengkap `list_files` → `read_file` → `edit_file` → `run_command` → jawaban akhir,
- penolakan akses di luar folder kerja (`../`, path absolut, symlink),
- jalur tolak / izinkan sekali / always / `--yolo`,
- mode satu tugas, mode interaktif (slash command, `/clear`, `/model`), dan setup pertama kali,
- error API, batas langkah, dan pembatalan (abort).

Mencoba manual dengan mock server:

```bash
npm run mock                      # catat URL yang dicetak
KYO_BASE_URL=<url> KYO_API_KEY=x KYO_MODEL=mock kyo
```

## Struktur kode

```
bin/kyo.js           entry CLI: argumen, mode interaktif, perizinan, Ctrl+C
src/agent.js         agent loop + system prompt
src/llm.js           klien streaming /chat/completions + akumulasi tool_calls
src/tools.js         skema & implementasi tools + pembatasan folder kerja
src/config.js        preset provider, load/save config, setup interaktif
src/ui.js            warna ANSI, spinner, diff
test/mock-server.js  mock server OpenAI-compatible (SSE)
test/kyo.test.js     test end-to-end & unit
```

## Lisensi

MIT
