// Lecture d'un code QR dans une image, sans service externe ni IA.
//
// Sert à la QR-facture suisse : l'image vient d'un PDF rendu ou d'un scan.
// Étapes : seuil adaptatif, motifs de repérage, transformation de
// perspective, lecture de la grille, puis correction Reed-Solomon et
// décodage des segments. Le symbole suisse au centre est corrigé par le
// niveau M, comme le prévoit la norme.

export type QrImage = {
  /** Pixels RGBA, 4 octets par pixel. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

type Point = { x: number; y: number };
type FinderCandidate = Point & { moduleSize: number; count: number };

// Tables de la norme ISO/IEC 18004 (mêmes valeurs que qrcodegen, MIT).
// Index du niveau : 0 = L, 1 = M, 2 = Q, 3 = H.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
// Bits de format : L = 01, M = 00, Q = 11, H = 10.
const FORMAT_BITS_TO_ECC = [1, 0, 3, 2];

// ---------------------------------------------------------------------------
// Corps de Galois GF(256), polynôme 0x11d.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division par zéro');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

function gfPow(exponent: number): number {
  return GF_EXP[((exponent % 255) + 255) % 255];
}

/** Évalue un polynôme en ordre croissant (index = degré). */
function evalAscending(poly: readonly number[], x: number): number {
  let result = 0;
  for (let i = poly.length - 1; i >= 0; i -= 1) result = gfMul(result, x) ^ poly[i];
  return result;
}

/**
 * Corrige un bloc Reed-Solomon en place. `block[0]` est le coefficient de
 * plus haut degré, comme dans le symbole. Rend false si le bloc a trop
 * d'erreurs.
 */
export function correctReedSolomon(block: number[], eccLength: number): boolean {
  const n = block.length;
  const syndromes: number[] = [];
  let hasError = false;
  for (let j = 0; j < eccLength; j += 1) {
    const alpha = gfPow(j);
    let value = 0;
    for (let i = 0; i < n; i += 1) value = gfMul(value, alpha) ^ block[i];
    syndromes.push(value);
    if (value !== 0) hasError = true;
  }
  if (!hasError) return true;

  // Berlekamp-Massey.
  let locator = [1];
  let previous = [1];
  let errors = 0;
  let shift = 1;
  let previousDiscrepancy = 1;
  for (let step = 0; step < eccLength; step += 1) {
    let discrepancy = syndromes[step];
    for (let i = 1; i <= errors; i += 1) discrepancy ^= gfMul(locator[i] ?? 0, syndromes[step - i]);
    if (discrepancy === 0) {
      shift += 1;
      continue;
    }
    const factor = gfDiv(discrepancy, previousDiscrepancy);
    const next = locator.slice();
    for (let i = 0; i < previous.length; i += 1) {
      const index = i + shift;
      while (next.length <= index) next.push(0);
      next[index] ^= gfMul(factor, previous[i]);
    }
    if (2 * errors <= step) {
      previous = locator;
      errors = step + 1 - errors;
      previousDiscrepancy = discrepancy;
      shift = 1;
    } else {
      shift += 1;
    }
    locator = next;
  }
  while (locator.length > 1 && locator[locator.length - 1] === 0) locator.pop();
  if (locator.length - 1 !== errors || 2 * errors > eccLength) return false;

  // Recherche de Chien : position de degré i en erreur si Λ(α^-i) = 0.
  const positions: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (evalAscending(locator, gfPow(-i)) === 0) positions.push(i);
  }
  if (positions.length !== errors) return false;

  // Forney, première racine α^0.
  const evaluator: number[] = new Array(eccLength).fill(0);
  for (let i = 0; i < syndromes.length; i += 1) {
    for (let k = 0; k < locator.length && i + k < eccLength; k += 1) {
      evaluator[i + k] ^= gfMul(syndromes[i], locator[k]);
    }
  }
  const derivative: number[] = [];
  for (let k = 1; k < locator.length; k += 1) derivative.push(k % 2 === 1 ? locator[k] : 0);
  for (const degree of positions) {
    const inverse = gfPow(-degree);
    const denominator = evalAscending(derivative, inverse);
    if (denominator === 0) return false;
    const magnitude = gfMul(gfPow(degree), gfDiv(evalAscending(evaluator, inverse), denominator));
    block[n - 1 - degree] ^= magnitude;
  }
  for (let j = 0; j < eccLength; j += 1) {
    const alpha = gfPow(j);
    let value = 0;
    for (let i = 0; i < n; i += 1) value = gfMul(value, alpha) ^ block[i];
    if (value !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Structure du symbole.

function sizeForVersion(version: number): number {
  return version * 4 + 17;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = sizeForVersion(version) - 7; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function functionModuleMask(version: number): boolean[][] {
  const size = sizeForVersion(version);
  const mask = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) mask[y][x] = true;
  };
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(positions[i] + dx, positions[j] + dy);
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) mark(size - 1 - i, 8);
  for (let i = 0; i < 8; i += 1) mark(8, size - 1 - i);
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return mask;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function hammingDistance(a: number, b: number): number {
  let value = a ^ b;
  let count = 0;
  while (value) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

function formatCode(data: number): number {
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function versionCode(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

function readFormat(grid: boolean[][]): { ecc: number; mask: number } | null {
  const size = grid.length;
  const bit = (x: number, y: number) => (grid[y][x] ? 1 : 0);
  let first = 0;
  let second = 0;
  const firstBits: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) firstBits.push([8, i]);
  firstBits.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i += 1) firstBits.push([14 - i, 8]);
  firstBits.forEach(([x, y], index) => { first |= bit(x, y) << index; });
  for (let i = 0; i < 8; i += 1) second |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i += 1) second |= bit(8, size - 15 + i) << i;

  let best: { ecc: number; mask: number; distance: number } | null = null;
  for (let data = 0; data < 32; data += 1) {
    const code = formatCode(data);
    const distance = Math.min(hammingDistance(code, first), hammingDistance(code, second));
    if (!best || distance < best.distance) {
      best = { ecc: FORMAT_BITS_TO_ECC[data >>> 3], mask: data & 7, distance };
    }
  }
  return best && best.distance <= 3 ? { ecc: best.ecc, mask: best.mask } : null;
}

function readVersion(grid: boolean[][]): number | null {
  const size = grid.length;
  const estimated = (size - 17) / 4;
  if (estimated < 7) return estimated;
  let first = 0;
  let second = 0;
  for (let i = 0; i < 18; i += 1) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    if (grid[b][a]) first |= 1 << i;
    if (grid[a][b]) second |= 1 << i;
  }
  let best: { version: number; distance: number } | null = null;
  for (let version = 7; version <= 40; version += 1) {
    const code = versionCode(version);
    const distance = Math.min(hammingDistance(code, first), hammingDistance(code, second));
    if (!best || distance < best.distance) best = { version, distance };
  }
  return best && best.distance <= 3 ? best.version : null;
}

// ---------------------------------------------------------------------------
// Décodage d'une grille de modules (true = module sombre).

export type QrDecodeError = 'format' | 'version' | 'correction' | 'data';

export function decodeQrGrid(grid: boolean[][]): { text: string } | { error: QrDecodeError } {
  const size = grid.length;
  if (size < 21 || (size - 17) % 4 !== 0 || grid.some((row) => row.length !== size)) return { error: 'version' };
  const format = readFormat(grid);
  if (!format) return { error: 'format' };
  const version = readVersion(grid);
  if (version === null || sizeForVersion(version) !== size) return { error: 'version' };

  const functions = functionModuleMask(version);
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const codewords: number[] = [];
  let current = 0;
  let bitCount = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (functions[y][x] || codewords.length >= rawCodewords) continue;
        const dark = grid[y][x] !== maskBit(format.mask, x, y);
        current = (current << 1) | (dark ? 1 : 0);
        bitCount += 1;
        if (bitCount === 8) {
          codewords.push(current);
          current = 0;
          bitCount = 0;
        }
      }
    }
  }
  if (codewords.length !== rawCodewords) return { error: 'data' };

  const blockCount = NUM_ERROR_CORRECTION_BLOCKS[format.ecc][version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[format.ecc][version];
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const padIndex = shortBlockLength - eccLength;
  const blocks: number[][] = Array.from({ length: blockCount }, () => new Array<number>(shortBlockLength + 1).fill(0));
  let read = 0;
  for (let i = 0; i <= shortBlockLength; i += 1) {
    for (let j = 0; j < blockCount; j += 1) {
      if (i === padIndex && j < shortBlockCount) continue;
      blocks[j][i] = codewords[read];
      read += 1;
    }
  }
  const data: number[] = [];
  for (let j = 0; j < blockCount; j += 1) {
    const block = j < shortBlockCount
      ? [...blocks[j].slice(0, padIndex), ...blocks[j].slice(padIndex + 1)]
      : blocks[j];
    if (!correctReedSolomon(block, eccLength)) return { error: 'correction' };
    data.push(...block.slice(0, block.length - eccLength));
  }
  const text = decodeSegments(data, version);
  return text === null ? { error: 'data' } : { text };
}

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function decodeSegments(data: readonly number[], version: number): string | null {
  let position = 0;
  const totalBits = data.length * 8;
  const readBits = (count: number): number | null => {
    if (position + count > totalBits) return null;
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = data[(position + i) >>> 3];
      value = (value << 1) | ((byte >>> (7 - ((position + i) & 7))) & 1);
    }
    position += count;
    return value;
  };
  const group = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const parts: string[] = [];
  let bytes: number[] = [];
  let utf8 = true;
  const flushBytes = () => {
    if (bytes.length === 0) return;
    const buffer = new Uint8Array(bytes);
    let decoded: string;
    try {
      decoded = new TextDecoder(utf8 ? 'utf-8' : 'iso-8859-1', { fatal: utf8 }).decode(buffer);
    } catch {
      decoded = new TextDecoder('iso-8859-1').decode(buffer);
    }
    parts.push(decoded);
    bytes = [];
  };
  while (position + 4 <= totalBits) {
    const mode = readBits(4);
    if (mode === null || mode === 0) break;
    if (mode === 0x7) {
      const first = readBits(8);
      if (first === null) return null;
      let designator = first;
      if ((first & 0x80) === 0) designator = first & 0x7f;
      else if ((first & 0xc0) === 0x80) {
        const next = readBits(8);
        if (next === null) return null;
        designator = ((first & 0x3f) << 8) | next;
      } else {
        const next = readBits(16);
        if (next === null) return null;
        designator = ((first & 0x1f) << 16) | next;
      }
      flushBytes();
      utf8 = designator === 26;
      continue;
    }
    if (mode === 0x1) {
      const count = readBits([10, 12, 14][group]);
      if (count === null) return null;
      flushBytes();
      let text = '';
      let left = count;
      while (left >= 3) {
        const value = readBits(10);
        if (value === null || value > 999) return null;
        text += String(value).padStart(3, '0');
        left -= 3;
      }
      if (left === 2) {
        const value = readBits(7);
        if (value === null || value > 99) return null;
        text += String(value).padStart(2, '0');
      } else if (left === 1) {
        const value = readBits(4);
        if (value === null || value > 9) return null;
        text += String(value);
      }
      parts.push(text);
      continue;
    }
    if (mode === 0x2) {
      const count = readBits([9, 11, 13][group]);
      if (count === null) return null;
      flushBytes();
      let text = '';
      let left = count;
      while (left >= 2) {
        const value = readBits(11);
        if (value === null || value >= 45 * 45) return null;
        text += ALPHANUMERIC[Math.floor(value / 45)] + ALPHANUMERIC[value % 45];
        left -= 2;
      }
      if (left === 1) {
        const value = readBits(6);
        if (value === null || value >= 45) return null;
        text += ALPHANUMERIC[value];
      }
      parts.push(text);
      continue;
    }
    if (mode === 0x4) {
      const count = readBits([8, 16, 16][group]);
      if (count === null) return null;
      for (let i = 0; i < count; i += 1) {
        const value = readBits(8);
        if (value === null) return null;
        bytes.push(value);
      }
      continue;
    }
    // Kanji, FNC1 ou mode structuré : pas utilisés par la QR-facture.
    return null;
  }
  flushBytes();
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Image : seuil adaptatif.

