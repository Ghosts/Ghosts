// The Jackalope mark rasterized to text, the way packages/brand's AsciiMark draws it:
// a solid head with outlined echoes trailing right. No canvas here, so the paths are
// flattened to polygons and each cell is supersampled for fill and stroke coverage.

const PATHS = [
  // farEar, nearEar, antler, head from packages/brand/src/character.ts
  'M85 65 C77 48 74 16 84 9 C94 3 97 20 95 34 L93 62 Z',
  'M80 68 C64 58 43 23 51 17 C60 9 79 32 88 61 Z',
  'M99 64 C100 49 111 40 115 28 C117 23 115 17 117 14 C121 10 124 16 123 23 C128 22 131 17 134 19 C139 24 128 32 121 32 C119 39 115 44 113 48 C122 47 127 43 130 45 C135 50 122 57 108 57 L107 67 Z',
  'M78 59 C86 53 100 53 109 60 C116 65 116 73 124 76 L132 80 C139 85 132 96 122 98 L109 100 C102 103 100 110 102 116 C84 116 73 108 69 99 C80 98 80 89 76 81 C72 73 71 65 78 59 Z',
];

const ECHO = { x: 4, y: 1 };

export const RAMP = ' .:-=+*#%@';
export const NOISE = '01<>/\\{}[]#$%&*+=?';

/** Flattens an absolute M/L/C/Z path into closed polygons. */
function flatten(d) {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g);
  const polygons = [];
  let polygon = [];
  let i = 0;
  let command = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLCZ]/.test(tokens[i])) command = tokens[i++];
    if (command === 'M') {
      if (polygon.length) polygons.push(polygon);
      polygon = [[num(), num()]];
      command = 'L';
    } else if (command === 'L') {
      polygon.push([num(), num()]);
    } else if (command === 'C') {
      const [x0, y0] = polygon[polygon.length - 1];
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let step = 1; step <= 16; step++) {
        const t = step / 16;
        const u = 1 - t;
        polygon.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
    } else if (command === 'Z') {
      polygons.push(polygon);
      polygon = [];
      command = '';
    }
  }
  if (polygon.length) polygons.push(polygon);
  return polygons;
}

const SHAPES = PATHS.flatMap(flatten);
const points = SHAPES.flat();
const BOX = {
  x: Math.min(...points.map(([x]) => x)),
  y: Math.min(...points.map(([, y]) => y)),
};
BOX.width = Math.max(...points.map(([x]) => x)) - BOX.x;
BOX.height = Math.max(...points.map(([, y]) => y)) - BOX.y;

function inside(x, y) {
  for (const polygon of SHAPES) {
    let hit = false;
    for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
      const [xa, ya] = polygon[a];
      const [xb, yb] = polygon[b];
      if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
}

function nearEdge(x, y, reach) {
  const limit = reach * reach;
  for (const polygon of SHAPES) {
    for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
      const [xa, ya] = polygon[b];
      const [xb, yb] = polygon[a];
      const dx = xb - xa;
      const dy = yb - ya;
      const t = Math.max(0, Math.min(1, ((x - xa) * dx + (y - ya) * dy) / (dx * dx + dy * dy || 1)));
      const ex = xa + t * dx - x;
      const ey = ya + t * dy - y;
      if (ex * ex + ey * ey <= limit) return true;
    }
  }
  return false;
}

/**
 * Returns a cols x rows grid of cells: { level 0..1, kind: 'fill' | 'echo' | null }.
 * `aspect` is cell height / cell width, so the mark keeps its proportions in text.
 */
export function rasterize({ cols, rows, aspect, echoes = 6, samples = 4 }) {
  const spanX = BOX.width + ECHO.x * echoes;
  const spanY = BOX.height + ECHO.y * echoes;
  // Path units per cell, fitting the whole span with a little margin.
  const unit = Math.max(spanX / cols, spanY / (rows * aspect)) / 0.94;
  const cellW = unit;
  const cellH = unit * aspect;
  const offsetX = BOX.x - (cols * cellW - spanX) / 2;
  const offsetY = BOX.y - (rows * cellH - spanY) / 2;
  const stroke = Math.max(0.8, cellW * 0.45); // half of a ~1.6 unit line, at least half a cell
  const grid = [];
  for (let row = 0; row < rows; row++) {
    const line = [];
    for (let col = 0; col < cols; col++) {
      let fill = 0;
      let echo = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = offsetX + (col + (sx + 0.5) / samples) * cellW;
          const y = offsetY + (row + (sy + 0.5) / samples) * cellH;
          if (inside(x, y)) {
            fill++;
            continue;
          }
          // Echoes are composited back to front, each a fainter outline.
          let alpha = 0;
          for (let shift = echoes; shift >= 1; shift--) {
            if (nearEdge(x - ECHO.x * shift, y - ECHO.y * shift, stroke)) {
              const a = 0.55 - (shift / echoes) * 0.4;
              alpha = alpha + a * (1 - alpha);
            }
          }
          echo += alpha;
        }
      }
      const total = samples * samples;
      fill /= total;
      echo /= total;
      const level = Math.min(1, fill + echo * (1 - fill));
      // Only cells squarely on an echo line draw, so the outlines keep dark space between them.
      const kind = fill >= 0.06 && fill >= echo ? 'fill' : echo >= 0.22 ? 'echo' : null;
      line.push({ level, kind });
    }
    grid.push(line);
  }
  return grid;
}

/** Echo outlines stay in the light half of the ramp so the solid head reads by weight. */
const ECHO_RAMP = ' .:-=+';

export function glyph(level, kind = 'fill') {
  const ramp = kind === 'echo' ? ECHO_RAMP : RAMP;
  return ramp[Math.min(ramp.length - 1, Math.ceil(level * (ramp.length - 1)))];
}
