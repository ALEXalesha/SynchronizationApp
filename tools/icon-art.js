'use strict';
// Рисунок значка SyncGlass (SVG) и упаковка в ICO - общее для tools/make-icon.js и тестов.
// Скруглённый квадрат цвета акцента окна (#5B7FA6) со стеклянным бликом и две белые стрелки
// по кругу - синхронизация в обе стороны. Для 16-24 px рисунок проще: без стеклянного
// диска, линии толще, иначе в панели задач стрелки сливаются в кашу.

const SIZES = [256, 128, 64, 48, 32, 24, 16];

// Точка на окружности; угол по часовой стрелке от оси x (ось y экрана - вниз).
function at(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// Дуга от from до to по часовой стрелке с треугольной стрелкой на конце.
function arrow(c, r, from, to, stroke, head) {
  // Дуга кончается чуть раньше острия, чтобы её торец не выглядывал из-под стрелки.
  const cut = ((head * 0.55) / r) * (180 / Math.PI);
  const [x0, y0] = at(c, c, r, from);
  const [x1, y1] = at(c, c, r, to - cut);
  const large = to - cut - from > 180 ? 1 : 0;
  const [ex, ey] = at(c, c, r, to);
  const a = (to * Math.PI) / 180;
  const t = [-Math.sin(a), Math.cos(a)]; // касательная по ходу дуги
  const n = [Math.cos(a), Math.sin(a)]; // наружу от центра
  const w = head * 0.62;
  const tip = [ex + t[0] * head * 0.55, ey + t[1] * head * 0.55];
  const b1 = [ex - t[0] * head * 0.45 + n[0] * w, ey - t[1] * head * 0.45 + n[1] * w];
  const b2 = [ex - t[0] * head * 0.45 - n[0] * w, ey - t[1] * head * 0.45 - n[1] * w];
  const f = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  return (
    `<path d="M${f([x0, y0])} A${r},${r} 0 ${large} 1 ${f([x1, y1])}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round"/>` +
    `<path d="M${f(tip)} L${f(b1)} L${f(b2)} Z" fill="#fff" stroke="#fff" stroke-width="${(stroke * 0.25).toFixed(2)}" stroke-linejoin="round"/>`
  );
}

function svg(size) {
  const S = 256;
  const c = S / 2;
  const small = size <= 24;
  const rx = S * 0.225;
  const r = small ? S * 0.29 : S * 0.255;
  const stroke = small ? S * 0.13 : S * 0.085;
  const head = small ? S * 0.27 : S * 0.2;
  const glass = small
    ? ''
    : `<circle cx="${c}" cy="${c}" r="${S * 0.37}" fill="url(#disc)" stroke="rgba(255,255,255,0.38)" stroke-width="${S * 0.012}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${S} ${S}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7196C0"/><stop offset="1" stop-color="#34506F"/>
  </linearGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.30"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="disc" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="1" stop-color="#fff" stop-opacity="0.06"/>
  </linearGradient>
  <clipPath id="box"><rect width="${S}" height="${S}" rx="${rx}"/></clipPath>
</defs>
<rect width="${S}" height="${S}" rx="${rx}" fill="url(#bg)"/>
<g clip-path="url(#box)"><ellipse cx="${c}" cy="${S * 0.02}" rx="${S * 0.78}" ry="${S * 0.5}" fill="url(#sheen)"/></g>
${small ? '' : `<rect x="${S * 0.006}" y="${S * 0.006}" width="${S * 0.988}" height="${S * 0.988}" rx="${rx * 0.97}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="${S * 0.012}"/>`}
${glass}
${arrow(c, r, 200, 335, stroke, head)}
${arrow(c, r, 20, 155, stroke, head)}
</svg>`;
}

// ICO с PNG внутри (Windows Vista и новее); 256 записывается как 0.
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p[1])]);
}

module.exports = { svg, ico, SIZES };