type BitImage = { width: number; height: number; dark: Uint8Array };

export function binarize(image: QrImage): BitImage {
  const { width, height, data } = image;
  const luminance = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luminance.length; i += 1, p += 4) {
    const alpha = data[p + 3];
    const value = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    // Un pixel transparent compte comme fond blanc.
    luminance[i] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
  }
  const dark = new Uint8Array(width * height);
  const blockSize = 8;
  const blocksX = Math.ceil(width / blockSize);
  const blocksY = Math.ceil(height / blockSize);
  if (blocksX < 5 || blocksY < 5) {
    let sum = 0;
    for (const value of luminance) sum += value;
    const threshold = sum / Math.max(1, luminance.length);
    for (let i = 0; i < luminance.length; i += 1) dark[i] = luminance[i] < threshold ? 1 : 0;
    return { width, height, dark };
  }
  const blackPoints = new Float64Array(blocksX * blocksY);
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      let sum = 0;
      let count = 0;
      let min = 255;
      let max = 0;
      const yEnd = Math.min(height, (by + 1) * blockSize);
      const xEnd = Math.min(width, (bx + 1) * blockSize);
      for (let y = by * blockSize; y < yEnd; y += 1) {
        for (let x = bx * blockSize; x < xEnd; x += 1) {
          const value = luminance[y * width + x];
          sum += value;
          count += 1;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      let average = sum / count;
      if (max - min <= 24) {
        // Bloc uniforme : fond clair supposé, sauf si les voisins disent sombre.
        average = min / 2;
        if (by > 0 && bx > 0) {
          const neighbours = (blackPoints[(by - 1) * blocksX + bx] + 2 * blackPoints[by * blocksX + bx - 1] + blackPoints[(by - 1) * blocksX + bx - 1]) / 4;
          if (min < neighbours) average = neighbours;
        }
      }
      blackPoints[by * blocksX + bx] = average;
    }
  }
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      let sum = 0;
      let count = 0;
      for (let ny = Math.max(0, by - 2); ny <= Math.min(blocksY - 1, by + 2); ny += 1) {
        for (let nx = Math.max(0, bx - 2); nx <= Math.min(blocksX - 1, bx + 2); nx += 1) {
          sum += blackPoints[ny * blocksX + nx];
          count += 1;
        }
      }
      const threshold = sum / count;
      const yEnd = Math.min(height, (by + 1) * blockSize);
      const xEnd = Math.min(width, (bx + 1) * blockSize);
      for (let y = by * blockSize; y < yEnd; y += 1) {
        for (let x = bx * blockSize; x < xEnd; x += 1) {
          dark[y * width + x] = luminance[y * width + x] <= threshold ? 1 : 0;
        }
      }
    }
  }
  return { width, height, dark };
}

