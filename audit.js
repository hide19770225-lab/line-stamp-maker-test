/* Read-only checks shared by the bulk review UI and tests. */
(function (root) {
  "use strict";
  function inspect(image, bytes, width, height, options = {}) {
    const errors = [],
      warnings = [];
    if (
      image.width !== width ||
      image.height !== height ||
      width % 2 ||
      height % 2
    )
      errors.push(`PNGサイズが${width}×${height}pxではありません`);
    if (image.data.length !== image.width * image.height * 4)
      errors.push("RGBAデータが不正です");
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1024 * 1024)
      errors.push("PNG容量が不正、または1MBを超えています");
    let visible = 0,
      transparent = 0,
      edge = false,
      partial = 0;
    const margin = options.margin ?? 10;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const alpha = image.data[(y * image.width + x) * 4 + 3];
        if (!alpha) transparent++;
        else {
          visible++;
          if (alpha < 255) partial++;
          if (
            x < margin ||
            y < margin ||
            x >= image.width - margin ||
            y >= image.height - margin
          )
            edge = true;
        }
      }
    }
    if (!visible) errors.push("画像が空です");
    if (!transparent) errors.push("透明ピクセルがありません");
    if (edge) errors.push(`外周${margin}pxの透明余白が不足しています`);
    if (options.stale)
      errors.push("元画像の設定変更が未反映です。分割し直してください");
    if (options.textClipped) errors.push("文字が枠からはみ出しています");
    if (options.textOverlap)
      warnings.push("文字とキャラクターの重なりを確認してください");
    if (options.unsafe)
      errors.push("文字の自動配置がキャラクターに重なっています");
    if (options.residues)
      warnings.push(
        `孤立成分の要確認 ${options.residues}件（異常は未確定・装飾の可能性あり）`,
      );
    return {
      status: errors.length ? "エラー" : warnings.length ? "要確認" : "正常",
      errors,
      warnings,
      decorations: options.decorations || 0,
      bytes,
      transparent,
      partial,
      visible,
    };
  }
  const api = { inspect };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StampAudit = api;
})(typeof window !== "undefined" ? window : globalThis);
