// Utilitas tampilan terminal tanpa dependency (pakai kode warna ANSI).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

// Warna 24-bit (fallback ke 256 warna) untuk gradient.
const depth = useColor ? (process.stdout.getColorDepth?.() ?? 4) : 1;
const to256 = (r, g, b) => 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
export const rgb = (r, g, b) => (s) => {
  if (depth >= 24) return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
  if (depth >= 8) return `\x1b[38;5;${to256(r, g, b)}m${s}\x1b[0m`;
  return c.cyan(s);
};

// Palet kyo: cyan → indigo → ungu → pink. accent(t) mengambil warna di posisi t (0..1).
const PALETTE = [
  [34, 211, 238],
  [129, 140, 248],
  [192, 132, 252],
  [244, 114, 182],
];
export const accent = (t = 0) => {
  const x = Math.min(Math.max(t, 0), 1) * (PALETTE.length - 1);
  const i = Math.min(Math.floor(x), PALETTE.length - 2);
  const f = x - i;
  return rgb(...PALETTE[i].map((v, k) => Math.round(v + (PALETTE[i + 1][k] - v) * f)));
};

// Warnai teks per karakter mengikuti gradient; offset menggeser warna (efek diagonal).
export function gradient(text, offset = 0) {
  const chars = [...String(text)];
  if (!useColor) return chars.join('');
  const span = Math.max(chars.length - 1, 1);
  return chars.map((ch, i) => (ch === ' ' ? ch : accent((i / span) * 0.8 + offset)(ch))).join('');
}

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const visibleWidth = (s) => [...stripAnsi(s)].length;
const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - visibleWidth(s)));

// Potong teks panjang di tengah: D:\proj\…\folder
export function middleTruncate(str, max) {
  const s = String(str);
  if (s.length <= max) return s;
  const keep = max - 1;
  return s.slice(0, Math.ceil(keep / 2)) + '…' + s.slice(s.length - Math.floor(keep / 2));
}

const termWidth = () => Math.min(process.stdout.columns || 80, 100);

// Kotak bersudut bulat di sekeliling baris-baris teks.
export function box(lines, { width, border = c.gray } = {}) {
  const inner = width ?? Math.max(...lines.map(visibleWidth)) + 4;
  const body = lines.map((l) => border('│') + padEnd('  ' + l, inner) + border('│'));
  return [border('╭' + '─'.repeat(inner) + '╮'), ...body, border('╰' + '─'.repeat(inner) + '╯')].join('\n');
}

const LOGO = [
  '██╗  ██╗██╗   ██╗ ██████╗ ',
  '██║ ██╔╝╚██╗ ██╔╝██╔═══██╗',
  '█████╔╝  ╚████╔╝ ██║   ██║',
  '██╔═██╗   ╚██╔╝  ██║   ██║',
  '██║  ██╗   ██║   ╚██████╔╝',
  '╚═╝  ╚═╝   ╚═╝    ╚═════╝ ',
];

function greeting() {
  const h = new Date().getHours();
  if (h < 4) return 'Begadang lagi?';
  if (h < 11) return 'Selamat pagi!';
  if (h < 15) return 'Selamat siang!';
  if (h < 19) return 'Selamat sore!';
  return 'Selamat malam!';
}

// Tampilan awal mode interaktif: logo gradient + info sesi di dalam kotak.
export function banner({ model, provider, root, version, yolo }) {
  const cols = termWidth();
  const wide = cols >= 76; // terminal sempit: tanpa logo besar
  const valueMax = Math.max(16, wide ? cols - LOGO[0].length - 22 : cols - 20);
  const row = (t, key, value) => `${accent(t)('●')} ${c.gray(key.padEnd(9))}${value}`;
  const info = [
    gradient('kyo-agent') + c.gray(` v${version}`),
    c.dim('coding agent di terminal kamu'),
    '',
    row(0, 'model', c.bold(middleTruncate(model, valueMax))),
    row(0.33, 'provider', middleTruncate(provider || 'custom', valueMax)),
    row(0.66, 'folder', middleTruncate(root, valueMax)),
    row(1, 'mode', yolo ? c.yellow('yolo · tanpa konfirmasi') : c.green('aman · minta izin')),
  ];

  const lines = wide
    ? ['', ...LOGO.map((l, i) => gradient(l, i * 0.04) + '    ' + info[i]), ' '.repeat(LOGO[0].length + 4) + info[6], '']
    : ['', ...info, ''];
  const width = Math.min(cols - 2, Math.max(...lines.map(visibleWidth)) + 4);

  const key = (k, d) => `${accent(0.5)(k)} ${c.dim(d)}`;
  const tips = [key('/help', 'bantuan'), key('/model', 'ganti model'), key('/yolo', 'izin otomatis'), key('Ctrl+C', 'stop')];
  return [
    '',
    box(lines, { width }),
    '',
    `  ${c.bold(greeting())} ${c.dim('Ketik tugas kamu, kyo siap bantu.')}`,
    '  ' + (wide ? tips.join(c.gray('  ·  ')) : tips.slice(0, 2).join(c.gray('  ·  ')) + '\n  ' + tips.slice(2).join(c.gray('  ·  '))),
    '',
  ].join('\n');
}