// ---------------------------------------------------------------------------
// Motifs de repérage (1:1:3:1:1).

function isFinderRatio(counts: readonly number[]): boolean {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total < 7 || counts.some((value) => value === 0)) return false;
  const module = total / 7;
  const variance = module / 1.8;
  return Math.abs(module - counts[0]) < variance
    && Math.abs(module - counts[1]) < variance
    && Math.abs(3 * module - counts[2]) < 3 * variance
    && Math.abs(module - counts[3]) < variance
    && Math.abs(module - counts[4]) < variance;
}

function isDark(image: BitImage, x: number, y: number): boolean {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return false;
  return image.dark[iy * image.width + ix] === 1;
}

/**
 * Compte les 5 plages autour d'un centre le long d'une direction. Rend la
 * position continue du centre, relative au pixel de départ.
 */
function crossCheck(image: BitImage, cx: number, cy: number, dx: number, dy: number, maxCount: number): { center: number; total: number } | null {
  const counts = [0, 0, 0, 0, 0];
  const at = (k: number) => isDark(image, cx + dx * k, cy + dy * k);
  const inside = (k: number) => insideImage(image, cx + dx * k, cy + dy * k);
  let step = 0;
  while (at(-step) && counts[2] <= maxCount * 3) { counts[2] += 1; step += 1; }
  if (counts[2] === 0) return null;
  while (inside(-step) && !at(-step) && counts[1] <= maxCount) { counts[1] += 1; step += 1; }
  while (at(-step) && counts[0] <= maxCount) { counts[0] += 1; step += 1; }
  step = 1;
  while (at(step) && counts[2] <= maxCount * 3) { counts[2] += 1; step += 1; }
  while (inside(step) && !at(step) && counts[3] <= maxCount) { counts[3] += 1; step += 1; }
  while (at(step) && counts[4] <= maxCount) { counts[4] += 1; step += 1; }
  if (!isFinderRatio(counts)) return null;
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (5 * Math.abs(total - maxCount) >= 2 * maxCount * 1.5) return null;
  return { center: step - counts[4] - counts[3] - counts[2] / 2, total };
}

