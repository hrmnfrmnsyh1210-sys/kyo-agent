// Mock server OpenAI-compatible untuk pengujian kyo-agent.
// Mengirim respons SSE yang sengaja dipecah-pecah: teks per beberapa karakter,
// argumen tool_calls per potongan, dan byte SSE dipotong di tengah baris.
//
// Pemakaian:
//   const mock = await startMockServer((body, n) => ({ text: 'halo' }));
//   mock.url        -> base URL (http://127.0.0.1:port/v1)
//   mock.requests   -> daftar { body, headers } yang diterima
//   await mock.close();
//
// Handler mengembalikan salah satu:
//   { text, toolCalls: [{ name, args, id? }], noIndex?, delay? }
//   { status, body }  -> respons error
// Opsi { models: ['a', 'b'] } mengaktifkan GET /models.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const pieces = (s, n) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildChunks(reply, body) {
  const wantUsage = body.stream_options?.include_usage;
  const chunks = [];
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: 'mock' };
  const delta = (d, finish = null) => ({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });

  chunks.push(delta({ role: 'assistant', content: '' }));
  if (reply.text) for (const p of pieces(reply.text, 4)) chunks.push(delta({ content: p }));

  const calls = (reply.toolCalls || []).map((tc, i) => ({
    id: tc.id || `call_mock_${i}_${Math.random().toString(36).slice(2, 8)}`,
    name: tc.name,
    args: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
  }));

  if (reply.noIndex) {
    // Provider tanpa "index": potongan pertama membawa id, sisanya tanpa id/index.
    for (const call of calls) {
      chunks.push(delta({ tool_calls: [{ id: call.id, type: 'function', function: { name: call.name } }] }));
      for (const p of pieces(call.args, 5)) chunks.push(delta({ tool_calls: [{ function: { arguments: p } }] }));
    }
  } else {
    // Format OpenAI standar: semua header dulu, lalu argumen diselang-seling antar index.
    calls.forEach((call, index) =>
      chunks.push(
        delta({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }),
      ),
    );
    const parts = calls.map((call) => pieces(call.args, 5));
    const max = Math.max(0, ...parts.map((p) => p.length));
    for (let k = 0; k < max; k++) {
      parts.forEach((p, index) => {
        if (p[k] !== undefined) chunks.push(delta({ tool_calls: [{ index, function: { arguments: p[k] } }] }));
      });
    }
  }

  chunks.push(delta({}, calls.length ? 'tool_calls' : 'stop'));
  // Format OpenAI: chunk terakhir tanpa choices, berisi usage (jika diminta lewat stream_options).
  if (wantUsage) {
    const prompt_tokens = Math.ceil(JSON.stringify(body.messages).length / 4);
    chunks.push({
      ...base,
      choices: [],
      usage: { prompt_tokens, completion_tokens: 7, total_tokens: prompt_tokens + 7, prompt_tokens_details: { cached_tokens: 3 } },
    });
  }
  return chunks;
}

export function startMockServer(handler, { models } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models') && models) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const n = requests.length;
    requests.push({ body, headers: req.headers });

    let reply;
    try {
      reply = (await handler(body, n)) || { text: '' };
    } catch (err) {
      reply = { status: 500, body: { error: { message: err.message } } };
    }

    if (reply.status) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? { error: { message: 'error' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (reply.delay) await sleep(reply.delay);
    const sse =
      buildChunks(reply, body)
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n';
    // Kirim byte demi byte-kelompok kecil agar baris SSE terpotong di tengah.
    for (const p of pieces(sse, 37)) {
      if (res.destroyed) return;
      res.write(p);
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// Jalankan langsung untuk mencoba kyo tanpa API key sungguhan:
//   node test/mock-server.js
//   KYO_BASE_URL=<url> KYO_API_KEY=x KYO_MODEL=mock kyo
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockServer((body) => {
    const last = body.messages.at(-1);
    if (last.role === 'user') return { text: 'Saya lihat dulu struktur proyeknya.', toolCalls: [{ name: 'list_files', args: { depth: 1 } }] };
    return { text: `Hasil tool:\n${String(last.content).slice(0, 300)}` };
  });
  console.log(`Mock server berjalan di ${mock.url}`);
}
