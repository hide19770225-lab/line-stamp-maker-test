/* Local reference matching. No general face/pose model or network requests. */
(function (root) {
  "use strict";
  const SIDE = 32;
  const STORAGE_KEY = "stamp-atelier-pose-references-v1";
  const labels = new Set([
    "smile",
    "angry",
    "cry",
    "sleepy",
    "surprised",
    "worried",
    "wave",
    "bow",
    "approve",
    "joy",
    "love",
    "greeting",
    "support",
  ]);
  function learned() {
    try {
      const rows = JSON.parse(root.localStorage?.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(rows)
        ? rows
            .filter(
              (r) =>
                labels.has(r.emotion) &&
                /^[0-9a-f]{4096}$/.test(r.features) &&
                typeof r.label === "string",
            )
            .slice(-40)
        : [];
    } catch (_) {
      return [];
    }
  }
  function remember(image, mask, emotion, label) {
    if (!labels.has(emotion))
      throw new Error(
        "表情・ポーズを手動選択してください。未分類の画像は記憶できません。",
      );
    const vector = descriptor(image, mask);
    if (!vector) throw new Error("見本にできる不透明な画像がありません。");
    const features = vector.map((v) => v.toString(16)).join("");
    const rows = learned().filter((r) => r.features !== features);
    rows.push({
      id: "local-" + Date.now(),
      emotion,
      label: String(label).slice(0, 60),
      features,
    });
    if (!root.localStorage)
      throw new Error("このブラウザでは見本を保存できません。");
    root.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(-40)));
    return Math.min(rows.length, 40);
  }
  function clearLearned() {
    root.localStorage?.removeItem(STORAGE_KEY);
  }

  function descriptor(image, mask) {
    const { width: w, height: h, data } = image;
    if (!w || !h || data.length !== w * h * 4 || mask.length !== w * h)
      return null;
    // Match the existing export rule for known upper scanline remnants. Ignore
    // only those verified components while computing features; never edit inputs.
    let alpha = mask,
      possible = false;
    for (
      let y = 1;
      y <= Math.min(h - 2, Math.floor(h * 0.16)) && !possible;
      y++
    ) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        const n = y * w + x,
          j = n * 4;
        if (
          mask[n] > 0 &&
          mask[n] < 255 &&
          mask[n - w] === 0 &&
          mask[n + w] === 0 &&
          Math.min(data[j], data[j + 1], data[j + 2]) >= 200 &&
          Math.max(data[j], data[j + 1], data[j + 2]) -
            Math.min(data[j], data[j + 1], data[j + 2]) <=
            24
        )
          run++;
        else run = 0;
        if (run >= 12) {
          possible = true;
          break;
        }
      }
    }
    if (possible) {
      const residue =
        root.StampResidue ||
        (typeof module !== "undefined" ? require("./residue.js") : null);
      if (residue) {
        const effective = data.slice();
        for (let i = 0; i < mask.length; i++) effective[i * 4 + 3] = mask[i];
        const lines = residue.automaticLines({
          width: w,
          height: h,
          data: effective,
        });
        if (lines.length) {
          alpha = mask.slice();
          for (const c of lines)
            for (let y = c.y; y < c.y + c.height; y++)
              for (let x = c.x; x < c.x + c.width; x++) alpha[y * w + x] = 0;
        }
      }
    }
    let left = w,
      top = h,
      right = -1,
      bottom = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (alpha[i] < 64 || Math.min(data[j], data[j + 1], data[j + 2]) > 225)
          continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    if (right < left || bottom < top) return null;
    const span = Math.max(right - left + 1, bottom - top + 1) * 1.08,
      cx = (left + right + 1) / 2,
      cy = (top + bottom + 1) / 2;
    const values = [];
    for (let y = 0; y < SIDE; y++)
      for (let x = 0; x < SIDE; x++) {
        const sum = [0, 0, 0, 0];
        for (const oy of [0.25, 0.75])
          for (const ox of [0.25, 0.75]) {
            const sx = Math.floor(cx + ((x + ox) / SIDE - 0.5) * span),
              sy = Math.floor(cy + ((y + oy) / SIDE - 0.5) * span);
            const inside = sx >= 0 && sx < w && sy >= 0 && sy < h,
              i = sy * w + sx,
              a = inside ? alpha[i] / 255 : 0;
            for (let c = 0; c < 3; c++)
              sum[c] += inside ? (data[i * 4 + c] / 255) * a + 1 - a : 1;
            sum[3] += a;
          }
        values.push(...sum.map((v) => Math.round((v / 4) * 15)));
      }
    return values;
  }
  function match(image, mask) {
    const vector = descriptor(image, mask);
    const unknown = {
      emotion: "unknown",
      method: "reference",
      reason: "見本との一致が不十分：判定できず",
    };
    if (!vector) return unknown;
    const personal = learned();
    const corrected = new Set(personal.map((r) => r.features));
    const references = [
      ...(
        root.StampCaptionReferences ||
        (typeof module !== "undefined"
          ? require("./caption-references.js")
          : [])
      ).filter((r) => !corrected.has(r.features)),
      ...personal,
    ];
    const scores = references
      .map((ref) => {
        let normal = 0,
          flipped = 0;
        for (let y = 0; y < SIDE; y++)
          for (let x = 0; x < SIDE; x++)
            for (let c = 0; c < 4; c++) {
              const i = (y * SIDE + x) * 4 + c,
                mirror = (y * SIDE + SIDE - 1 - x) * 4 + c;
              const target = parseInt(ref.features[i], 16);
              normal += Math.abs(vector[i] - target);
              flipped += Math.abs(vector[mirror] - target);
            }
        return {
          ref,
          distance: Math.min(normal, flipped) / vector.length / 15,
          mirrored: flipped < normal,
        };
      })
      .sort((a, b) => a.distance - b.distance);
    if (!scores.length) return unknown;
    const best = scores[0],
      other = scores.find((s) => s.ref.emotion !== best.ref.emotion),
      gap = other ? other.distance - best.distance : 0;
    // Tight closed-set matching, deliberately abstain on unfamiliar/ambiguous pictures.
    if (best.distance > 0.045 || gap < 0.012)
      return {
        ...unknown,
        distance: best.distance,
        gap,
        reason:
          best.distance > 0.045
            ? "判定できず：このキャラクター・ポーズに近い見本がありません。表情を手動選択して見本を記憶できます。"
            : "判定できず：複数の表情・ポーズの見本と似ていて区別できません。手動確認が必要です。",
      };
    return {
      emotion: best.ref.emotion,
      method: "reference",
      distance: best.distance,
      gap,
      mirrored: best.mirrored,
      reason: `画素見本照合${best.mirrored ? "（左右反転）" : ""}：${best.ref.label}に近い画像（推測・要確認）。見本との差 ${(best.distance * 100).toFixed(1)}%。汎用的な表情認識ではありません。`,
    };
  }
  function fingerprint(image, mask) {
    const v = descriptor(image, mask) || [];
    let n = 2166136261;
    for (const k of v) n = Math.imul(n ^ k, 16777619) >>> 0;
    return n;
  }
  const api = {
    descriptor,
    match,
    fingerprint,
    remember,
    learned,
    clearLearned,
  };
  root.StampCaptionVision = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