function insideImage(image: BitImage, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < image.width && y < image.height;
}

function findFinderCandidates(image: BitImage): FinderCandidate[] {
  const candidates: FinderCandidate[] = [];
  const { width, height } = image;
  const addCandidate = (x: number, y: number, moduleSize: number) => {
    for (const candidate of candidates) {
      if (Math.abs(candidate.x - x) <= moduleSize && Math.abs(candidate.y - y) <= moduleSize
        && Math.abs(candidate.moduleSize - moduleSize) <= Math.max(1, candidate.moduleSize * 0.5)) {
        const count = candidate.count + 1;
        candidate.x = (candidate.x * candidate.count + x) / count;
        candidate.y = (candidate.y * candidate.count + y) / count;
        candidate.moduleSize = (candidate.moduleSize * candidate.count + moduleSize) / count;
        candidate.count = count;
        return;
      }
    }
    candidates.push({ x, y, moduleSize, count: 1 });
  };
  const tryCenter = (counts: readonly number[], row: number, end: number) => {
    if (!isFinderRatio(counts)) return;
    const total = counts.reduce((sum, value) => sum + value, 0);
    const centerX = end - counts[4] - counts[3] - counts[2] / 2;
    const vertical = crossCheck(image, centerX, row, 0, 1, total);
    if (!vertical) return;
    const centerY = Math.floor(row) + vertical.center;
    const horizontal = crossCheck(image, centerX, centerY, 1, 0, total);
    if (!horizontal) return;
    const refinedX = Math.floor(centerX) + horizontal.center;
    if (!crossCheck(image, refinedX, centerY, 1, 1, total) && !crossCheck(image, refinedX, centerY, 1, -1, total)) return;
    addCandidate(refinedX, centerY, (vertical.total + horizontal.total) / 14);
  };
  for (let y = 0; y < height; y += 1) {
    const counts = [0, 0, 0, 0, 0];
    let state = 0;
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (image.dark[offset + x] === 1) {
        if ((state & 1) === 1) state += 1;
        counts[state] += 1;
      } else if ((state & 1) === 0) {
        if (state === 4) {
          tryCenter(counts, y, x);
          counts[0] = counts[2];
          counts[1] = counts[3];
          counts[2] = counts[4];
          counts[3] = 1;
          counts[4] = 0;
          state = 3;
        } else {
          state += 1;
          counts[state] += 1;
        }
      } else {
        counts[state] += 1;
      }
    }
    if (state === 4) tryCenter(counts, y, width);
  }
  return candidates;
}