// Kata-kata yang bergantian selama menunggu LLM agar tidak terasa membeku.
const PHRASES = {
  berpikir: ['berpikir', 'memahami tugas', 'menyusun rencana', 'menimbang opsi', 'merangkai ide'],
  melanjutkan: ['melanjutkan', 'mencerna hasil', 'menyusun langkah', 'meracik kode', 'memeriksa ulang'],
};
const ORBIT = ['◜', '◠', '◝', '◞', '◡', '◟'];
const BAR = 8; // lebar pita gelombang

// Teks dengan kilau yang bergerak dari kiri ke kanan.
function shimmer(text, tick) {
  if (!useColor) return text;
  const chars = [...text];
  const pos = (tick % (chars.length + 10)) - 5;
  return chars
    .map((ch, i) => {
      const d = Math.abs(i - pos);
      if (d < 1.5) return c.bold(accent(1)(ch));
      if (d < 3.5) return accent(0.55 + d * 0.05)(ch);
      return c.dim(ch);
    })
    .join('');
}

// Pita gelombang bergradasi: ▁▂▃▅▆▇
function wave(tick) {
  const levels = '▁▂▃▄▅▆▇';
  return Array.from({ length: BAR }, (_, i) => {
    const v = (Math.sin((tick - i * 1.6) / 3) + 1) / 2;
    return accent(i / (BAR - 1))(levels[Math.round(v * (levels.length - 1))]);
  }).join('');
}

// Pastikan kursor muncul lagi walau proses keluar saat spinner berjalan.
if (process.stdout.isTTY) process.on('exit', () => process.stdout.write('\x1b[?25h'));

// Ikon & warna per tool untuk baris log aksi agent.
const TOOL_STYLE = {
  list_files: ['▤', 0],
  read_file: ['◉', 0.25],
  search_code: ['⌕', 0.4],
  edit_file: ['✎', 0.7],
  write_file: ['✚', 0.85],
  run_command: ['❯', 1],
};
export function toolLabel(name) {
  const [icon, t] = TOOL_STYLE[name] || ['●', 0.5];
  return accent(t)(`${icon} ${name}`);
}

const fmtTime =(s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`);

export function createSpinner(text = 'berpikir') {
  const phrases = PHRASES[text] || [text];
  let i = 0;
  let timer = null;
  let t0 = 0;
  return {
    start() {
      if (!process.stdout.isTTY || timer) return;
      t0 = Date.now();
      process.stdout.write('\x1b[?25l'); // sembunyikan kursor
      timer = setInterval(() => {
        const secs = Math.floor((Date.now() - t0) / 1000);
        const phrase = phrases[Math.floor(secs / 3) % phrases.length];
        const orbit = accent(Math.abs(((i / 20) % 2) - 1))(ORBIT[Math.floor(i / 2) % ORBIT.length]);
        const time = secs ? c.gray(` · ${fmtTime(secs)}`) : '';
        const hint = secs >= 5 ? c.gray(' · ctrl+c batal') : '';
        process.stdout.write(`\r${orbit} ${wave(i)} ${shimmer(phrase + '…', i)}${time}${hint}\x1b[K`);
        i++;
      }, 80);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stdout.write('\r\x1b[K\x1b[?25h'); // tampilkan kursor lagi
    },
  };
}

export function truncate(str, max = 400) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max) + c.dim(` …(+${s.length - max} karakter)`) : s;
}

// Tampilkan diff sederhana: baris lama merah, baris baru hijau.
export function showDiff(oldText, newText, maxLines = 40) {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const out = [];
  for (const l of oldLines) out.push(c.red('- ' + l));
  for (const l of newLines) out.push(c.green('+ ' + l));
  const shown = out.slice(0, maxLines);
  console.log(shown.join('\n'));
  if (out.length > maxLines) console.log(c.dim(`  … ${out.length - maxLines} baris lagi`));
}
