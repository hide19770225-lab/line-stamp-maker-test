/* Local typography presets and alpha-mask based placement; no AI or network calls. */
(function (root) {
  "use strict";
  const C = root.StampCore,
    W = 370,
    H = 320,
    GAP = 5;
  const PRESETS = {
    energetic: {
      label: "元気",
      font: "sans",
      size: 40,
      color: "#ee683d",
      outline: true,
      outlineWidth: 6,
      shadow: 3,
      angle: -5,
    },
    pop: {
      label: "ポップ",
      font: "rounded",
      size: 38,
      color: "#b94d91",
      outline: true,
      outlineWidth: 6,
      shadow: 3,
      angle: -3,
    },
    cute: {
      label: "かわいい",
      font: "rounded",
      size: 36,
      color: "#df7098",
      outline: true,
      outlineWidth: 6,
      shadow: 2,
      angle: 3,
    },
    gentle: {
      label: "やさしい",
      font: "rounded",
      size: 32,
      color: "#588c72",
      outline: true,
      outlineWidth: 5,
      shadow: 1,
      angle: 0,
    },
    emphasis: {
      label: "強調",
      font: "sans",
      size: 44,
      color: "#ce424e",
      outline: true,
      outlineWidth: 7,
      shadow: 4,
      angle: -4,
    },
    simple: {
      label: "シンプル",
      font: "sans",
      size: 32,
      color: "#293c33",
      outline: true,
      outlineWidth: 4,
      shadow: 0,
      angle: 0,
    },
  };
  const OVERRIDES = [
    "font",
    "size",
    "color",
    "outline",
    "outlineWidth",
    "shadow",
    "angle",
  ];
  function suggest(text) {
    if (/好き|すき|かわいい|ぎゅ|♡|❤|💕|だいすき/.test(text)) return "cute";
    if (/ダメ|だめ|絶対|怒|重要|注意|お願い|助け|びっくり|なんで/.test(text))
      return "emphasis";
    if (
      /ありがとう|お疲れ|おつかれ|おやすみ|大丈夫|よろしく|ごめん|ゆっくり/.test(
        text,
      )
    )
      return "gentle";
    if (/やった|元気|頑張|がんば|ファイト|おはよう|最高|[！!]/.test(text))
      return "energetic";
    if (/^(了解|はい|いいえ|OK|おけ|承知|確認)[。！!]*$/i.test(text.trim()))
      return "simple";
    return "pop";
  }
  function resolve(text, style) {
    const key = style.preset === "auto" ? suggest(text) : style.preset;
    if (!PRESETS[key])
      return {
        ...style,
        preset: "manual",
        autoPlace: style.autoPlace ?? false,
        angle: style.angle ?? 0,
        shadow: style.shadow ?? 0,
        outlineWidth: style.outlineWidth ?? Math.max(3, style.size / 6),
      };
    const result = {
      ...PRESETS[key],
      ...(style.safeMargin === 20 ? { safeMargin: 20 } : {}),
      preset: key,
      autoPlace: style.autoPlace ?? true,
      x: style.x ?? 50,
      y: style.y ?? 84,
    };
    for (const key of style.overrides || [])
      if (OVERRIDES.includes(key)) result[key] = style[key];
    return result;
  }
  function presetStyle(key, text = "") {
    const resolved =
      PRESETS[key === "auto" ? suggest(text) : key] || PRESETS.simple;
    const { label, ...values } = resolved;
    return {
      ...values,
      preset: key,
      overrides: [],
      autoPlace: true,
      x: 50,
      y: 84,
    };
  }
  function settings(ctx, style) {
    ctx.font = `700 ${style.size}px ${C.FONTS[style.font] || C.FONTS.sans}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.fillStyle = style.color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = style.outlineWidth;
    ctx.shadowColor = "rgba(28,51,42,.35)";
    ctx.shadowBlur = style.shadow;
    ctx.shadowOffsetX = style.shadow / 3;
    ctx.shadowOffsetY = style.shadow / 2;
  }
  function textMetrics(text, style) {
    const c = C.canvas(1, 1),
      ctx = c.getContext("2d");
    settings(ctx, style);
    const lines = C.wrapText(ctx, text, style.safeMargin === 20 ? 306 : 326),
      lineHeight = style.size * 1.25;
    let left = 0,
      right = 0,
      top = Infinity,
      bottom = -Infinity;
    lines.forEach((line, i) => {
      const m = ctx.measureText(line);
      left = Math.max(left, m.actualBoundingBoxLeft ?? m.width / 2);
      right = Math.max(right, m.actualBoundingBoxRight ?? m.width / 2);
      top = Math.min(
        top,
        i * lineHeight - (m.actualBoundingBoxAscent ?? style.size),
      );
      bottom = Math.max(
        bottom,
        i * lineHeight + (m.actualBoundingBoxDescent ?? style.size / 4),
      );
    });
    const padding =
      (style.outline ? style.outlineWidth / 2 : 0) + style.shadow * 4 + 3;
    const width = left + right,
      height = Math.max(1, bottom - top),
      radians = (style.angle * Math.PI) / 180;
    return {
      lines,
      lineHeight,
      centerX: (right - left) / 2,
      centerY: (top + bottom) / 2,
      width: Math.ceil(
        Math.abs(width * Math.cos(radians)) +
          Math.abs(height * Math.sin(radians)) +
          padding * 2,
      ),
      height: Math.ceil(
        Math.abs(width * Math.sin(radians)) +
          Math.abs(height * Math.cos(radians)) +
          padding * 2,
      ),
    };
  }
  function drawLetters(ctx, style, metrics, x, y) {
    ctx.save();
    settings(ctx, style);
    ctx.translate(x, y);
    ctx.rotate((style.angle * Math.PI) / 180);
    metrics.lines.forEach((line, i) => {
      const py = i * metrics.lineHeight - metrics.centerY;
      if (style.outline && style.outlineWidth > 0)
        ctx.strokeText(line, -metrics.centerX, py);
      ctx.fillText(line, -metrics.centerX, py);
    });
    ctx.restore();
  }
  function bitmap(text, style) {
    const metrics = textMetrics(text, style);
    // Do not allocate enormous canvases for pathological multiline text.
    if (metrics.width > 900 || metrics.height > 900)
      return {
        canvas: null,
        metrics,
        width: metrics.width,
        height: metrics.height,
        points: [],
      };
    const c = C.canvas(Math.max(1, metrics.width), Math.max(1, metrics.height)),
      ctx = c.getContext("2d", { willReadFrequently: true });
    drawLetters(ctx, style, metrics, c.width / 2, c.height / 2);
    const pixels = ctx.getImageData(0, 0, c.width, c.height),
      bounds = C.alphaBounds(pixels.data, c.width, c.height);
    if (!bounds) {
      c.width = c.height = 1;
      return { canvas: c, metrics, width: 1, height: 1, points: [] };
    }
    const tight = C.canvas(bounds.width, bounds.height);
    tight
      .getContext("2d")
      .drawImage(
        c,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        0,
        0,
        bounds.width,
        bounds.height,
      );
    c.width = c.height = 1;
    const data = tight
        .getContext("2d")
        .getImageData(0, 0, tight.width, tight.height).data,
      points = [];
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3])
        points.push((i / 4) % tight.width, Math.floor(i / 4 / tight.width));
    return {
      canvas: tight,
      metrics,
      width: tight.width,
      height: tight.height,
      points,
    };
  }
  function occupancy(art) {
    const pixels = art.getContext("2d").getImageData(0, 0, W, H).data,
      stride = W + 1,
      integral = new Uint32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let sum = 0;
      for (let x = 0; x < W; x++) {
        sum += pixels[(y * W + x) * 4 + 3] > 0 ? 1 : 0;
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
      }
    }
    return { integral, bounds: C.alphaBounds(pixels, W, H) };
  }
  function occupied(map, x0, y0, x1, y1) {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(W, x1);
    y1 = Math.min(H, y1);
    const stride = W + 1,
      a = map.integral;
    return (
      a[y1 * stride + x1] -
      a[y0 * stride + x1] -
      a[y1 * stride + x0] +
      a[y0 * stride + x0]
    );
  }
  function overlap(map, ink, x, y, gap = 0, stopEarly = false) {
    if (!ink.canvas) return 0;
    let count = 0;
    for (let i = 0; i < ink.points.length; i += 2) {
      const px = x + ink.points[i],
        py = y + ink.points[i + 1];
      if (occupied(map, px - gap, py - gap, px + gap + 1, py + gap + 1)) {
        count++;
        if (stopEarly) return count;
      }
    }
    return count;
  }
  function candidates(ink, style) {
    const M = style.safeMargin === 20 ? 20 : 10;
    const maxX = W - M - ink.width,
      maxY = H - M - ink.height;
    if (maxX < M || maxY < M) return [];
    const x = Math.round(
      Math.max(M, Math.min(maxX, (W * style.x) / 100 - ink.width / 2)),
    );
    const y = Math.round(
      Math.max(M, Math.min(maxY, (H * style.y) / 100 - ink.height / 2)),
    );
    const xs = new Set([x, M, maxX, Math.round((M + maxX) / 2)]),
      ys = new Set([y, M, maxY, Math.round((M + maxY) / 2)]);
    for (let px = M; px < maxX; px += 24) xs.add(px);
    for (let py = M; py < maxY; py += 20) ys.add(py);
    return [...xs]
      .flatMap((px) =>
        [...ys].map((py) => ({
          x: px,
          y: py,
          score: (px - x) ** 2 + (py - y) ** 2,
        })),
      )
      .sort((a, b) => a.score - b.score);
  }
  function findPosition(map, ink, positions) {
    return positions.find((p) => !overlap(map, ink, p.x, p.y, GAP, true));
  }
  function compose(text, originalStyle, art, adjustedArt) {
    const style = resolve(text, originalStyle),
      M = style.safeMargin === 20 ? 20 : 10,
      initialSize = style.size;
    let ink = bitmap(text, style);
    if (style.autoPlace) {
      while (
        (ink.width > W - M * 2 || ink.height > H - M * 2) &&
        style.size > 14
      ) {
        if (ink.canvas) ink.canvas.width = ink.canvas.height = 1;
        style.size = Math.max(14, style.size - 2);
        ink = bitmap(text, style);
      }
    }
    const map = occupancy(art),
      positions = candidates(ink, style);
    let position = style.autoPlace ? findPosition(map, ink, positions) : null;
    let resultArt = art,
      transform = { scale: 1, x: 0, y: 0 };
    if (style.autoPlace && !position && map.bounds && positions.length) {
      const bottom = {
        x: M,
        y: M,
        width: W - M * 2,
        height: H - M * 2 - ink.height - GAP * 2,
      };
      const top = { ...bottom, y: M + ink.height + GAP * 2 };
      const left = {
        x: M,
        y: M,
        width: W - M * 2 - ink.width - GAP * 2,
        height: H - M * 2,
      };
      const right = { ...left, x: M + ink.width + GAP * 2 };
      const regions =
        style.y < 50 ? [top, bottom, right, left] : [bottom, top, left, right];
      const b = map.bounds;
      for (const region of regions) {
        const scale = Math.min(
          1,
          region.width / b.width,
          region.height / b.height,
        );
        if (
          scale <= 0 ||
          Math.max(b.width, b.height) * scale <
            Math.min(40, Math.max(b.width, b.height))
        )
          continue;
        const t = {
          scale,
          x: region.x + (region.width - b.width * scale) / 2 - b.x * scale,
          y: region.y + (region.height - b.height * scale) / 2 - b.y * scale,
        };
        const testArt = adjustedArt(t),
          testMap = occupancy(testArt),
          found = findPosition(testMap, ink, positions);
        if (found) {
          resultArt = testArt;
          transform = t;
          position = found;
          break;
        }
        testArt.width = testArt.height = 1;
      }
    }
    // In safe-layout mode, fitting the canvas is insufficient: leave room for artwork too.
    if (
      !position &&
      style.safeMargin === 20 &&
      style.autoPlace &&
      style.size > 14
    ) {
      if (ink.canvas) ink.canvas.width = ink.canvas.height = 1;
      const reduced = compose(
        text,
        {
          ...originalStyle,
          size: Math.max(14, style.size - 2),
          overrides: [...new Set([...(originalStyle.overrides || []), "size"])],
        },
        art,
        adjustedArt,
      );
      reduced.plan.fontReduced = true;
      return reduced;
    }
    if (!position)
      position = {
        x: Math.round((W * style.x) / 100 - ink.width / 2),
        y: Math.round((H * style.y) / 100 - ink.height / 2),
      };
    const clipped =
      !ink.canvas ||
      position.x < M ||
      position.y < M ||
      position.x + ink.width > W - M ||
      position.y + ink.height > H - M;
    const finalMap = resultArt === art ? map : occupancy(resultArt);
    const overlapPixels = overlap(finalMap, ink, position.x, position.y);
    const plan = {
      text,
      style: { ...style },
      x: position.x,
      y: position.y,
      width: ink.width,
      height: ink.height,
      centerX: position.x + ink.width / 2,
      centerY: position.y + ink.height / 2,
      clipped,
      overlapPixels,
      autoScaled: transform.scale < 0.999,
      fontReduced: style.size < initialSize,
    };
    if (ink.canvas) ink.canvas.width = ink.canvas.height = 1;
    return { art: resultArt, transform, plan };
  }
  function paintPlan(ctx, plan) {
    const M = plan.style.safeMargin === 20 ? 20 : 10;
    const ink = bitmap(plan.text, plan.style);
    ctx.save();
    ctx.beginPath();
    ctx.rect(M, M, W - M * 2, H - M * 2);
    ctx.clip();
    if (ink.canvas) ctx.drawImage(ink.canvas, plan.x, plan.y);
    else
      drawLetters(
        ctx,
        plan.style,
        ink.metrics,
        (W * plan.style.x) / 100,
        (H * plan.style.y) / 100,
      );
    ctx.restore();
    if (ink.canvas) ink.canvas.width = ink.canvas.height = 1;
  }
  const api = {
    PRESETS,
    OVERRIDES,
    suggest,
    resolve,
    presetStyle,
    compose,
    paintPlan,
    bitmap,
    occupancy,
    overlap,
  };
  root.StampTypography = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