function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Rend les triplets plausibles [bas gauche, haut gauche, haut droite], du meilleur au moins bon. */
function finderTriples(candidates: FinderCandidate[]): Array<[FinderCandidate, FinderCandidate, FinderCandidate]> {
  const pool = candidates
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  const triples: Array<{ score: number; triple: [FinderCandidate, FinderCandidate, FinderCandidate] }> = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      for (let k = j + 1; k < pool.length; k += 1) {
        const points = [pool[i], pool[j], pool[k]];
        const sizes = points.map((point) => point.moduleSize);
        const minSize = Math.min(...sizes);
        const maxSize = Math.max(...sizes);
        if (maxSize > minSize * 1.6) continue;
        const ab = distance(points[0], points[1]);
        const bc = distance(points[1], points[2]);
        const ac = distance(points[0], points[2]);
        let a: FinderCandidate;
        let b: FinderCandidate;
        let c: FinderCandidate;
        let longest: number;
        let side1: number;
        let side2: number;
        if (bc >= ab && bc >= ac) { b = points[0]; a = points[1]; c = points[2]; longest = bc; side1 = ab; side2 = ac; }
        else if (ac >= ab && ac >= bc) { b = points[1]; a = points[0]; c = points[2]; longest = ac; side1 = ab; side2 = bc; }
        else { b = points[2]; a = points[0]; c = points[1]; longest = ab; side1 = ac; side2 = bc; }
        const average = (minSize + maxSize) / 2;
        if (side1 < average * 14 || side2 < average * 14) continue;
        const legs = Math.abs(side1 - side2) / Math.max(side1, side2);
        const hypotenuse = Math.abs(longest - Math.hypot(side1, side2)) / longest;
        if (legs > 0.4 || hypotenuse > 0.25) continue;
        const cross = (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x);
        if (cross < 0) [a, c] = [c, a];
        triples.push({ score: legs + hypotenuse + (maxSize - minSize) / average, triple: [a, b, c] });
      }
    }
  }
  return triples.sort((x, y) => x.score - y.score).map((entry) => entry.triple);
}

