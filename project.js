/* Stable numbered slots and validated, image-free project settings. No DOM or network access. */
(function (root) {
  "use strict";
  const COUNTS = [8, 16, 24, 32, 40],
    MAX_SOURCES = 40,
    MAX_CELLS = 160;
  const sides = ["left", "right", "top", "bottom"];
  const blankInsets = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  const lines = (count) =>
    Array.from({ length: count + 1 }, (_, i) => i / count);
  const blankSlot = () => ({
    cleanupEnabled: true,
    caption: "",
    style: {
      font: "sans",
      size: 32,
      x: 50,
      y: 84,
      color: "#293c33",
      outline: true,
      preset: "auto",
      overrides: [],
      autoPlace: true,
      outlineWidth: 5,
      shadow: 0,
      angle: 0,
    },
    layout: { scale: 90, x: 50, y: 50 },
    crop: blankInsets(),
    mask: null,
  });
  function dimensions(columns, rows) {
    if (
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      columns < 1 ||
      rows < 1 ||
      columns > 40 ||
      rows > 40 ||
      columns * rows > MAX_CELLS
    )
      throw new Error("列数・行数は1〜40、合計160コマ以内で指定してください。");
  }
  function fillFree(project, source, start = 0) {
    const used = new Set(
      project.sources.flatMap((s) => s.assignments).filter(Boolean),
    );
    for (let i = start; i < source.assignments.length; i++)
      if (!source.assignments[i]) {
        let slot = 1;
        while (used.has(slot) && slot <= project.target) slot++;
        if (slot > project.target) break;
        source.assignments[i] = slot;
        used.add(slot);
      }
  }
  function setGrid(project, source, columns, rows) {
    dimensions(columns, rows);
    if (source.width < columns * 2 || source.height < rows * 2)
      throw new Error("1コマが小さすぎます。列数・行数を減らしてください。");
    const previousLength = source.assignments.length;
    source.columns = columns;
    source.rows = rows;
    source.xs = lines(columns);
    source.ys = lines(rows);
    delete source.autoGridXs;
    source.columnYs = null;
    source.manualColumnYs = false;
    source.assignments = Array.from(
      { length: columns * rows },
      (_, i) => source.assignments[i] || 0,
    );
    fillFree(project, source, previousLength);
  }
  function assignSlot(project, source, cell, value) {
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > project.target ||
      !Number.isInteger(cell) ||
      cell < 0 ||
      cell >= source.assignments.length
    )
      throw new Error("割り当て番号が正しくありません。");
    const old = source.assignments[cell];
    if (value)
      for (const other of project.sources) {
        const index = other.assignments.indexOf(value);
        if (index >= 0) {
          other.assignments[index] = old;
          break;
        }
      }
    source.assignments[cell] = value;
  }
  function encodeMask(mask, autoMask) {
    const runs = [];
    for (let i = 0; i < mask.length;) {
      if (mask[i] === autoMask[i]) {
        i++;
        continue;
      }
      const start = i,
        alpha = mask[i];
      while (i < mask.length && mask[i] !== autoMask[i] && mask[i] === alpha)
        i++;
      runs.push(start, i - start, alpha);
    }
    return runs;
  }
  function applyMask(mask, runs) {
    for (let i = 0; i < runs.length; i += 3)
      mask.fill(runs[i + 2], runs[i], runs[i] + runs[i + 1]);
  }
  function readProject(raw) {
    function fail() {
      throw new Error(
        "設定JSONの形式や値が正しくありません。STAMP atelierで保存した設定を選んでください。",
      );
    }
    const object = (v) => v && typeof v === "object" && !Array.isArray(v);
    const number = (v, min, max) =>
      typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
    const integer = (v, min, max) => Number.isInteger(v) && number(v, min, max);
    const color = (v) => typeof v === "string" && /^#[a-f\d]{6}$/i.test(v);
    const text = (v, limit) =>
      typeof v === "string" && Array.from(v).length <= limit;
    const insets = (v, max) =>
      object(v) && sides.every((side) => number(v[side], 0, max));
    if (
      !object(raw) ||
      raw.format !== "stamp-atelier-project" ||
      raw.version !== 1 ||
      raw.imageDataIncluded !== false ||
      !COUNTS.includes(raw.target) ||
      !Array.isArray(raw.slots) ||
      raw.slots.length !== 40 ||
      !Array.isArray(raw.sources) ||
      raw.sources.length > MAX_SOURCES
    )
      fail();
    const slots = raw.slots.map((slot) => {
      if (
        !object(slot) ||
        !text(slot.caption, 120) ||
        !object(slot.style) ||
        !["sans", "serif", "rounded"].includes(slot.style.font) ||
        !number(slot.style.size, 14, 64) ||
        !number(slot.style.x, 10, 90) ||
        !number(slot.style.y, 10, 90) ||
        !color(slot.style.color) ||
        typeof slot.style.outline !== "boolean" ||
        (slot.style.preset !== undefined &&
          ![
            "auto",
            "manual",
            "energetic",
            "pop",
            "cute",
            "gentle",
            "emphasis",
            "simple",
          ].includes(slot.style.preset)) ||
        (slot.style.autoPlace !== undefined &&
          typeof slot.style.autoPlace !== "boolean") ||
        (slot.style.safeMargin !== undefined &&
          ![10, 20].includes(slot.style.safeMargin)) ||
        (slot.style.outlineWidth !== undefined &&
          !number(slot.style.outlineWidth, 0, 12)) ||
        (slot.style.shadow !== undefined &&
          !number(slot.style.shadow, 0, 12)) ||
        (slot.style.angle !== undefined &&
          !number(slot.style.angle, -30, 30)) ||
        (slot.style.overrides !== undefined &&
          (!Array.isArray(slot.style.overrides) ||
            slot.style.overrides.length > 7 ||
            new Set(slot.style.overrides).size !==
              slot.style.overrides.length ||
            slot.style.overrides.some(
              (key) =>
                ![
                  "font",
                  "size",
                  "color",
                  "outline",
                  "outlineWidth",
                  "shadow",
                  "angle",
                ].includes(key),
            ))) ||
        (slot.cleanupEnabled !== undefined &&
          typeof slot.cleanupEnabled !== "boolean") ||
        !object(slot.layout) ||
        !number(slot.layout.scale, 20, 100) ||
        !number(slot.layout.x, 0, 100) ||
        !number(slot.layout.y, 0, 100) ||
        !insets(slot.crop, 40)
      )
        fail();
      let mask = null;
      if (slot.mask != null) {
        const m = slot.mask;
        if (
          !object(m) ||
          !text(m.key, 16000) ||
          !integer(m.width, 1, 600) ||
          !integer(m.height, 1, 600) ||
          !Array.isArray(m.runs) ||
          m.runs.length % 3 ||
          m.runs.length > m.width * m.height * 3
        )
          fail();
        let end = 0;
        for (let i = 0; i < m.runs.length; i += 3) {
          if (
            !integer(m.runs[i], end, m.width * m.height - 1) ||
            !integer(m.runs[i + 1], 1, m.width * m.height - m.runs[i]) ||
            !integer(m.runs[i + 2], 0, 255)
          )
            fail();
          end = m.runs[i] + m.runs[i + 1];
        }
        mask = {
          key: m.key,
          width: m.width,
          height: m.height,
          runs: m.runs.slice(),
        };
      }
      return {
        caption: slot.caption,
        cleanupEnabled: slot.cleanupEnabled !== false,
        style: {
          font: slot.style.font,
          size: slot.style.size,
          x: slot.style.x,
          y: slot.style.y,
          color: slot.style.color,
          outline: slot.style.outline,
          ...Object.fromEntries(
            [
              "preset",
              "autoPlace",
              "safeMargin",
              "outlineWidth",
              "shadow",
              "angle",
              "overrides",
            ]
              .filter((key) => slot.style[key] !== undefined)
              .map((key) => [
                key,
                key === "overrides" ? slot.style[key].slice() : slot.style[key],
              ]),
          ),
        },
        layout: {
          scale: slot.layout.scale,
          x: slot.layout.x,
          y: slot.layout.y,
        },
        crop: Object.fromEntries(sides.map((s) => [s, slot.crop[s]])),
        mask,
      };
    });
    const used = new Set();
    const sources = raw.sources.map((s) => {
      if (
        !object(s) ||
        !text(s.name, 255) ||
        typeof s.fingerprint !== "string" ||
        !/^(?:[a-f\d]{64}|sample-v1)$/.test(s.fingerprint) ||
        !integer(s.width, 20, 2560) ||
        !integer(s.height, 20, 2560)
      )
        fail();
      dimensions(s.columns, s.rows);
      if (
        s.width < s.columns * 2 ||
        s.height < s.rows * 2 ||
        !insets(s.insets, 20) ||
        !["auto", "white", "custom", "none"].includes(s.mode) ||
        !integer(s.tolerance, 0, 100) ||
        !color(s.color) ||
        !Array.isArray(s.assignments) ||
        s.assignments.length !== s.columns * s.rows
      )
        fail();
      for (const n of s.assignments) {
        if (!integer(n, 0, raw.target) || (n && used.has(n))) fail();
        if (n) used.add(n);
      }
      for (const [key, count] of [
        ["xs", s.columns],
        ["ys", s.rows],
      ]) {
        if (
          !Array.isArray(s[key]) ||
          s[key].length !== count + 1 ||
          s[key].some(
            (n, i) =>
              !number(n, 0, 1) ||
              (i &&
                n - s[key][i - 1] <
                  2 / (key === "xs" ? s.width : s.height) - 1e-9),
          )
        )
          fail();
      }
      if (s.autoGridXs !== undefined && (!Array.isArray(s.autoGridXs) ||
          s.autoGridXs.length !== s.xs.length ||
          s.autoGridXs.some((x, i) => x !== s.xs[i]))) fail();
      if (s.manualColumnYs !== undefined && typeof s.manualColumnYs !== "boolean") fail();
      if (s.columnYs != null) {
        if (!Array.isArray(s.columnYs) || s.columnYs.length !== s.columns) fail();
        for (const column of s.columnYs) {
          if (!Array.isArray(column) || column.length !== s.rows + 1 ||
              column.some((n, i) => !number(n, 0, 1) ||
                (i && n - column[i - 1] < 2 / s.height - 1e-9))) fail();
        }
      }
      if (s.manualColumnYs && !s.columnYs) fail();
      return {
        name: s.name,
        fingerprint: s.fingerprint,
        width: s.width,
        height: s.height,
        columns: s.columns,
        rows: s.rows,
        ...(s.autoGridXs ? { autoGridXs: s.autoGridXs.slice() } : {}),
        xs: s.xs.slice(),
        ys: s.ys.slice(),
        columnYs: s.columnYs ? s.columnYs.map((col) => col.slice()) : null,
        manualColumnYs: s.manualColumnYs === true,
        insets: Object.fromEntries(sides.map((k) => [k, s.insets[k]])),
        assignments: s.assignments.slice(),
        mode: s.mode,
        tolerance: s.tolerance,
        color: s.color,
      };
    });
    if (
      sources.reduce((total, s) => total + s.width * s.height, 0) > 32_000_000
    )
      fail();
    if (!integer(raw.main, 1, raw.target) || !integer(raw.tab, 1, raw.target))
      fail();
    return { target: raw.target, slots, sources, main: raw.main, tab: raw.tab };
  }
  const api = {
    COUNTS,
    MAX_SOURCES,
    MAX_CELLS,
    blankInsets,
    blankSlot,
    lines,
    dimensions,
    fillFree,
    setGrid,
    assignSlot,
    encodeMask,
    applyMask,
    readProject,
  };
  root.StampProject = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
