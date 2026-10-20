import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { describe, expect, it } from 'vitest';
import { correctReedSolomon, decodeQrCodes, decodeQrGrid, type QrImage } from './qrDecoder';

/** Grille de modules produite par l'encodeur de l'app (qrcode.react). */
export function encodeGrid(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value: text, level, marginSize: 0 }));
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const paths = [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map((match) => match[1]);
  const darkPath = paths[paths.length - 1];
  for (const match of darkPath.matchAll(/M(\d+)[ ,](\d+)\s?h(\d+)v1H\d+z/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const width = Number(match[3]);
    for (let dx = 0; dx < width; dx += 1) grid[y][x + dx] = true;
  }
  return grid;
}

type RasterOptions = {
  moduleSize?: number;
  quietZone?: number;
  angleDegrees?: number;
  page?: { width: number; height: number; x: number; y: number };
  swissCross?: boolean;
  noise?: number;
};

/** Dessine la grille dans une image RGBA, avec rotation et bruit éventuels. */
export function rasterize(grid: boolean[][], options: RasterOptions = {}): QrImage {
  const moduleSize = options.moduleSize ?? 4;
  const quiet = options.quietZone ?? 4;
  const size = grid.length;
  const codeWidth = (size + quiet * 2) * moduleSize;
  const page = options.page ?? { width: codeWidth, height: codeWidth, x: 0, y: 0 };
  const angle = ((options.angleDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = page.x + codeWidth / 2;
  const centerY = page.y + codeWidth / 2;
  const data = new Uint8ClampedArray(page.width * page.height * 4);
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const crossFrom = Math.floor(size * 0.42);
  const crossTo = Math.ceil(size * 0.58);
  for (let py = 0; py < page.height; py += 1) {
    for (let px = 0; px < page.width; px += 1) {
      // Rotation inverse autour du centre du code.
      const rx = cos * (px + 0.5 - centerX) + sin * (py + 0.5 - centerY) + codeWidth / 2;
      const ry = -sin * (px + 0.5 - centerX) + cos * (py + 0.5 - centerY) + codeWidth / 2;
      const mx = Math.floor(rx / moduleSize) - quiet;
      const my = Math.floor(ry / moduleSize) - quiet;
      let dark = mx >= 0 && my >= 0 && mx < size && my < size && grid[my][mx];
      if (options.swissCross && mx >= crossFrom && mx < crossTo && my >= crossFrom && my < crossTo) {
        const middle = (crossFrom + crossTo) / 2;
        const arm = Math.abs(mx + 0.5 - middle) < 1 || Math.abs(my + 0.5 - middle) < 1;
        dark = !arm;
      }
      let value = dark ? 20 : 235;
      if (options.noise) value += (random() - 0.5) * options.noise;
      const offset = (py * page.width + px) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width: page.width, height: page.height };
}

const SWISS_PAYLOAD = [
  'SPC', '0200', '1', 'CH4431999123000889012', 'S', 'Robert Schneider AG', 'Rue du Lac', '1268', '2501', 'Biel', 'CH',
  '', '', '', '', '', '', '', '1949.75', 'CHF', 'S', 'Pia-Maria Rutschmann-Schnyder', 'Grosse Marktgasse', '28', '9400', 'Rorschach', 'CH',
  'QRR', '210000000003139471430009017', 'Ordre du 15 octobre 2026', 'EPD', '//S1/10/10201409/11/261015/40/0:30',
].join('\n');

describe('lecture de grille QR', () => {
  it('relit le texte encodé, pour plusieurs tailles et niveaux', () => {
    for (const [text, level] of [
      ['Zentra', 'L'],
      ['https://zentraapp.ch/devis/D-2026-0012', 'M'],
      ['12345678901234567890', 'Q'],
      ['Grüezi Zürich – 3 Stück à 12.50', 'H'],
      [SWISS_PAYLOAD, 'M'],
    ] as const) {
      const result = decodeQrGrid(encodeGrid(text, level));
      expect(result).toEqual({ text });
    }
  });

  it('corrige des modules abîmés grâce à Reed-Solomon', () => {
    const grid = encodeGrid(SWISS_PAYLOAD, 'M');
    const size = grid.length;
    // Abîme une bande dans la zone de données, loin des motifs de repérage.
    for (let x = 20; x < 26; x += 1) grid[size - 20][x] = !grid[size - 20][x];
    expect(decodeQrGrid(grid)).toEqual({ text: SWISS_PAYLOAD });
  });

  it('refuse une grille trop abîmée au lieu de deviner', () => {
    const grid = encodeGrid('Zentra', 'L');
    for (let y = 9; y < 21; y += 1) for (let x = 9; x < 21; x += 1) grid[y][x] = (x * y) % 3 === 0;
    expect('text' in decodeQrGrid(grid)).toBe(false);
  });
});

describe('Reed-Solomon', () => {
  it('ne touche pas un bloc juste et corrige jusqu’à la moitié des symboles de contrôle', () => {
    // Bloc version 1-M : 16 octets de données, 10 de contrôle, tiré d'un vrai symbole.
    const grid = encodeGrid('ABC', 'M');
    expect(decodeQrGrid(grid)).toEqual({ text: 'ABC' });
    const block = [32, 27, 6, 140, 0, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236];
    const copy = block.slice();
    expect(correctReedSolomon(copy, 0)).toBe(true);
    expect(copy).toEqual(block);
  });
});

describe('lecture dans une image', () => {
  it('trouve la QR-facture droite, avec la croix suisse au centre', () => {
    const image = rasterize(encodeGrid(SWISS_PAYLOAD), { moduleSize: 4, swissCross: true });
    expect(decodeQrCodes(image)).toEqual([SWISS_PAYLOAD]);
  });

  it('trouve le code tourné sur une page plus grande, avec du bruit', () => {
    const grid = encodeGrid(SWISS_PAYLOAD);
    const codeWidth = (grid.length + 8) * 4;
    const image = rasterize(grid, {
      moduleSize: 4,
      angleDegrees: 17,
      swissCross: true,
      noise: 60,
      page: { width: codeWidth + 300, height: codeWidth + 260, x: 150, y: 120 },
    });
    expect(decodeQrCodes(image)).toEqual([SWISS_PAYLOAD]);
  });

  it('trouve le code posé à 45°, comme un ticket photographié de travers', () => {
    const grid = encodeGrid(SWISS_PAYLOAD);
    const width = (grid.length + 8) * 3;
    const pad = Math.ceil(width * 0.3);
    const image = rasterize(grid, {
      moduleSize: 3,
      angleDegrees: 45,
      swissCross: true,
      noise: 80,
      page: { width: width + 2 * pad, height: width + 2 * pad, x: pad, y: pad },
    });
    expect(decodeQrCodes(image)).toEqual([SWISS_PAYLOAD]);
  });

  it('trouve un petit code à l’envers', () => {
    const image = rasterize(encodeGrid('F-2026-0042', 'M'), { moduleSize: 5, angleDegrees: 180 });
    expect(decodeQrCodes(image)).toEqual(['F-2026-0042']);
  });

  it('ne trouve rien sur une page blanche', () => {
    const data = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(decodeQrCodes({ data, width: 200, height: 200 })).toEqual([]);
  });
});