// ---------------------------------------------------------------------------
// Transformation de perspective (carré unité vers quadrilatère).

type Transform = readonly number[];

function squareToQuad(p: readonly Point[]): Transform {
  const [p0, p1, p2, p3] = p;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
  const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;
  return [
    p1.x - p0.x + a13 * p1.x, p3.x - p0.x + a23 * p3.x, p0.x,
    p1.y - p0.y + a13 * p1.y, p3.y - p0.y + a23 * p3.y, p0.y,
    a13, a23, 1,
  ];
}

function invert(t: Transform): Transform {
  const [a11, a21, a31, a12, a22, a32, a13, a23, a33] = t;
  return [
    a22 * a33 - a23 * a32, a23 * a31 - a21 * a33, a21 * a32 - a22 * a31,
    a13 * a32 - a12 * a33, a11 * a33 - a13 * a31, a12 * a31 - a11 * a32,
    a12 * a23 - a13 * a22, a13 * a21 - a11 * a23, a11 * a22 - a12 * a21,
  ];
}

function multiply(a: Transform, b: Transform): Transform {
  // a puis b, avec la convention [x' = a11 u + a21 v + a31].
  const r: number[] = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      r[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return r;
}

function apply(t: Transform, x: number, y: number): Point {
  // Convention : x' = (t0 x + t1 y + t2) / (t6 x + t7 y + t8).
  const w = t[6] * x + t[7] * y + t[8];
  return { x: (t[0] * x + t[1] * y + t[2]) / w, y: (t[3] * x + t[4] * y + t[5]) / w };
}

function quadToQuad(from: readonly Point[], to: readonly Point[]): Transform {
  const toSquare = invert(squareToQuad(from));
  const fromSquare = squareToQuad(to);
  return multiply(fromSquare, toSquare);
}

// ---------------------------------------------------------------------------
// Détection complète.

function moduleSizeAlong(image: BitImage, from: Point, to: Point): number {
  const length = distance(from, to);
  if (length < 1) return 0;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const run = (sign: number) => {
    // Sombre (centre), clair, sombre (anneau) : 3,5 modules depuis le centre.
    let step = 0;
    let state = 0;
    while (step < length) {
      const dark = isDark(image, from.x + ux * step * sign, from.y + uy * step * sign);
      if (state === 0 && !dark) state = 1;
      else if (state === 1 && dark) state = 2;
      else if (state === 2 && !dark) return step;
      step += 0.5;
    }
    return NaN;
  };
  const forward = run(1);
  const backward = run(-1);
  if (!Number.isFinite(forward) || !Number.isFinite(backward)) return NaN;
  return (forward + backward) / 7;
}

function findAlignment(image: BitImage, estimate: Point, ux: Point, uy: Point, moduleSize: number): Point | null {
  const radius = Math.max(4, Math.ceil(moduleSize * 6));
  let best: { score: number; points: Point[] } = { score: -1, points: [] };
  const step = Math.max(0.5, moduleSize / 4);
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const cx = estimate.x + dx;
      const cy = estimate.y + dy;
      let score = 0;
      for (let my = -2; my <= 2; my += 1) {
        for (let mx = -2; mx <= 2; mx += 1) {
          const ring = Math.max(Math.abs(mx), Math.abs(my));
          const expected = ring !== 1;
          const px = cx + ux.x * mx + uy.x * my;
          const py = cy + ux.y * mx + uy.y * my;
          if (isDark(image, px, py) === expected) score += 1;
        }
      }
      if (score > best.score) best = { score, points: [{ x: cx, y: cy }] };
      else if (score === best.score) best.points.push({ x: cx, y: cy });
    }
  }
  if (best.score < 23) return null;
  const close = best.points.filter((point) => distance(point, best.points[0]) <= moduleSize * 2);
  return {
    x: close.reduce((sum, point) => sum + point.x, 0) / close.length,
    y: close.reduce((sum, point) => sum + point.y, 0) / close.length,
  };
}

