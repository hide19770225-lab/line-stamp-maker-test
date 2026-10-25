/* Conservative connected-component review. Detection never changes image pixels. */
(function (root) {
  "use strict";
  function analyse(
    image,
    mask,
    rect = { x: 0, y: 0, width: image.width, height: image.height },
    detailed = false,
  ) {
    const { width, height, data } = image;
    if (mask.length !== width * height)
      throw new Error("画像と透明度の寸法が一致しません。");
    const visited = new Uint32Array(mask.length),
      queue = new Uint32Array(mask.length),
      components = [];
    const xEnd = rect.x + rect.width,
      yEnd = rect.y + rect.height;
    let id = 0;
    for (let y = rect.y; y < yEnd; y++)
      for (let x = rect.x; x < xEnd; x++) {
        const index = y * width + x;
        if (!mask[index] || visited[index]) continue;
        id++;
        let head = 0,
          tail = 0,
          left = x,
          right = x,
          top = y,
          bottom = y,
          white = 0,
          colored = 0,
          alphaMin = 255,
          alphaMax = 0;
        queue[tail++] = index;
        visited[index] = id;
        while (head < tail) {
          const i = queue[head++],
            px = i % width,
            py = Math.floor(i / width);
          alphaMin = Math.min(alphaMin, mask[i]);
          alphaMax = Math.max(alphaMax, mask[i]);
          left = Math.min(left, px);
          right = Math.max(right, px);
          top = Math.min(top, py);
          bottom = Math.max(bottom, py);
          if (
            data[i * 4] >= 235 &&
            data[i * 4 + 1] >= 235 &&
            data[i * 4 + 2] >= 235
          )
            white++;
          if (
            Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) -
              Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >=
            35
          )
            colored++;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = px + dx,
                ny = py + dy;
              if (nx < rect.x || nx >= xEnd || ny < rect.y || ny >= yEnd)
                continue;
              const n = ny * width + nx;
              if (mask[n] && !visited[n]) {
                visited[n] = id;
                queue[tail++] = n;
              }
            }
        }
        components.push({
          id,
          area: tail,
          x: left,
          y: top,
          width: right - left + 1,
          height: bottom - top + 1,
          whiteFraction: white / tail,
          colorFraction: colored / tail,
          alphaMin,
          alphaMax,
          touchesEdge:
            left === rect.x ||
            right === xEnd - 1 ||
            top === rect.y ||
            bottom === yEnd - 1,
        });
      }
    const main = components.reduce(
      (best, c) => (!best || c.area > best.area ? c : best),
      null,
    );
    // A bounding box is not the silhouette: a tall leaf/ear can put a stray
    // top line *inside* the box while it is still outside the character.
    // Flood the complement of the main component from the crop boundary.
    // 4-connected background is dual to the 8-connected foreground above;
    // enclosed eyes/mouth/decorations stay protected, including diagonal outlines.
    const exterior = new Uint8Array(mask.length),
      nearMain = new Uint8Array(mask.length),
      guard = Math.max(3, Math.round(Math.min(width, height) * 0.01));
    if (main && components.length > 1) {
      let head = 0,
        tail = 0;
      const visitOutside = (i) => {
        if (!exterior[i] && visited[i] !== main.id) {
          exterior[i] = 1;
          queue[tail++] = i;
        }
      };
      for (let x = rect.x; x < xEnd; x++) {
        visitOutside(rect.y * width + x);
        visitOutside((yEnd - 1) * width + x);
      }
      for (let y = rect.y; y < yEnd; y++) {
        visitOutside(y * width + rect.x);
        visitOutside(y * width + xEnd - 1);
      }
      while (head < tail) {
        const i = queue[head++],
          x = i % width,
          y = Math.floor(i / width);
        if (x > rect.x) visitOutside(i - 1);
        if (x + 1 < xEnd) visitOutside(i + 1);
        if (y > rect.y) visitOutside(i - width);
        if (y + 1 < yEnd) visitOutside(i + width);
      }
      // Protect near-outline facial details as well. Only expand a few native
      // pixels; no image/color/mask data is modified by either pass.
      head = 0;
      tail = 0;
      for (let y = rect.y; y < yEnd; y++)
        for (let x = rect.x; x < xEnd; x++) {
          const i = y * width + x;
          if (visited[i] === main.id) {
            nearMain[i] = 1;
            queue[tail++] = i;
          }
        }
      for (let distance = 0; distance < guard; distance++) {
        const end = tail;
        while (head < end) {
          const i = queue[head++],
            x = i % width,
            y = Math.floor(i / width);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx,
                ny = y + dy;
              if (nx < rect.x || nx >= xEnd || ny < rect.y || ny >= yEnd)
                continue;
              const n = ny * width + nx;
              if (!nearMain[n]) {
                nearMain[n] = 1;
                queue[tail++] = n;
              }
            }
        }
      }
      for (const c of components) {
        c.exterior = true;
        c.nearMain = false;
      }
      for (let y = rect.y; y < yEnd; y++)
        for (let x = rect.x; x < xEnd; x++) {
          const i = y * width + x,
            label = visited[i];
          if (!label || label === main.id) continue;
          const c = components[label - 1];
          if (!exterior[i]) c.exterior = false;
          if (nearMain[i]) c.nearMain = true;
        }
    }
    const candidates = main
      ? components.filter((c) => {
          if (c.id === main.id) return false;
          const outside =
            c.x + c.width <= main.x ||
            c.x >= main.x + main.width ||
            c.y + c.height <= main.y ||
            c.y >= main.y + main.height;
          const thin =
            (c.width >= 5 &&
              c.height <= Math.max(3, height * 0.015) &&
              c.width / c.height >= 4) ||
            (c.height >= 5 &&
              c.width <= Math.max(3, width * 0.015) &&
              c.height / c.width >= 4);
          const tiny = c.area <= Math.max(4, main.area * 0.015);
          // Compact detached shapes can be hearts, leaves or baked-in glyphs.
          // Keep them visible for inspection but prohibit component deletion.
          c.protected =
            !thin &&
            !c.touchesEdge &&
            c.width >= 5 &&
            c.height >= 5 &&
            c.area >= 25;
          c.boundaryDistance = Math.min(
            c.x - rect.x,
            c.y - rect.y,
            xEnd - c.x - c.width,
            yEnd - c.y - c.height,
          );
          c.nearBoundary =
            c.boundaryDistance <=
            Math.max(4, Math.round(Math.min(rect.width, rect.height) * 0.02));
          // Short strokes near a silhouette may be motion marks, sweat or tears.
          c.protected = c.protected || (thin && c.nearMain && !c.touchesEdge);
          // Colored and compact detached marks can be hearts, stars, sweat or anger
          // symbols. Their meaning is uncertain, so protect them instead of calling
          // them defects. Edge/boundary marks remain reviewable; never auto delete.
          c.decorationLike =
            !c.touchesEdge &&
            !c.nearBoundary &&
            ((c.colorFraction >= 0.25 &&
              c.width >= 2 &&
              c.height >= 2 &&
              c.area >= 3) ||
              (!thin && c.width >= 3 && c.height >= 3 && c.area >= 6));
          c.protected = c.protected || c.decorationLike;
          c.classification = c.protected
            ? "decoration-or-detail"
            : "uncertain-residue";
          c.kind = c.nearBoundary ? "boundary" : thin ? "line" : "fragment";
          return (
            (outside || (c.exterior && !c.nearMain)) &&
            (thin || tiny || (c.touchesEdge && c.area <= main.area * 0.1)) &&
            c.area <= Math.max(64, main.area * 0.25)
          );
        })
      : [];
    // A disconnected pair of strokes may be an anger/motion mark. Protect
    // nearby non-boundary fragments as uncertain decoration, never as a defect.
    const gapLimit = Math.max(3, Math.round(Math.min(width, height) * 0.02));
    // Bound pairwise work on noisy sheets for mobile devices. Other components
    // remain unchanged review candidates; never assume an unexamined mark is safe.
    const fragments = candidates
      .filter(
        (c) =>
          !c.nearBoundary &&
          !c.touchesEdge &&
          c.area >= 2 &&
          Math.max(c.width, c.height) <= Math.min(width, height) * 0.12,
      )
      .slice(0, 2000);
    for (let i = 0; i < fragments.length; i++)
      for (let j = i + 1; j < fragments.length; j++) {
        const a = fragments[i],
          b = fragments[j];
        const dx = Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width),
          dy = Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height);
        if (
          dx <= gapLimit &&
          dy <= gapLimit &&
          Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) <=
            Math.min(width, height) * 0.18 &&
          Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) <=
            Math.min(width, height) * 0.18
        ) {
          for (const c of [a, b]) {
            c.protected = true;
            c.decorationLike = true;
            c.classification = "decoration-or-detail";
            c.groupedDecoration = true;
          }
        }
      }
    return {
      width,
      height,
      components,
      candidates,
      mainId: main?.id || 0,
      rect: { ...rect },
      labels: detailed ? visited : null,
      maskSnapshot: detailed ? mask.slice() : null,
    };
  }
  function removeSelected(mask, scan, ids) {
    if (
      !scan.labels ||
      !scan.maskSnapshot ||
      mask.length !== scan.maskSnapshot.length ||
      mask.some((alpha, i) => alpha !== scan.maskSnapshot[i])
    )
      throw new Error(
        "画像が変更されています。候補を再検出してから選択してください。",
      );
    const allowed = new Set(
        scan.candidates.filter((c) => !c.protected).map((c) => c.id),
      ),
      selected = new Set(ids);
    if ([...selected].some((id) => !allowed.has(id)))
      throw new Error("選択した削除候補が正しくありません。");
    const result = mask.slice();
    let removed = 0;
    for (let i = 0; i < result.length; i++)
      if (selected.has(scan.labels[i]) && result[i]) {
        result[i] = 0;
        removed++;
      }
    return { mask: result, removed };
  }
  // Inspect the *actual final RGBA pixels*. Text, outline and shadow coverage
  // is supplied by the canonical typography painter; never suggest those components.
  // This is an audit only: deletions still edit the original/native alpha mask.
  function inspectFinal(image, protectedAlpha = null) {
    const mask = Uint8ClampedArray.from(
      { length: image.width * image.height },
      (_, i) => image.data[i * 4 + 3],
    );
    if (protectedAlpha && protectedAlpha.length !== mask.length)
      throw new Error("文字保護マスクの寸法が一致しません。");
    const scan = analyse(image, mask, undefined, true),
      protectedIds = new Set();
    if (protectedAlpha)
      for (let i = 0; i < mask.length; i++)
        if (protectedAlpha[i] && scan.labels[i])
          protectedIds.add(scan.labels[i]);
    return {
      candidates: scan.candidates.filter(
        (c) => !c.protected && !protectedIds.has(c.id),
      ),
      decorations: scan.candidates.filter(
        (c) => c.protected && !protectedIds.has(c.id),
      ),
      protectedIds: [...protectedIds],
    };
  }
  // Narrow, reversible automatic rule for a flat neutral scanline above artwork.
  // Never a general "remove small components" operation. Ambiguous marks stay review-only.
  function automaticLines(image) {
    const { width, height, data } = image,
      top = Math.min(height - 2, Math.floor(height * 0.16));
    let possible = false;
    for (let y = 1; y <= top && !possible; y++) {
      let run = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4,
          a = data[i + 3],
          r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (
          a > 0 &&
          a < 255 &&
          Math.min(r, g, b) >= 200 &&
          Math.max(r, g, b) - Math.min(r, g, b) <= 24 &&
          data[i - width * 4 + 3] === 0 &&
          data[i + width * 4 + 3] === 0
        )
          run++;
        else run = 0;
        if (run >= 12) {
          possible = true;
          break;
        }
      }
    }
    if (!possible) return [];
    const mask = Uint8ClampedArray.from(
        { length: width * height },
        (_, i) => data[i * 4 + 3],
      ),
      scan = analyse(image, mask, undefined, true),
      main = scan.components.find((c) => c.id === scan.mainId);
    if (!main || main.area < Math.max(2500, width * height * 0.04)) return [];
    return scan.candidates.filter((c) => {
      if (
        c.protected ||
        c.height !== 1 ||
        c.area !== c.width ||
        c.width < 12 ||
        c.width > main.width * 0.35 ||
        c.area > main.area * 0.005 ||
        c.y > top ||
        main.y - c.y - 1 < Math.max(12, height * 0.04) ||
        Math.abs(c.x + c.width / 2 - (main.x + main.width / 2)) >
          main.width * 0.15 ||
        c.alphaMax === 255
      )
        return false;
      const tones = new Set(),
        alphas = new Map();
      for (let x = c.x; x < c.x + c.width; x++) {
        const i = (c.y * width + x) * 4,
          rgb = [data[i], data[i + 1], data[i + 2]];
        tones.add(rgb.join(","));
        alphas.set(data[i + 3], (alphas.get(data[i + 3]) || 0) + 1);
        if (Math.min(...rgb) < 200 || Math.max(...rgb) - Math.min(...rgb) > 24)
          return false;
      }
      // Textured RGB with a flat alpha plateau is typical of a severed source row.
      // Uniform pale motion marks remain review-only even if the geometry matches.
      return tones.size >= 4 && Math.max(...alphas.values()) >= c.width * 0.8;
    });
  }
  const api = { analyse, removeSelected, inspectFinal, automaticLines };
  root.StampResidue = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
