// Klien minimal untuk endpoint /chat/completions (format OpenAI) dengan streaming.
// Bekerja untuk OpenAI, Anthropic, Gemini, Groq, DeepSeek, OpenRouter, Ollama, dll.

// Ambil daftar model dari GET /models (didukung hampir semua provider OpenAI-compatible).
// Model embedding/gambar/audio disembunyikan karena tidak bisa dipakai untuk chat.
export async function listModels(config, { timeoutMs = 10_000 } = {}) {
  const url = String(config.baseUrl || '').replace(/\/+$/, '') + '/models';
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey || 'none'}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Gagal terhubung ke ${url}: ${err.cause?.code || err.cause?.message || err.message}`);
  }
  if (!res.ok) throw new Error(`Gagal mengambil daftar model (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  const list = json.data || json.models || [];
  return [...new Set(list.map((m) => String(m.id ?? m.name ?? m).replace(/^models\//, '')))]
    .filter((id) => id && !/embed|whisper|tts|dall-e|image|moderation/i.test(id))
    .sort((a, b) => a.localeCompare(b));
}

// Base URL yang menolak stream_options; setelah sekali gagal, tidak dikirim lagi.
const noStreamOptions = new Set();

// Samakan format usage dari berbagai provider. cached = token prompt yang kena cache (lebih murah).
function normalizeUsage(u) {
  return {
    input: Number(u.prompt_tokens ?? u.input_tokens) || 0,
    output: Number(u.completion_tokens ?? u.output_tokens) || 0,
    cached:
      Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens) || 0,
  };
}

export async function chat({ config, messages, tools, onText, signal }) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const url = baseUrl + '/chat/completions';
  const body = { model: config.model, messages, stream: true };
  if (tools?.length) Object.assign(body, { tools, tool_choice: 'auto' });
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  // Minta laporan pemakaian token di akhir stream.
  const wantUsage = !noStreamOptions.has(baseUrl);
  if (wantUsage) body.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${config.apiKey || 'none'}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`Gagal terhubung ke ${url}: ${err.cause?.code || err.cause?.message || err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || text;
      if (Array.isArray(j) && j[0]?.error?.message) detail = j[0].error.message; // format Gemini
    } catch {}
    // Provider lama yang tidak mengenal stream_options: ulangi sekali tanpa field itu.
    if (wantUsage && res.status === 400 && /stream_options|include_usage/i.test(detail)) {
      noStreamOptions.add(baseUrl);
      return chat({ config, messages, tools, onText, signal });
    }
    throw new Error(`LLM error ${res.status} ${res.statusText}: ${String(detail).slice(0, 500)}`);
  }

  let content = '';
  const calls = []; // diakumulasi dari potongan-potongan delta
  let usage = null;

  const handle = (json) => {
    if (json.error) throw new Error(`LLM error: ${json.error.message || JSON.stringify(json.error)}`);
    if (json.usage) usage = normalizeUsage(json.usage);
    const choice = json.choices?.[0];
    // Delta (streaming) atau message (provider yang mengabaikan stream: true).
    const delta = choice?.delta || choice?.message;
    if (!delta) return;

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }

    for (const tc of delta.tool_calls || []) {
      let idx;
      if (typeof tc.index === 'number') idx = tc.index;
      else if (tc.id) {
        // Provider tanpa "index": pakai id sebagai cadangan.
        idx = calls.findIndex((x) => x?.id === tc.id);
        if (idx === -1) idx = calls.length;
      } else idx = Math.max(0, calls.length - 1); // lanjutan potongan terakhir

      calls[idx] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      const call = calls[idx];
      if (tc.id) call.id = tc.id;
      const name = tc.function?.name;
      if (name && call.function.name !== name) call.function.name += name;
      const args = tc.function?.arguments;
      if (args) call.function.arguments += typeof args === 'string' ? args : JSON.stringify(args);
    }
  };

  const isSSE = (res.headers.get('content-type') || '').includes('event-stream');
  if (!isSSE) {
    handle(JSON.parse(await res.text()));
  } else {
    const decoder = new TextDecoder();
    let buffer = '';
    const processLine = (raw) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      handle(json);
    };

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // sisa baris yang belum lengkap
      lines.forEach(processLine);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
  }

  const toolCalls = calls
    .filter((tc) => tc && tc.function.name)
    .map((tc, i) => ({
      ...tc,
      id: tc.id || `call_${Date.now()}_${i}`,
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
    }));

  return { content, toolCalls, usage };
}