function sampleGrid(image: BitImage, transform: Transform, size: number): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) {
      const point = apply(transform, x + 0.5, y + 0.5);
      row.push(isDark(image, point.x, point.y));
    }
    grid.push(row);
  }
  return grid;
}

function transpose(grid: boolean[][]): boolean[][] {
  return grid.map((row, y) => row.map((_, x) => grid[x][y]));
}

function decodeFromTriple(image: BitImage, triple: [FinderCandidate, FinderCandidate, FinderCandidate]): string | null {
  const [bottomLeft, topLeft, topRight] = triple;
  const sizes = [
    moduleSizeAlong(image, topLeft, topRight),
    moduleSizeAlong(image, topRight, topLeft),
    moduleSizeAlong(image, topLeft, bottomLeft),
    moduleSizeAlong(image, bottomLeft, topLeft),
  ].filter((value) => Number.isFinite(value) && value > 0);
  const moduleSize = sizes.length
    ? sizes.reduce((sum, value) => sum + value, 0) / sizes.length
    : (bottomLeft.moduleSize + topLeft.moduleSize + topRight.moduleSize) / 3;
  if (!(moduleSize > 0)) return null;
  const estimate = Math.round(((distance(topLeft, topRight) + distance(topLeft, bottomLeft)) / 2) / moduleSize) + 7;
  const base = estimate - ((estimate - 17) % 4 + 4) % 4;
  const dimensions = [base + ((estimate - base) >= 2 ? 4 : 0), base, base + 4, base - 4]
    .filter((value, index, all) => value >= 21 && value <= 177 && all.indexOf(value) === index);

  for (const dimension of dimensions) {
    const modulesBetween = dimension - 7;
    const ux = { x: (topRight.x - topLeft.x) / modulesBetween, y: (topRight.y - topLeft.y) / modulesBetween };
    const uy = { x: (bottomLeft.x - topLeft.x) / modulesBetween, y: (bottomLeft.y - topLeft.y) / modulesBetween };
    const corners: Point[] = [
      { x: 3.5, y: 3.5 },
      { x: dimension - 3.5, y: 3.5 },
      { x: dimension - 3.5, y: dimension - 3.5 },
      { x: 3.5, y: dimension - 3.5 },
    ];
    let bottomRight: Point = {
      x: topRight.x - topLeft.x + bottomLeft.x,
      y: topRight.y - topLeft.y + bottomLeft.y,
    };
    if (dimension > 21) {
      const factor = 1 - 3 / modulesBetween;
      const estimated = {
        x: topLeft.x + factor * (bottomRight.x - topLeft.x),
        y: topLeft.y + factor * (bottomRight.y - topLeft.y),
      };
      const alignment = findAlignment(image, estimated, ux, uy, moduleSize);
      if (alignment) {
        corners[2] = { x: dimension - 6.5, y: dimension - 6.5 };
        bottomRight = alignment;
      }
    }
    const transform = quadToQuad(corners, [topLeft, topRight, bottomRight, bottomLeft]);
    const grid = sampleGrid(image, transform, dimension);
    for (const candidate of [grid, transpose(grid)]) {
      const result = decodeQrGrid(candidate);
      if ('text' in result) return result.text;
    }
  }
  return null;
}

/** Cherche et décode un code QR. Rend tous les textes trouvés, sans doublon. */
export function decodeQrCodes(image: QrImage, maxTriples = 12): string[] {
  if (image.width < 21 || image.height < 21) return [];
  const bits = binarize(image);
  const candidates = findFinderCandidates(bits);
  const found: string[] = [];
  const used = new Set<FinderCandidate>();
  for (const triple of finderTriples(candidates).slice(0, maxTriples)) {
    if (triple.some((point) => used.has(point))) continue;
    const text = decodeFromTriple(bits, triple);
    if (text !== null) {
      if (!found.includes(text)) found.push(text);
      triple.forEach((point) => used.add(point));
    }
  }
  return found;
}
