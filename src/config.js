import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { c } from './ui.js';
import { listModels } from './llm.js';

export const CONFIG_DIR = path.join(homedir(), '.kyo-agent');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const DEFAULT_CONTEXT_BUDGET = 32_000;

// Semua provider ini memakai format API "OpenAI-compatible" (/chat/completions),
// jadi cukup satu klien untuk semuanya. Ganti nama model sesuai kebutuhan.
export const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', needKey: true },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', needKey: true },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needKey: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', needKey: true },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', needKey: true },
  sumopod: { baseUrl: 'https://ai.sumopod.com/v1', model: 'gpt-4o-mini', needKey: true },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', needKey: false },
};

export async function readConfigFile() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(c.yellow(`⚠ Config tidak bisa dibaca (${err.message}), diabaikan.`));
    return {};
  }
}

export async function loadConfig() {
  const file = await readConfigFile();
  const env = process.env;
  // Environment variable selalu menang atas file config.
  // KYO_PROVIDER saja sudah cukup untuk memakai base URL & model bawaan preset.
  const envPreset = PRESETS[env.KYO_PROVIDER] || {};
  const provider = env.KYO_PROVIDER || file.provider;
  return {
    provider,
    baseUrl: env.KYO_BASE_URL || envPreset.baseUrl || file.baseUrl,
    apiKey: env.KYO_API_KEY || file.apiKey || (provider === 'ollama' ? 'ollama' : ''),
    model: env.KYO_MODEL || envPreset.model || file.model,
    maxSteps: Number(env.KYO_MAX_STEPS || file.maxSteps) || 30,
    // Batas token jawaban per request (kosong = default provider).
    maxTokens: Number(env.KYO_MAX_TOKENS || file.maxTokens) || undefined,
    // Saat riwayat melewati perkiraan ini (token), output tool lama dipangkas. 0 = matikan.
    contextBudget: Number(env.KYO_CONTEXT_BUDGET || (file.contextBudget ?? DEFAULT_CONTEXT_BUDGET)) || 0,
  };
}

export async function saveConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => {}); // mode hanya berlaku saat file baru dibuat
}

// Ubah sebagian isi config tanpa menyentuh field lain.
export async function updateConfig(patch) {
  const cfg = { ...(await readConfigFile()), ...patch };
  await saveConfig(cfg);
  return cfg;
}

// Tampilkan daftar model bernomor lalu minta pilihan (nomor atau nama).
// Mengembalikan nama model, atau `fallback` jika pengguna menekan Enter.
export async function chooseModel(ask, models, { current, fallback } = {}) {
  const width = String(models.length).length;
  models.forEach((m, i) => {
    const mark = m === current ? c.green('●') : ' ';
    console.log(`  ${mark} ${c.cyan(String(i + 1).padStart(width))}. ${m === current ? c.bold(m) : m}`);
  });
  const hint = fallback ? `Enter = ${fallback}` : 'Enter = batal';
  while (true) {
    const ans = await ask(`Pilih model [nomor/nama, ${hint}]: `);
    if (ans === null) return fallback || null;
    const a = ans.trim();
    if (!a) return fallback || null;
    if (/^\d+$/.test(a)) {
      if (models[Number(a) - 1]) return models[Number(a) - 1];
      console.log(c.red(`Nomor harus 1–${models.length}.`));
      continue;
    }
    return a; // nama bebas, boleh model yang tidak ada di daftar
  }
}

// ask(prompt) => Promise<string|null>; null berarti input ditutup.
export async function runSetup(ask) {
  const need = async (q) => {
    const a = await ask(q);
    if (a === null) throw new Error('Setup dibatalkan.');
    return a.trim();
  };
  const prev = await readConfigFile();

  console.log(c.bold('\n⚙  Setup kyo-agent\n'));
  const names = [...Object.keys(PRESETS), 'custom'];
  names.forEach((n, i) => {
    const hint = PRESETS[n] ? PRESETS[n].model : 'base URL sendiri, OpenAI-compatible';
    console.log(`  ${c.cyan(i + 1)}. ${n} ${c.dim('(' + hint + ')')}`);
  });

  let name;
  while (!name) {
    const pick = await need('\nPilih provider [nomor/nama]: ');
    name = names[Number(pick) - 1] || (names.includes(pick.toLowerCase()) ? pick.toLowerCase() : null);
    if (!name) console.log(c.red('Pilihan tidak valid.'));
  }
  const preset = PRESETS[name] || { baseUrl: prev.baseUrl || '', model: '', needKey: true };

  let baseUrl = '';
  while (!baseUrl) baseUrl = (await need(`Base URL ${c.dim(`[${preset.baseUrl}]`)}: `)) || preset.baseUrl;

  let apiKey = 'ollama';
  if (preset.needKey) {
    const keep = prev.provider === name && prev.apiKey;
    apiKey = (await need(`API key${keep ? c.dim(' [Enter = pakai yang tersimpan]') : ''}: `)) || (keep ? prev.apiKey : '');
  }

  // Coba ambil daftar model dari provider; jika gagal, ketik nama model manual.
  let model = '';
  try {
    const models = await listModels({ baseUrl, apiKey }, { timeoutMs: 8000 });
    if (models.length) {
      console.log(c.dim(`\n${models.length} model tersedia:`));
      model = await chooseModel(need, models, { fallback: preset.model || models[0] });
    }
  } catch (err) {
    console.log(c.dim(`(daftar model tidak tersedia: ${err.message})`));
  }
  while (!model) model = (await need(`Model ${c.dim(`[${preset.model}]`)}: `)) || preset.model;

  const cfg = { provider: name, baseUrl, model, apiKey, maxSteps: prev.maxSteps || 30 };
  await saveConfig(cfg);
  console.log(c.green(`\n✔ Tersimpan di ${CONFIG_FILE}\n`));
  return cfg;
}
