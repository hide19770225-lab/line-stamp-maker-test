/* Validation only; never changes image data, assignments or captions. */
(function (root) {
  "use strict";
  function plan(sources, target, { allowPartial = false } = {}) {
    const errors = [],
      warnings = [],
      seen = new Set(),
      assigned = new Set();
    if (![8, 16, 24, 32, 40].includes(target))
      errors.push("制作枚数が不正です");
    if (sources.length > 40) errors.push("元画像は最大40枚です");
    for (const s of sources) {
      if (!s.image) errors.push(`${s.name}の元画像を再選択してください`);
      if (s.fingerprint && seen.has(s.fingerprint))
        errors.push(
          `${s.name}は同じ画像が重複しています。通常モードで確認してください`,
        );
      seen.add(s.fingerprint);
      for (const slot of s.assignments)
        if (slot) {
          if (
            !Number.isInteger(slot) ||
            slot < 1 ||
            slot > target ||
            assigned.has(slot)
          )
            errors.push(`番号${slot}が重複または範囲外です`);
          assigned.add(slot);
        }
    }
    const missing = Array.from({ length: target }, (_, i) => i + 1).filter(
      (n) => !assigned.has(n),
    );
    if (missing.length) {
      const message = `画像・採用コマが不足しています。未割当の番号：${missing.join("、")}`;
      if (allowPartial && assigned.size > 0)
        warnings.push(
          `不足${missing.length}個でも、読み込み済み${assigned.size}個のテスト加工を続けます。申請用ZIPには全${target}個が必要です。未割当の番号：${missing.join("、")}`,
        );
      else errors.push(message);
    }
    const unused = sources.reduce(
      (n, s) => n + s.assignments.filter((slot) => !slot).length,
      0,
    );
    if (unused)
      warnings.push(
        `${unused}コマは申請枚数・既存の除外設定により未採用です。元画像は変更しません`,
      );
    return { errors, warnings, missing };
  }
  function captions(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    if (lines.length > 40 || lines.some((s) => Array.from(s).length > 120))
      throw new Error("セリフは40行以内、各行120文字以内で入力してください");
    return lines;
  }
  const api = { plan, captions, version: "easy-state-1" };
  root.StampEasy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
