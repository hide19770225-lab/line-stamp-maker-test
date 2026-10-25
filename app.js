(() => {
  "use strict";
  const R = window.StampResidue,
    T = window.StampTypography,
    P = window.StampProject,
    C = window.StampCore,
    $ = (id) => document.getElementById(id);
  const easyRun = { phase: "idle", stage: "", error: "" };
  const EASY_VERSION = "easy-state-1";
  let lastValidation = null;
  const suggestionDrafts = new Map();
  const state = {
    sources: [],
    selectedSource: 0,
    selectedStamp: -1,
    main: 1,
    tab: 1,
    target: 40,
    slots: Array.from({ length: 40 }, P.blankSlot),
    busy: false,
    brush: "none",
    zipURL: null,
    zipFile: null,
    dirty: false,
  };
  let toastTimer,
    drawing = false,
    lastPoint = null,
    dragLine = null,
    textDrag = null,
    residueScan = null,
    matteProposal = null,
    residuePlacement = null,
    nextId = 1;
  const stamps = () =>
    state.sources
      .flatMap((source) =>
        source.stamps.filter(
          (stamp) =>
            stamp.slot <= state.target &&
            source.assignments[stamp.cell] === stamp.slot,
        ),
      )
      .sort((a, b) => a.slot - b.slot);
  function captureSlots(includeMasks = false) {
    for (const stamp of stamps()) {
      const slot = state.slots[stamp.slot - 1];
      Object.assign(slot, {
        caption: stamp.caption,
        cleanupEnabled: stamp.cleanupEnabled !== false,
        style: { ...stamp.style },
        layout: { ...stamp.layout },
        crop: { ...stamp.crop },
      });
      if (includeMasks)
        slot.mask = {
          key: stamp.maskKey,
          width: stamp.original.width,
          height: stamp.original.height,
          runs: P.encodeMask(stamp.mask, stamp.autoMask),
        };
    }
  }
  function notify(message, error = false, persistent = false) {
    clearTimeout(toastTimer);
    $("status").textContent = message;
    if ($("production-mode").value === "easy") {
      $("easy-progress").textContent = message;
      $("easy-progress").classList.toggle("error", error);
    }
    $("status").classList.toggle("error", error);
    $("status").hidden = false;
    if (!persistent)
      toastTimer = setTimeout(() => {
        $("status").hidden = true;
      }, 6500);
  }
  let bulkAudit = null;
  function updateCompletionStatus() {
    const all = stamps();
    const total = state.target || 40;
    const processed = all.length;
    const reviewed = all.filter((stamp) => stamp.reviewed).length;
    const percent = Math.round((reviewed / total) * 100);
    const node = $("completion-status");
    if (node) node.textContent =
      `スタンプ確認進捗：${percent}% ／ 加工 ${processed}/${total}枚・確認済み ${reviewed}/${total}枚` +
      (bulkAudit ? ` ／ 一括検査 ${bulkAudit.errors ? "問題あり" : bulkAudit.complete ? "完了" : "未完了"}` : " ／ 一括検査待ち");
  }
  function syncBulkControls() {
    const valid = bulkAudit && bulkAudit.complete && !bulkAudit.errors;
    $("bulk-visual").disabled = !valid;
    $("bulk-confirm").disabled = !valid || !$("bulk-visual").checked;
    $("bulk-visual").title = !bulkAudit
      ? "先に「全画像を自動検査して一覧確認」を押してください"
      : !bulkAudit.complete ? "全画像の加工を完了してください"
      : bulkAudit.errors ? "画像のエラーを個別編集して再検査してください"
      : "全画像を目視したらチェックしてください";
    updateCompletionStatus();
  }
  function resetBulkAudit() {
    bulkAudit = null;
    $("bulk-visual").checked = false;
    $("bulk-visual").disabled = true;
    $("bulk-confirm").disabled = true;
    $("bulk-results")
      .querySelectorAll("canvas")
      .forEach((canvas) => {
        canvas.width = canvas.height = 1;
      });
    $("bulk-results").replaceChildren();
    $("bulk-summary").textContent =
      "設定または画像が変更されました。一括検査を実行してください。";
    updateCompletionStatus();
  }
  function invalidate() {
    lastValidation = null;
    const active = new Set(stamps());
    for (const [slot, draft] of suggestionDrafts)
      if (!active.has(draft.stamp)) suggestionDrafts.delete(slot);
    resetBulkAudit();
    captureSlots();
    state.dirty = true;
    clearZip();
    updateEasyState();
  }
  function clearZip() {
    if (state.zipURL) {
      URL.revokeObjectURL(state.zipURL);
      state.zipURL = null;
    }
    state.zipFile = null;
    $("download-link").hidden = true;
    $("download-direct").hidden = true;
  }
  async function task(action) {
    if (state.busy) return;
    state.busy = true;
    document.body.classList.add("busy");
    const buttons = [
      ...document.querySelectorAll("button, input, select, textarea"),
    ].filter((button) => !button.disabled);
    buttons.forEach((button) => {
      button.disabled = true;
    });
    $("file-input").disabled = true;
    try {
      await action();
    } catch (error) {
      console.error(error);
      notify(
        error.message ||
          "処理できませんでした。画像を確認して再度お試しください。",
        true,
      );
    } finally {
      state.busy = false;
      document.body.classList.remove("busy");
      buttons.forEach((button) => {
        button.disabled = false;
      });
      $("file-input").disabled = false;
      syncBulkControls();
      updateEasyState();
    }
  }
  const frame = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, 0)),
    );
  function nextStep(index) {
    document
      .querySelectorAll(".steps li")
      .forEach((step, i) => step.classList.toggle("current", i === index));
  }
  const signature = (s) =>
    JSON.stringify([
      s.columns,
      s.rows,
      s.xs,
      s.ys,
      s.columnYs || null,
      C.activeRowGrid(s),
      s.manualColumnYs === true,
      s.mode,
      s.tolerance,
      s.color,
      s.insets,
      s.assignments,
    ]);
  function addSource(image, name, initialLayout = null) {
    const totalPixels =
      state.sources
        .filter((source) => source.image)
        .reduce((sum, source) => sum + source.width * source.height, 0) +
      image.width * image.height;
    if (totalPixels > 32_000_000)
      throw new Error(
        "端末のメモリ保護のため、元画像の合計画素数が上限を超えます。不要な元画像を削除してください。",
      );
    const pending = state.sources.find(
      (source) => !source.image && source.fingerprint === image.fingerprint,
    );
    if (pending) {
      if (pending.width !== image.width || pending.height !== image.height)
        throw new Error(
          "画像の向き・寸法が保存時と異なります。同じ環境で読み込むか、PNGで保存して制作してください。",
        );
      pending.image = image;
      state.selectedSource = state.sources.indexOf(pending);
    } else {
      if (state.sources.some((source) => !source.image))
        throw new Error(
          "保存設定の元画像と一致しません。JSONに記録した同じ元画像を選び直してください。",
        );
      if (state.sources.length >= P.MAX_SOURCES)
        throw new Error("元画像は最大40枚です。不要な画像を削除してください。");
      const pixels =
        state.sources.reduce(
          (total, source) => total + source.width * source.height,
          0,
        ) +
        image.width * image.height;
      if (pixels > 32_000_000)
        throw new Error(
          "端末のメモリ保護のため、元画像の合計画素数の上限に達しました。画像を小さくするか、不要な元画像を削除してください。",
        );
      const [columns, rows] =
        initialLayout || $("default-layout").value.split("x").map(Number);
      const source = {
        id: nextId++,
        image,
        name,
        fingerprint: image.fingerprint,
        width: image.width,
        height: image.height,
        columns,
        rows,
        xs: P.lines(columns),
        ys: P.lines(rows),
        insets: P.blankInsets(),
        assignments: Array(columns * rows).fill(0),
        stamps: [],
        mode: "auto",
        tolerance: 24,
        color: "#ffffff",
      };
      P.dimensions(columns, rows);
      if (columns * 2 > source.width || rows * 2 > source.height)
        throw new Error(
          "画像が小さすぎます。初期配置の列数・行数を減らしてください。",
        );
      state.sources.push(source);
      P.fillFree(state, source);
      state.selectedSource = state.sources.length - 1;
    }
    invalidate();
    renderSources();
    renderSourceEditor();
    nextStep(1);
  }
  async function decodeFile(file) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) &&
      !/\.(png|jpe?g|webp)$/i.test(file.name)
    )
      throw new Error(`${file.name}: PNG・JPEG・WebPを選んでください。`);
    if (file.size > 40 * 1024 * 1024)
      throw new Error(`${file.name}: 40MB以内の画像を選んでください。`);
    let image, release;
    if (typeof createImageBitmap === "function") {
      try {
        image = await createImageBitmap(file, {
          imageOrientation: "from-image",
        });
        release = () => image.close();
      } catch {
        /* Safari fallback below. */
      }
    }
    if (!image) {
      const url = URL.createObjectURL(file),
        img = new Image();
      try {
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () =>
            reject(
              new Error(
                "画像を読み込めませんでした。別のPNG/JPEG画像をお試しください。",
              ),
            );
          img.src = url;
        });
        image = img;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const width = image.width || image.naturalWidth,
      height = image.height || image.naturalHeight;
    if (width < 20 || height < 20) {
      release?.();
      throw new Error(
        "画像が小さすぎます。縦横20px以上の画像を選んでください。",
      );
    }
    // Bound retained memory on mobile. Original file is never retained or transmitted.
    const ratio = Math.min(1, 2560 / Math.max(width, height)),
      output = C.canvas(Math.round(width * ratio), Math.round(height * ratio));
    output.getContext("2d").drawImage(image, 0, 0, output.width, output.height);
    release?.();
    if (!crypto.subtle)
      throw new Error(
        "画像照合のためHTTPS、またはローカルサーバーで開いてください。",
      );
    const hash = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    output.fingerprint = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return output;
  }
  async function importFiles(files, easy = false) {
    if (state.busy) return;
    const easyMessages = [];
    const remaining =
      P.MAX_SOURCES - state.sources.filter((source) => source.image).length;
    if (remaining <= 0) {
      notify(
        "読み込める元画像は最大40枚です。不要な画像を削除してください。",
        true,
      );
      return;
    }
    const chosen = Array.from(files).slice(0, remaining);
    if (files.length > remaining)
      notify(`最大40枚までのため、先頭の${remaining}枚を読み込みます。`);
    await task(async () => {
      let loaded = 0;
      for (const file of chosen) {
        notify(
          `画像を読み込み中… ${loaded + 1} / ${chosen.length}`,
          false,
          true,
        );
        await frame();
        try {
          const image = await decodeFile(file);
          if (
            easy &&
            state.sources.some(
              (source) =>
                source.image && source.fingerprint === image.fingerprint,
            )
          ) {
            image.width = image.height = 1;
            easyMessages.push(
              `${file.name}は同じ画像が重複しています。追加していません。`,
            );
            continue;
          }
          const selectedLayout = easy ? $("easy-layout").value : "";
          const singleNewSheet = chosen.length === 1 &&
            state.sources.filter((source) => source.image).length === 0;
          const likelyFortySheet = singleNewSheet && state.target === 40 &&
            image.width / image.height >= 0.65 &&
            image.width / image.height <= 1.15;
          const easyLayout = easy
            ? (selectedLayout === "auto"
                ? (likelyFortySheet ? [5, 8] : [2, 5])
                : selectedLayout.split("x").map(Number))
            : null;
          addSource(image, file.name, easyLayout);
          if (easy && easyLayout) easyMessages.push(
            `${file.name}：${easyLayout[0]}列×${easyLayout[1]}段で読み込みました。違う場合は詳細調整で修正してください。`
          );
          loaded++;
        } catch (error) {
          if (easy) easyMessages.push(`${file.name}：${error.message}`);
          notify(error.message, true);
        }
      }
      if (loaded) {
        renderResults();
        notify(`${loaded}枚を読み込みました。②で一括加工し、必要に応じてセリフ候補を確認してください。`);
      }
    });
    $("file-input").value = "";
    if (easy) {
      $("easy-files").value = "";
      easyWarnings([
        ...easyMessages,
        ...easyPlan().errors,
        ...easyPlan().warnings,
      ]);
      notify(
        "画像を読み込みました。配置を確認して②の一括加工を押してください。",
        false,
        true,
      );
    }
    syncEasySources();
  }
  window.stampImportNormalFiles = async (files) => {
    await importFiles(files, false);
  };
  window.dispatchEvent(new Event("stamp-import-ready"));
  for (const type of ["dragenter", "dragover"])
    $("dropzone").addEventListener(type, (e) => {
      e.preventDefault();
      $("dropzone").classList.add("dragover");
    });
  for (const type of ["dragleave", "drop"])
    $("dropzone").addEventListener(type, (e) => {
      e.preventDefault();
      $("dropzone").classList.remove("dragover");
      if (type === "drop" && !state.busy) importFiles(e.dataTransfer.files);
    });
  $("sample-button").addEventListener("click", () => {
    if (
      state.sources.length >= P.MAX_SOURCES &&
      !state.sources.some((source) => !source.image)
    ) {
      notify("元画像は最大40枚です。", true);
      return;
    }
    const image = C.canvas(800, 1600),
      ctx = image.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 800, 1600);
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 2; col++) {
        const x = col * 400 + 200,
          y = row * 320 + 155;
        ctx.save();
        ctx.translate(x, y);
        ctx.lineWidth = 7;
        ctx.strokeStyle = "#44664d";
        ctx.fillStyle = "#fffef4";
        for (const ex of [-63, 63]) {
          ctx.beginPath();
          ctx.ellipse(ex, -78, 30, 60, ex < 0 ? -0.25 : 0.25, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.ellipse(0, 8, 107, 91, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#eeb7ae";
        for (const ex of [-66, 66]) {
          ctx.beginPath();
          ctx.ellipse(ex, 30, 21, 12, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#44664d";
        for (const ex of [-35, 35]) {
          ctx.beginPath();
          ctx.arc(ex, 0, 6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(-15, 32);
        ctx.quadraticCurveTo(0, 48 + row * 2, 15, 32);
        ctx.stroke();
        ctx.fillStyle = ["#6c9471", "#d2a591", "#b5accc", "#c2b16b", "#8dbac0"][
          row
        ];
        ctx.beginPath();
        ctx.ellipse(0, 112, 39, 15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    image.fingerprint = "sample-v1";
    try {
      addSource(
        image,
        `おためし・白うさぎ ${state.sources.length + 1}`,
        [2, 5],
      );
    } catch (error) {
      notify(error.message, true);
      return;
    }
    renderResults();
    notify("サンプルを追加しました。白い体を残した透過を試せます。");
  });
  function renderSources() {
    $("source-count").textContent = `${state.sources.length} / 40 枚`;
    $("source-list").replaceChildren();
    $("source-select").replaceChildren();
    state.sources.forEach((source, index) => {
      const card = document.createElement("div");
      card.className = "source-card";
      const thumb = C.canvas(48, 60);
      if (source.image)
        thumb.getContext("2d").drawImage(source.image, 0, 0, 48, 60);
      const img = document.createElement("img");
      img.src = thumb.toDataURL();
      img.alt = `元画像 ${index + 1}`;
      const name = document.createElement("div");
      name.className = "source-name";
      name.textContent = source.name;
      const detail = document.createElement("small");
      detail.textContent = `${source.columns}列×${source.rows}段 · ${source.assignments.filter(Boolean).length}個を採用 · ${!source.image ? "元画像を再選択" : source.stamps.length ? (source.processSignature === signature(source) ? "加工済み" : "再加工が必要") : "未加工"}`;
      name.append(detail);
      const edit = document.createElement("button");
      edit.textContent = "調整";
      edit.setAttribute("aria-label", `元画像${index + 1}を調整`);
      edit.onclick = () => {
        if (state.busy) return;
        state.selectedSource = index;
        renderSourceEditor();
        $("split-section").scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
      };
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.setAttribute("aria-label", `元画像${index + 1}を削除`);
      remove.onclick = () => {
        if (
          state.busy ||
          !confirm(
            "この元画像と番号の割り当てを削除しますか？番号ごとのセリフ・加工設定は残ります。",
          )
        )
          return;
        captureSlots(true);
        if (source.image) source.image.width = source.image.height = 1;
        state.sources.splice(index, 1);
        state.selectedSource = Math.min(
          state.selectedSource,
          state.sources.length - 1,
        );
        invalidate();
        renderSources();
        renderSourceEditor();
        renderResults();
      };
      card.append(img, name, edit, remove);
      if (!source.image) {
        const label = document.createElement("label"),
          input = document.createElement("input");
        label.className = "button secondary project-file";
        label.textContent = "元画像を再選択";
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp";
        input.onchange = () => {
          const file = input.files[0];
          if (!file) return;
          task(async () => {
            const image = await decodeFile(file);
            if (image.fingerprint !== source.fingerprint)
              throw new Error(
                "元画像が一致しません。保存時と同じファイルを選んでください。",
              );
            if (source.width !== image.width || source.height !== image.height)
              throw new Error("画像の寸法が保存時と異なります。");
            const total =
              state.sources
                .filter((s) => s.image)
                .reduce((sum, s) => sum + s.width * s.height, 0) +
              image.width * image.height;
            if (total > 32_000_000)
              throw new Error("元画像の合計画素数が上限を超えます。");
            source.image = image;
            state.selectedSource = index;
            invalidate();
            renderSources();
            renderSourceEditor();
            renderResults();
            notify(
              "元画像が一致しました。加工ボタンで仕上がりを再作成できます。",
            );
          });
        };
        label.append(input);
        card.append(label);
      }
      $("source-list").append(card);
      $("source-select").add(
        new Option(`${index + 1}. ${source.name}`, String(index)),
      );
    });
    $("source-select").value = String(state.selectedSource);
    const source = state.sources[state.selectedSource];
    $("process-button").textContent = source
      ? `この画像の${source.assignments.filter(Boolean).length}個を分割・透過する →`
      : "分割・背景透過する →";
  }
  $("source-select").onchange = () => {
    state.selectedSource = Number($("source-select").value);
    renderSourceEditor();
  };
  function renderSourceEditor() {
    const source = state.sources[state.selectedSource];
    $("split-section").hidden = !source;
    if (!source) return;
    $("source-select").value = String(state.selectedSource);
    $("grid-columns").value = source.columns;
    $("grid-rows").value = source.rows;
    const preset = `${source.columns}x${source.rows}`;
    $("layout-preset").value = [...$("layout-preset").options].some(
      (option) => option.value === preset,
    )
      ? preset
      : "custom";
    $("source-ready").textContent = source.image
      ? `元画像${state.selectedSource + 1}：${source.assignments.filter(Boolean).length}個を採用。番号とセリフを確認して加工してください。`
      : "元画像はJSONに含まれません。上の元画像一覧から同じファイルを再選択してください。";
    renderAssignments();
    $("background-mode").value = source.mode;
    $("background-color").value = source.color;
    $("tolerance").value = source.tolerance;
    $("tolerance-value").textContent = source.tolerance;
    renderGridControls();
    insetControls("source-insets", source.insets, 20, () => {
      invalidate();
      drawSplit();
    });
    drawSplit();
    renderSources();
  }
  function renderAssignments() {
    const source = state.sources[state.selectedSource];
    $("cell-assignments").replaceChildren();
    source.assignments.forEach((slot, cell) => {
      const label = document.createElement("label");
      label.textContent = `元コマ ${cell + 1}`;
      const select = document.createElement("select");
      select.dataset.cell = cell;
      select.add(new Option("除外", "0"));
      for (let n = 1; n <= state.target; n++)
        select.add(
          new Option(
            `${String(n).padStart(2, "0")}.png · ${state.slots[n - 1].caption || "セリフなし"}`,
            String(n),
          ),
        );
      select.value = String(slot);
      select.onchange = () => {
        captureSlots(true);
        P.assignSlot(state, source, cell, Number(select.value));
        invalidate();
        renderSourceEditor();
        renderResults();
      };
      label.append(select);
      $("cell-assignments").append(label);
    });
  }
  function changeLayout(columns, rows) {
    const source = state.sources[state.selectedSource];
    try {
      P.dimensions(columns, rows);
      if (
        source.stamps.length &&
        !confirm(
          "配置を変更します。セリフと加工設定は番号に残ります。コマの割り当てを確認し、再加工してください。",
        )
      )
        return;
      captureSlots(true);
      P.setGrid(state, source, columns, rows);
      invalidate();
      renderSourceEditor();
      renderResults();
    } catch (error) {
      notify(error.message, true);
      renderSourceEditor();
    }
  }
  $("layout-preset").onchange = () => {
    if ($("layout-preset").value !== "custom")
      changeLayout(...$("layout-preset").value.split("x").map(Number));
  };
  $("apply-layout").onclick = () =>
    changeLayout(Number($("grid-columns").value), Number($("grid-rows").value));
  $("assign-free").onclick = () => {
    captureSlots(true);
    P.fillFree(state, state.sources[state.selectedSource]);
    invalidate();
    renderSourceEditor();
    renderResults();
  };
  function insetControls(id, values, max, onChange) {
    $(id).replaceChildren();
    for (const [key, title] of [
      ["top", "上"],
      ["bottom", "下"],
      ["left", "左"],
      ["right", "右"],
    ]) {
      const label = document.createElement("label"),
        output = document.createElement("output"),
        input = document.createElement("input");
      const inputId = `${id}-${key}`;
      label.htmlFor = inputId;
      label.append(`${title}から切り抜く `);
      output.textContent = `${values[key]} %`;
      label.append(output);
      input.id = inputId;
      input.type = "range";
      input.min = "0";
      input.max = String(max);
      input.step = "0.5";
      input.value = values[key];
      input.oninput = () => {
        values[key] = Number(input.value);
        output.textContent = `${values[key]} %`;
        onChange();
      };
      $(id).append(label, input);
    }
  }
  function renderGridControls() {
    const source = state.sources[state.selectedSource];
    $("grid-controls").replaceChildren();
    if (source.cropReport?.length) {
      const details = document.createElement("details");
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = `前回の実切り抜き座標（${source.cropMethod}）`;
      const pre = document.createElement("pre");
      pre.style.whiteSpace = "pre-wrap";
      pre.style.overflowWrap = "anywhere";
      pre.textContent = source.cropReport.join("\n");
      details.append(summary, pre);
      $("grid-controls").append(details);
    }

    if (source.columns >= 2 && source.rows >= 2) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = source.manualColumnYs
        ? "列ごとの横線調整を終了"
        : "列ごとに横線を細かく調整（40個対応）";
      toggle.onclick = () => {
        source.manualColumnYs = !source.manualColumnYs;
        if (source.manualColumnYs) {
          source.columnYs = source.columnYs && source.columnYs.length === source.columns
            ? source.columnYs : Array.from({ length: source.columns }, () => source.ys.slice());
        } else {
          source.columnYs = null;
        }
        invalidate();
        renderGridControls();
        drawSplit();
      };
      $("grid-controls").append(toggle);
      if (source.manualColumnYs) {
        for (let col = 0; col < source.columns; col++) {
          for (let row = 1; row < source.rows; row++) {
            const label = document.createElement("label");
            label.textContent = `${col + 1}列目・${row}段目の下（%）`;
            const input = document.createElement("input");
            input.type = "number";
            input.inputMode = "decimal";
            input.min = "0"; input.max = "100"; input.step = ".1";
            input.value = (source.columnYs[col][row] * 100).toFixed(1);
            input.onchange = () => {
              const lines = source.columnYs[col];
              const value = Number(input.value) / 100;
              if (!Number.isFinite(value)) return;
              const gap = Math.max(0.004, 2 / source.height);
              lines[row] = Math.max(lines[row-1]+gap,
                Math.min(lines[row+1]-gap, value));
              input.value = (lines[row] * 100).toFixed(1);
              invalidate(); drawSplit();
            };
            label.append(input);
            $("grid-controls").append(label);
          }
        }
      }
    }
    for (const [axis, values] of [
      ["xs", source.xs],
      ["ys", source.ys],
    ])
      values.forEach((value, i) => {
        const label = document.createElement("label");
        label.textContent = `${axis === "xs" ? "縦" : "横"}線 ${i + 1}（%）`;
        const input = document.createElement("input");
        input.type = "number";
        input.inputMode = "decimal";
        input.min = "0";
        input.max = "100";
        input.step = ".1";
        input.value = (value * 100).toFixed(1);
        input.onchange = () => {
          changeGrid(axis, i, Number(input.value) / 100);
          input.value = (source[axis][i] * 100).toFixed(1);
          drawSplit();
        };
        label.append(input);
        $("grid-controls").append(label);
      });
  }
  function changeGrid(axis, index, value) {
    const s = state.sources[state.selectedSource],
      lines = s[axis];
    if (!Number.isFinite(value)) return;
    const gap = Math.max(0.004, 2 / (axis === "xs" ? s.width : s.height));
    // Moving a shared horizontal guide should not silently erase all
    // carefully adjusted per-column boundaries.
    if (axis === "ys" && s.manualColumnYs && s.columnYs) {
      const previous = lines[index];
      const next = Math.max(
        index ? lines[index - 1] + gap : 0,
        Math.min(index < lines.length - 1 ? lines[index + 1] - gap : 1, value),
      );
      const delta = next - previous;
      lines[index] = next;
      for (const column of s.columnYs) {
        column[index] = Math.max(
          index ? column[index - 1] + gap : 0,
          Math.min(index < column.length - 1 ? column[index + 1] - gap : 1,
            column[index] + delta),
        );
      }
      invalidate();
      return;
    }
    if (axis === "xs") {
      delete s.autoGridXs;
      // Vertical guides remain compatible with independent row boundaries.
    } else {
      s.columnYs = null;
      s.manualColumnYs = false;
    }
    lines[index] = Math.max(
      index ? lines[index - 1] + gap : 0,
      Math.min(index < lines.length - 1 ? lines[index + 1] - gap : 1, value),
    );
    invalidate();
  }
  function drawSplit() {
    const source = state.sources[state.selectedSource];
    if (!source) return;
    const c = $("split-canvas");
    if (!source.image) {
      c.width = 300;
      c.height = 140;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#edf5ee";
      ctx.fillRect(0, 0, 300, 140);
      ctx.fillStyle = "#217653";
      ctx.font = "14px sans-serif";
      ctx.fillText("同じ元画像を再選択してください", 32, 75);
      return;
    }
    const ratio = Math.min(
      1,
      640 / Math.max(source.image.width, source.image.height),
    );
    c.width = Math.round(source.image.width * ratio);
    c.height = Math.round(source.image.height * ratio);
    const ctx = c.getContext("2d");
    ctx.drawImage(source.image, 0, 0, c.width, c.height);
    ctx.fillStyle = "#173b2a66";
    ctx.fillRect(0, 0, source.xs[0] * c.width, c.height);
    ctx.fillRect(source.xs[source.columns] * c.width, 0, c.width, c.height);
    ctx.fillRect(
      source.xs[0] * c.width,
      0,
      (source.xs[source.columns] - source.xs[0]) * c.width,
      source.ys[0] * c.height,
    );
    ctx.fillRect(
      source.xs[0] * c.width,
      source.ys[source.rows] * c.height,
      (source.xs[source.columns] - source.xs[0]) * c.width,
      c.height,
    );
    ctx.strokeStyle = "#21875c";
    ctx.lineWidth = 2;
    const rowGrid = C.activeRowGrid(source);
    if (rowGrid) {
      for (let row = 0; row < source.rows; row++)
        for (const x of rowGrid.xs[row]) {
          ctx.beginPath();ctx.moveTo(x*c.width,rowGrid.ys[row]*c.height);
          ctx.lineTo(x*c.width,rowGrid.ys[row+1]*c.height);ctx.stroke();
        }
    }
    for (const x of rowGrid ? [] : source.xs) {
      const xx = Math.max(1, Math.min(c.width - 1, x * c.width));
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, c.height);
      ctx.stroke();
    }
    if (source.columnYs) {
      for (let col = 0; col < source.columns; col++) {
        ctx.strokeStyle = col % 2 ? "#dc542c" : "#21875c";
        for (const y of source.columnYs[col]) {
          const yy = Math.max(1, Math.min(c.height - 1, y * c.height));
          ctx.beginPath();
          ctx.moveTo(source.xs[col] * c.width, yy);
          ctx.lineTo(source.xs[col + 1] * c.width, yy);
          ctx.stroke();
        }
      }
    } else {
      for (const y of rowGrid?.ys || source.ys) {
        const yy = Math.max(1, Math.min(c.height - 1, y * c.height));
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(c.width, yy);
        ctx.stroke();
      }
    }
    if (Object.values(source.insets).some((value) => value > 0)) {
      ctx.save();
      ctx.strokeStyle = "#b87522";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      for (let row = 0; row < source.rows; row++)
        for (let col = 0; col < source.columns; col++) {
          const rect = C.tileRect(source, col, row);
          ctx.strokeRect(
            rect.x * ratio,
            rect.y * ratio,
            rect.width * ratio,
            rect.height * ratio,
          );
        }
      ctx.restore();
    }
    for (let r = 0; r < source.rows; r++)
      for (let col = 0; col < source.columns; col++) {
        const slot = source.assignments[r * source.columns + col];
        ctx.fillStyle = slot ? "#217653" : "#9c7565";
        ctx.fillRect(
          (rowGrid?.xs[r] || source.xs)[col] * c.width + 5,
          (rowGrid?.ys || source.columnYs?.[col] || source.ys)[r] * c.height + 5,
          22,
          20,
        );
        ctx.fillStyle = "white";
        ctx.font = "11px sans-serif";
        ctx.fillText(
          slot ? String(slot).padStart(2, "0") : "×",
          (rowGrid?.xs[r] || source.xs)[col] * c.width + 9,
          (rowGrid?.ys || source.columnYs?.[col] || source.ys)[r] * c.height + 19,
        );
      }
  }
  $("split-canvas").onpointerdown = (e) => {
    if (state.busy || !state.sources[state.selectedSource]?.image) return;
    if (C.activeRowGrid(state.sources[state.selectedSource])) {
      notify("行別の自動境界を表示しています。手動調整する場合は、配置設定の列・行スライダーを変更して再加工してください。");
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect(),
      source = state.sources[state.selectedSource];
    const x = (e.clientX - rect.left) / rect.width,
      y = (e.clientY - rect.top) / rect.height;
    const nextColumn = source.xs.findIndex((v) => v > x);
    const column = Math.max(0, Math.min(source.columns - 1,
      nextColumn < 0 ? source.columns - 1 : nextColumn - 1));
    const candidates = [
      ...source.xs.map((v, i) => ({
        axis: "xs",
        i,
        distance: Math.abs(v - x) * rect.width,
      })),
      ...(source.columnYs?.[column] || source.ys).map((v, i) => ({
        axis: "ys",
        i,
        column: source.columnYs ? column : null,
        distance: Math.abs(v - y) * rect.height,
      })),
    ].sort((a, b) => a.distance - b.distance);
    if (candidates[0].distance < 28) {
      dragLine = candidates[0];
      if (dragLine.column !== null && dragLine.column !== undefined)
        source.manualColumnYs = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };
  $("split-canvas").onpointermove = (e) => {
    if (!dragLine) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (dragLine.column !== null && dragLine.column !== undefined) {
      const source = state.sources[state.selectedSource];
      const lines = source.columnYs[dragLine.column], i = dragLine.i;
      const gap = Math.max(0.004, 2 / source.height);
      lines[i] = Math.max(i ? lines[i - 1] + gap : 0,
        Math.min(i < lines.length - 1 ? lines[i + 1] - gap : 1,
          (e.clientY - r.top) / r.height));
      invalidate(); drawSplit();
      return;
    }
    changeGrid(
      dragLine.axis,
      dragLine.i,
      dragLine.axis === "xs"
        ? (e.clientX - r.left) / r.width
        : (e.clientY - r.top) / r.height,
    );
    drawSplit();
  };
  function endGridDrag() {
    if (dragLine) {
      dragLine = null;
      renderGridControls();
    }
  }
  $("split-canvas").onpointerup = endGridDrag;
  $("split-canvas").onpointercancel = endGridDrag;
  $("reset-grid").onclick = () => {
    const source = state.sources[state.selectedSource];
    source.xs = P.lines(source.columns);
    source.ys = P.lines(source.rows);
    source.columnYs = null;
    source.manualColumnYs = false;
    invalidate();
    renderSourceEditor();
  };
  for (const id of ["background-mode", "background-color", "tolerance"])
    $(id).addEventListener("input", () => {
      const source = state.sources[state.selectedSource];
      if (!source) return;
      source.mode = $("background-mode").value;
      source.color = $("background-color").value;
      source.tolerance = Number($("tolerance").value);
      $("tolerance-value").textContent = source.tolerance;
      invalidate();
    });
  async function processSource(source) {
    if (!source.image)
      throw new Error(`${source.name}の元画像を再選択してください。`);
    captureSlots(true);
    // Respect manually adjusted grid lines. Suggest gutters only on the
    // untouched equal grid and only when every boundary has a clean corridor.
    const defaultGrid = (values) =>
      values.every((value, index) =>
        Math.abs(value - index / (values.length - 1)) < 0.0001,
      );
    // Manual column boundaries have been explicitly placed by the user.
    // Clear any stale *automatic gutter* warning, but preserve the independent
    // pixel-edge review returned by createTile for each individual sticker.
    if (source.manualColumnYs && source.columnYs) {
      source.gutterUncertain = false;
    }
    const automaticColumns = source.autoGridXs &&
      source.xs.every((x, i) => x === source.autoGridXs[i]);
    if (!source.manualColumnYs && (defaultGrid(source.xs) || automaticColumns) && defaultGrid(source.ys)) {
      // Establish column gutters independently: requiring shared row gutters
      // first rejects staggered sheets, while equal columns can split guide digits.
      const vertical = C.suggestGridLines(source.image, source.columns, 1);
      const detectedXs = vertical ? vertical.xs : source.xs;
      // Use column-specific boundaries when each column has clear white gutters.
      // Never silently fall back to a potentially destructive shared row line.
      const uncertainCuts = [];
      const columnLines = C.suggestColumnRowLines(
        source.image, detectedXs, source.rows, uncertainCuts,
      );
      if (vertical && columnLines) {
        source.xs = detectedXs;
        source.autoGridXs = [...detectedXs];
      }
      source.uncertainCuts = columnLines && vertical ? uncertainCuts :
        Array.from({ length: source.columns }, (_, column) =>
          Array.from({ length: source.rows + 1 }, (_, boundary) => ({ column, boundary })),
        ).flat();
      source.columnYs = columnLines || null;
      source.gutterUncertain = !vertical || !columnLines || (source.columns === 5 && source.rows === 8 && source.insets.left === 0 && source.insets.right === 0);
      delete source.autoRowGrid;
      if (!vertical || !columnLines || uncertainCuts.length) {
        const rowGrid = C.suggestRowGrid(source.image, source.columns, source.rows);
        if (rowGrid) {
          source.autoRowGrid = {...rowGrid, key: JSON.stringify([source.xs, source.ys, !!source.manualColumnYs])};
          source.columnYs = null;
          source.uncertainCuts = [];
          source.gutterUncertain = false;
        }
      }
      // Never substitute a shared horizontal boundary for a failed
      // column-specific search: it can cut off ears in staggered sheets.
    }
    if (!source.manualColumnYs && (!defaultGrid(source.xs) || !defaultGrid(source.ys)) &&
        !(source.autoGridXs && source.xs.every((x, i) => x === source.autoGridXs[i]) && defaultGrid(source.ys))) {
      source.columnYs = null;
      source.gutterUncertain = false; // User explicitly chose manual grid lines.
    }
    const tiles = [],
      count = source.assignments.filter(Boolean).length;
    if (!count)
      throw new Error(
        "採用するコマがありません。コマに番号を割り当ててください。",
      );
    for (let cell = 0; cell < source.assignments.length; cell++) {
      const number = source.assignments[cell];
      if (!number) continue;
      if (easyRun.phase === "processing") {
        easyRun.stage = `分割・背景透過：${source.name} / ${String(number).padStart(2, "0")}.png`;
        updateEasyState();
      }
      notify(`分割・背景透過中… ${tiles.length + 1} / ${count}`, false, true);
      await frame();
      const stamp = C.createTile(
        source,
        cell % source.columns,
        Math.floor(cell / source.columns),
        source.mode,
        source.tolerance,
        source.color,
      );
      const column = cell % source.columns, row = Math.floor(cell / source.columns);
      const uncertainCell = !source.manualColumnYs && source.uncertainCuts?.some(
        cut => cut.column === column && (cut.boundary === row || cut.boundary === row + 1),
      );
      stamp.individualReviewRequired = !!uncertainCell || C.paintedCheckerboard(stamp.original);
      if (source.gutterUncertain || uncertainCell) {
        stamp.boundaryReview = {
          needsReview: true,
          edges: [...stamp.boundaryReview.edges, "分割位置未確定"],
        };
      }
      // Display the actual pixel coordinates used, not just the suggested
      // grid. These values are recorded by createTile -> tileRect.
      const used = stamp.sourceRect;
      if (used) {
        const bottom = used.y + used.height;
        const right = used.x + used.width;
        stamp.cropDiagnostic =
          `元画像切抜 #${String(number).padStart(2,"0")}: ` +
          `x=${used.x}..${right}, y=${used.y}..${bottom}` +
          ` (元画像 ${source.width}×${source.height})`;
        console.info("[stamp-crop]", stamp.cropDiagnostic);
      }
      stamp.slot = number;
      stamp.cell = cell;
      stamp.maskKey = JSON.stringify([
        source.fingerprint,
        signature(source),
        source.columnYs?.[cell % source.columns] || null,
        cell,
        stamp.original.width,
        stamp.original.height,
      ]);
      const settings = state.slots[number - 1];
      Object.assign(stamp, {
        caption: settings.caption,
        cleanupEnabled: settings.cleanupEnabled !== false,
        style: { ...settings.style },
        layout: { ...settings.layout },
        crop: { ...settings.crop },
      });
      if (
        settings.mask?.key === stamp.maskKey &&
        settings.mask.width === stamp.original.width &&
        settings.mask.height === stamp.original.height
      )
        P.applyMask(stamp.mask, settings.mask.runs);
      tiles.push(stamp);
    }
    source.stamps = tiles;
    source.cropReport = tiles.map((stamp) => stamp.cropDiagnostic).filter(Boolean);
    source.cropMethod = source.manualColumnYs
      ? "列別・手動調整"
      : C.activeRowGrid(source) ? "行別の列境界・自動検出" : source.columnYs ? "列別・自動検出" : "共通線・要確認";
    source.processSignature = signature(source);
    invalidate();
    if (state.sources[state.selectedSource] === source) renderGridControls();
  }
  function finishedProcessing() {
    renderSources();
    renderResults();
    nextStep(2);
    notify(
      "加工しました。番号・セリフ・画像の対応と透過を一覧で確認してください。",
    );
    $("results-section").scrollIntoView({ block: "start", behavior: "smooth" });
  }
  $("process-button").onclick = () =>
    task(async () => {
      await processSource(state.sources[state.selectedSource]);
      finishedProcessing();
    });
  $("process-all").onclick = () =>
    task(async () => {
      for (const source of state.sources)
        if (
          source.assignments.some(Boolean) &&
          (source.processSignature !== signature(source) ||
            !source.stamps.length)
        )
          await processSource(source);
      finishedProcessing();
    });
  function renderResults() {
    if ($("auto-caption-panel"))
      $("auto-caption-panel").hidden = !state.sources.some(
        (source) => source.image,
      );
    const all = stamps();
    $("results-section").hidden = !all.length;
    $("export-section").hidden = !all.length;
    $("stamp-count").textContent = `${all.length} / ${state.target} 個`;
    $("stamp-grid").replaceChildren();
    all.forEach((stamp, i) => {
      const button = document.createElement("button");
      button.className = `stamp-card${stamp.reviewed ? " reviewed" : ""}`;
      button.setAttribute(
        "aria-label",
        `スタンプ${stamp.slot}を編集・透過確認`,
      );
      const c = C.canvas(370, 320);
      c.className = "stamp-canvas";
      C.renderStamp(stamp, c);
      const footer = document.createElement("footer"),
        number = document.createElement("span"),
        review = document.createElement("span");
      number.textContent = `${String(stamp.slot).padStart(2, "0")}.png`;
      review.className = "review-state";
      review.textContent = stamp.reviewed ? "✓ 確認済み" : "透過を確認";
      footer.append(number, review);
      const caption = document.createElement("p");
      caption.className = "stamp-caption";
      caption.textContent = stamp.caption || "（セリフなし）";
      button.append(c, footer, caption);
      button.onclick = () => {
        if (!state.busy) openEditor(i);
      };
      $("stamp-grid").append(button);
    });
    for (const id of ["main-select", "tab-select"]) {
      $(id).replaceChildren();
      for (let slot = 1; slot <= state.target; slot++)
        $(id).add(
          new Option(
            `スタンプ ${String(slot).padStart(2, "0")}${all.some((stamp) => stamp.slot === slot) ? "" : "（未加工）"}`,
            String(slot),
          ),
        );
    }
    $("main-select").value = String(state.main);
    $("tab-select").value = String(state.tab);
    updateSpecial();
    updateValidation();
    renderCaptionList();
    if (!easyCaptionDirty)
      $("easy-captions").value = state.slots
        .map((slot) => slot.caption)
        .join("\n")
        .replace(/\n+$/, "");
    syncEasySources();
    if ($("suggestion-panel")?.open) renderSuggestionPanel();
    $("overview-count-tag").textContent = `${state.target} STAMPS`;
    $("overview-stamp-total").firstChild.nodeValue = String(state.target);
  }
  function copyCanvas(from, to) {
    to.width = from.width;
    to.height = from.height;
    to.getContext("2d").drawImage(from, 0, 0);
  }
  function updateSpecial(changedSlots = null) {
    const all = stamps();
    for (const [slot, id, width, height] of [
      [state.main, "main-preview", 240, 240],
      [state.tab, "tab-preview", 96, 74],
    ]) {
      if (changedSlots && !changedSlots.includes(slot)) continue;
      const stamp = all.find((stamp) => stamp.slot === slot),
        canvas = $(id);
      canvas.getContext("2d").clearRect(0, 0, width, height);
      if (stamp) copyCanvas(C.specialImage(stamp, width, height), canvas);
    }
  }
  for (const [id, key] of [
    ["main-select", "main"],
    ["tab-select", "tab"],
  ])
    $(id).onchange = () => {
      state[key] = Number($(id).value);
      invalidate();
      updateSpecial();
    };
  $("preview-background").onchange = () => {
    $("stamp-grid").className = `stamp-grid ${$("preview-background").value}`;
    $("bulk-results").className =
      `bulk-results ${$("preview-background").value}`;
  };
  // Inspection is read-only and uses the exact final PNG renderer used by ZIP.
  async function inspectAll() {
    resetBulkAudit();
    const all = stamps(),
      rows = [],
      list = $("bulk-results");
    for (const entry of [
      ...Array.from({ length: state.target }, (_, i) => ({
        stamp: all.find((stamp) => stamp.slot === i + 1),
        name: `${String(i + 1).padStart(2, "0")}.png`,
        width: 370,
        height: 320,
      })),
      {
        stamp: all.find((s) => s.slot === state.main),
        name: "main.png",
        width: 240,
        height: 240,
      },
      {
        stamp: all.find((s) => s.slot === state.tab),
        name: "tab.png",
        width: 96,
        height: 74,
      },
    ]) {
      if ($("production-mode").value === "easy")
        notify(
          `完成PNGを一括検査中… ${rows.length + 1} / ${state.target + 2}`,
          false,
          true,
        );
      await frame();
      const { stamp, name, width, height } = entry;
      const card = document.createElement("article");
      card.className = "bulk-result";
      card.dataset.name = name;
      const heading = document.createElement("h4");
      const reasons = document.createElement("p");
      card.append(heading);
      let report;
      if (!stamp)
        report = {
          status: "エラー",
          errors: ["対応するスタンプが未加工です"],
          warnings: [],
        };
      else {
        const rendered = C.renderStamp(stamp);
        const finalScan = inspectFinal(rendered);
        const output =
          name === "main.png" || name === "tab.png"
            ? C.specialImage(stamp, width, height)
            : rendered.canvas;
        const blob = await C.pngBlob(output);
        const image = output.getContext("2d").getImageData(0, 0, width, height);
        const source = state.sources.find((source) =>
          source.stamps.includes(stamp),
        );
        const outputScan =
          output === rendered.canvas ? finalScan : R.inspectFinal(image);
        report = window.StampAudit.inspect(image, blob.size, width, height, {
          margin:
            output === rendered.canvas && stamp.style.safeMargin === 20
              ? 20
              : 10,
          residues: outputScan.candidates.length,
          decorations: outputScan.decorations.length,
          stale: source.processSignature !== signature(source),
          textClipped: rendered.textClipped,
          textOverlap: rendered.textOverlap,
          unsafe:
            rendered.textOverlap &&
            T.resolve(stamp.caption, stamp.style).autoPlace,
        });
        if (stamp.cropDiagnostic && stamp.boundaryReview?.needsReview) {
          report.warnings.push(stamp.cropDiagnostic);
        }
        if (stamp.boundaryReview?.needsReview && !stamp.reviewed) {
          report.warnings.push(
            (stamp.boundaryReview.touching?.length === 0
              ? "分割境界上の前景はありませんが、境界の近くに前景があります（"
              : "元画像の分割境界に前景または確認対象があります（") +
            stamp.boundaryReview.edges.join("・") +
            "）。隣のコマの混入・文字や触角の欠けを個別編集で確認してください。",
          );
          if (report.status !== "エラー") report.status = "要確認";
        }
        if (stamp.individualReviewRequired && !stamp.reviewed) {
          report.errors.push("分割境界または描き込み背景が未確定です。この画像を個別編集して確認済みにしてください。");
          report.status = "エラー";
        }
        if (pendingSuggestion(stamp)) {
          report.errors.push(
            "承認後の画像生成が未完了です。セリフ一覧で再承認して生成してください。",
          );
          report.status = "エラー";
        }
        const preview = C.canvas(width, height);
        preview.className = $("preview-background").value;
        preview.getContext("2d").drawImage(output, 0, 0);
        preview.setAttribute("aria-label", `${name} 完成PNG`);
        const stage = document.createElement("div");
        stage.className = "audit-preview-stage";
        stage.append(preview);
        card.append(stage);
        if (outputScan.candidates.length || outputScan.decorations.length) {
          const overlay = C.canvas(width, height);
          overlay.className = "audit-component-overlay";
          overlay.hidden = true;
          overlay.setAttribute("aria-hidden", "true");
          const ctx = overlay.getContext("2d");
          ctx.lineWidth = 2;
          for (const [list, color] of [
            [outputScan.candidates, "#ce7a17"],
            [outputScan.decorations, "#25815a"],
          ])
            for (const c of list) {
              ctx.strokeStyle = color;
              ctx.strokeRect(c.x - 2, c.y - 2, c.width + 4, c.height + 4);
            }
          stage.append(overlay);
          const toggle = document.createElement("button");
          toggle.className = "button secondary wide";
          toggle.textContent = `検出位置を表示（橙：要確認${outputScan.candidates.length}／緑：装飾・詳細候補${outputScan.decorations.length}）`;
          toggle.setAttribute("aria-pressed", "false");
          toggle.onclick = () => {
            overlay.hidden = !overlay.hidden;
            toggle.setAttribute("aria-pressed", String(!overlay.hidden));
          };
          card.append(toggle);
        }
        const metrics = document.createElement("p");
        metrics.textContent = `${width}×${height}px · PNG / RGBA · ${(blob.size / 1024).toFixed(1)}KB · 透明 ${report.transparent}px · 半透明 ${report.partial}px`;
        card.append(metrics);
        output.width = output.height = 1;
        rendered.canvas.width = rendered.canvas.height = 1;
      }
      card.dataset.status = report.status;
      heading.textContent = `${name}：${report.status}`;
      reasons.textContent =
        [...report.errors, ...report.warnings].join(" / ") ||
        "サイズ・RGBA透過・余白・容量・残留候補の検査に合格（目視確認は別途必要です）";
      card.append(reasons);
      if (stamp) {
        const edit = document.createElement("button");
        edit.className = "button secondary wide";
        edit.textContent = `${name}の元スタンプを個別編集`;
        edit.onclick = () => {
          if (!state.busy) openEditor(stamps().indexOf(stamp));
        };
        card.append(edit);
      }
      list.append(card);
      rows.push({ ...entry, report });
    }
    const complete =
      all.length === state.target &&
      Array.from({ length: state.target }, (_, i) => i + 1).every((slot) =>
        all.some((stamp) => stamp.slot === slot),
      );
    const unresolvedBoundary = all.filter(
      (stamp) => stamp.boundaryReview?.needsReview && !stamp.reviewed,
    ).length;
    const errors = rows.filter((row) => row.report.status === "エラー").length;
    const warnings = rows.filter(
      (row) => row.report.status === "要確認",
    ).length;
    // Boundary warnings need explicit visual review, but should not disable the
    // very checkbox through which the user acknowledges that review.
    bulkAudit = { rows, complete, errors, unresolvedBoundary };
    $("bulk-summary").textContent =
      `${rows.length}画像：正常 ${rows.length - errors - warnings}・要確認 ${warnings}・エラー ${errors}。` +
      (unresolvedBoundary ? ` 分割境界の確認対象が${unresolvedBoundary}個あります。一覧で各画像の端を確認し、問題があれば個別編集してください。問題がなければ目視確認チェックを入れられます。` : "") +
      (complete
        ? "一覧を目視確認してください。"
        : `未加工の番号があります（${all.length}/${state.target}個）。全数を加工してから再検査してください。`);
    syncBulkControls();
  }
  $("bulk-inspect").onclick = () => task(inspectAll);
  $("bulk-visual").onchange = () => {
    $("bulk-confirm").disabled =
      !$("bulk-visual").checked ||
      !bulkAudit ||
      !bulkAudit.complete ||
      !!bulkAudit.errors;
  };
  $("bulk-confirm").onclick = () => {
    if (
      state.busy ||
      !bulkAudit ||
      !bulkAudit.complete ||
      bulkAudit.errors ||
      !$("bulk-visual").checked
    )
      return;
    const all = stamps();
    all.forEach((stamp) => {
      stamp.reviewed = true;
    });
    invalidate();
    renderResults();
    $("bulk-summary").textContent =
      `全${all.length}個とメイン・タブの目視確認を保存しました。既存のZIP保存ボタンを利用できます。`;
    notify("すべて確認済みにしました。画像やセリフは変更していません。");
    if ($("production-mode").value === "easy") easyStep(3);
  };
  function validation(reuse = null) {
    const all = stamps(),
      rendered = all.map((stamp) => {
        if (reuse?.has(stamp)) return reuse.get(stamp);
        const result = C.renderStamp(stamp);
        result.finalResidueCount = inspectFinal(result).candidates.length;
        stamp.finalResidueCount = result.finalResidueCount;
        stamp.autoRemovedCount = result.autoRemoved?.length || 0;
        // Only keep inspection metadata; release temporary canvas memory on iPhone.
        result.canvas.width = result.canvas.height = 1;
        return result;
      });
    const unreviewed = all.filter((s) => !s.reviewed).length,
      empty = rendered.flatMap((r, i) => (r.empty ? [all[i].slot] : [])),
      overlaps = rendered.flatMap((r, i) =>
        r.textOverlap ? [all[i].slot] : [],
      ),
      unsafe = rendered.flatMap((r, i) =>
        r.textOverlap && T.resolve(all[i].caption, all[i].style).autoPlace
          ? [all[i].slot]
          : [],
      ),
      residueSlots = all.flatMap((stamp, i) =>
        rendered[i].finalResidueCount ? [stamp.slot] : [],
      ),
      clipped = rendered.flatMap((r, i) =>
        r.textClipped ? [all[i].slot] : [],
      );
    const stale = state.sources.flatMap((s, i) =>
      s.assignments.some(Boolean) &&
      s.stamps.length &&
      s.processSignature !== signature(s)
        ? [i + 1]
        : [],
    );
    return {
      all,
      rendered,
      unreviewed,
      empty,
      clipped,
      overlaps,
      residueSlots,
      autoCleanedSlots: rendered.flatMap((r, i) =>
        r.autoRemoved?.length ? [all[i].slot] : [],
      ),
      unsafe,
      stale,
      complete:
        all.length === state.target &&
        Array.from({ length: state.target }, (_, i) => i + 1).every((slot) =>
          all.some((stamp) => stamp.slot === slot),
        ),
      missing: Array.from({ length: state.target }, (_, i) => i + 1).filter(
        (slot) => !all.some((stamp) => stamp.slot === slot),
      ),
    };
  }
  function updateValidation(reuse = null) {
    const v = validation(reuse),
      list = $("validation-list");
    lastValidation = v;
    list.replaceChildren();
    function item(message, type = "") {
      const li = document.createElement("li");
      li.className = type;
      li.textContent = message;
      list.append(li);
    }
    item(
      v.complete
        ? `選択した${state.target}個のスタンプとメイン・タブの計${state.target + 2}画像`
        : `${v.all.length}個でテスト中。${state.target}個の申請用には未加工の番号 ${v.missing.join(", ")} を揃えてください。`,
      v.complete ? "" : "warning",
    );
    item("スタンプ 370 × 320px・PNG・偶数寸法");
    item("メイン 240 × 240px / タブ 96 × 74px");
    item("外周10pxの透明な余白を確保");
    item(
      v.unreviewed
        ? `透過の目視確認：あと${v.unreviewed}個`
        : "全スタンプの透過を目視確認済み",
      v.unreviewed ? "warning" : "",
    );
    if (v.stale.length)
      item(
        `設定変更を反映するため、元画像${v.stale.join(", ")}を分割し直してください。`,
        "error",
      );
    if (v.empty.length)
      item(`空の画像があります：${v.empty.join(", ")}番`, "error");
    if (v.clipped.length)
      item(
        `文字が枠からはみ出します：${v.clipped.join(", ")}番（文字を小さくする・位置を調整）`,
        "error",
      );
    if (v.overlaps.length)
      item(
        `文字とキャラクターの重なり：${v.overlaps.join(", ")}番。自動配置または位置を調整してください。`,
        v.unsafe.length ? "error" : "warning",
      );
    if (v.autoCleanedSlots.length)
      item(
        `上端残留線を自動除去：${v.autoCleanedSlots.join(", ")}番。前後比較・OFFで確認できます。`,
      );
    if (v.residueSlots.length)
      item(
        `完成PNGの未解決の孤立した線・点の候補：${v.residueSlots.join(", ")}番。装飾の可能性もあるため、編集画面で拡大確認してください（自動削除しません）。`,
        "warning",
      );
    item("1画像1MB以下・ZIP 20MB以下を保存時に検査", "pending");
    $("download-button").textContent = v.complete
      ? "申請用ZIPを作成して保存 ↓"
      : `${v.all.length}個のテストZIPを保存 ↓`;
    $("download-note").textContent = v.complete
      ? "iPhoneでは保存後「ファイル」アプリから確認できます。"
      : `テスト用ZIPです。申請用には01〜${String(state.target).padStart(2, "0")}番をすべて加工してください。番号は欠番を詰めずに保存します。`;
    return v;
  }
  function renderCaptionList() {
    $("caption-list").replaceChildren();
    for (let i = 0; i < state.target; i++) {
      const label = document.createElement("label"),
        input = document.createElement("input");
      label.textContent = `${String(i + 1).padStart(2, "0")}.png`;
      input.type = "text";
      input.maxLength = 120;
      input.value = state.slots[i].caption;
      input.dataset.slot = i + 1;
      input.oninput = () => {
        state.slots[i].caption = input.value;
        stamps()
          .filter((stamp) => stamp.slot === i + 1)
          .forEach((stamp) => {
            stamp.caption = input.value;
            stamp.reviewed = false;
          });
        invalidate();
        $("bulk-captions").value = state.slots
          .map((slot) => slot.caption)
          .join("\n")
          .replace(/\n+$/, "");
      };
      input.onchange = () => {
        renderResults();
        if (state.sources.length) renderSourceEditor();
      };
      label.append(input);
      $("caption-list").append(label);
    }
  }
  function applyCaptions() {
    const lines = $("bulk-captions").value.replace(/\r/g, "").split("\n");
    if (
      lines.length > 40 ||
      lines.some((line) => Array.from(line).length > 120)
    ) {
      notify("40行以内、各行120文字以内で入力してください。", true);
      return;
    }
    state.slots.forEach((slot, i) => {
      slot.caption = lines[i] || "";
    });
    stamps().forEach((stamp) => {
      stamp.caption = state.slots[stamp.slot - 1].caption;
      stamp.reviewed = false;
    });
    invalidate();
    renderResults();
    if (state.sources.length) renderSourceEditor();
    notify("番号にセリフを登録しました。画像を作成する前でも保存できます。");
  }
  $("apply-captions").onclick = () => {
    if (!state.busy) applyCaptions();
  };
  function selected() {
    return stamps()[state.selectedStamp];
  }
  function openEditor(index) {
    state.selectedStamp = index;
    residueScan = null;
    const stamp = selected();
    state.brush = "none";
    $("edit-canvas").style.cursor = "default";
    syncLayoutControls();
    insetControls("stamp-insets", stamp.crop, 40, changedImage);
    C.renderBefore(stamp, $("before-canvas"));
    $("dialog-title").textContent =
      `スタンプ ${String(stamp.slot).padStart(2, "0")} を編集`;
    $("caption-text").value = stamp.caption;
    syncCaptionControls();
    $("reviewed-checkbox").checked = stamp.reviewed;
    document
      .querySelectorAll("[data-brush]")
      .forEach((b) =>
        b.classList.toggle("selected", b.dataset.brush === "none"),
      );
    drawEditor();
    if (!$("stamp-dialog").open) {
      $("stamp-dialog").showModal();
      document.body.classList.add("modal-open");
    }
  }
  function drawEditor() {
    if (matteProposal) clearMatteProposal();
    if (selected()) {
      const rendered = C.renderStamp(selected(), $("edit-canvas"));
      $("auto-cleanup-enabled").checked = selected().cleanupEnabled !== false;
      $("auto-cleanup-status").textContent = rendered.autoRemoved?.length
        ? `上端の残留線を${rendered.autoRemoved.length}本自動除去しました。元画像データ・配置設定は保持し、完成描画の該当成分だけを除去しています。OFFで元に戻せます。`
        : "自動除去対象の上端線はありません。不確かな成分は確認候補に残します。";
      if ($("auto-cleanup-comparison").open) {
        C.renderUncleaned(selected(), $("auto-cleanup-before"));
        copyCanvas(rendered.canvas, $("auto-cleanup-after"));
      }
      const plan = rendered.textPlan;
      $("text-placement-status").textContent = !plan
        ? "セリフを入れるとデザインと配置をプレビューします。"
        : rendered.textClipped
          ? "文字が枠に収まりません。セリフを短くするか、文字を小さくしてください。"
          : rendered.textOverlap
            ? "キャラクターと文字が重なっています。自動配置をONにするか、位置を調整してください。"
            : `${plan.style.autoPlace ? "重ならない場所に配置しました。" : "手動配置：重なりなし。"}${plan.autoScaled ? "キャラクターを縮小して余白を確保しました。" : ""}${plan.fontReduced ? `文字を${rendered.effectiveFontSize}pxに調整しました。` : ""}`;
      if ($("comparison-panel").open)
        C.renderStamp(selected(), $("after-canvas"));
      if ($("residue-panel").open) updateResidueInspector(rendered);
      $("undo-brush").disabled = !selected().undo.length;
      $("redo-brush").disabled = !selected().redo.length;
    }
  }
  $("auto-cleanup-enabled").onchange = () => {
    selected().cleanupEnabled = $("auto-cleanup-enabled").checked;
    residueScan = null;
    changedImage();
  };
  $("auto-cleanup-comparison").ontoggle = () => {
    $("auto-cleanup-comparison")
      .closest(".dialog-content")
      .classList.toggle(
        "auto-cleanup-inspecting",
        $("auto-cleanup-comparison").open,
      );
    drawEditor();
  };
  function clearMatteProposal() {
    matteProposal = null;
    $("matte-pending").hidden = true;
  }
  $("preview-matte").onclick = () => {
    const stamp = selected(),
      source = state.sources.find((s) => s.stamps.includes(stamp));
    const proposal = C.proposeMatteCleanup(
      stamp.original,
      stamp.mask,
      source.mode,
      source.tolerance,
      source.color,
    );
    if (!proposal.changed) {
      clearMatteProposal();
      notify(
        "安全に提案できる不透明な縁がありません。元から半透明の部分は保護します。",
        true,
      );
      return;
    }
    matteProposal = { stamp, mask: proposal.mask, before: stamp.mask.slice() };
    C.renderStamp(stamp, $("matte-before"));
    C.renderStamp({ ...stamp, mask: proposal.mask }, $("matte-after"));
    $("matte-status").textContent =
      `${proposal.changed}画素の不透明度を軽減する案です。まだPNG・ZIPには反映していません。`;
    $("matte-pending").hidden = false;
  };
  $("cancel-matte").onclick = clearMatteProposal;
  $("apply-matte").onclick = () => {
    if (
      !matteProposal ||
      selected() !== matteProposal.stamp ||
      selected().mask.some((a, i) => a !== matteProposal.before[i])
    ) {
      clearMatteProposal();
      notify("編集内容が変わりました。案を作り直してください。", true);
      return;
    }
    snapshot(selected());
    selected().mask = matteProposal.mask;
    clearMatteProposal();
    residueScan = null;
    changedImage();
    notify("比較した案を適用しました。「1つ戻す」で戻せます。");
  };
  function nextResidue() {
    const all = stamps(),
      indexes = all.flatMap((s, i) => {
        if (
          s.cleanupEnabled !== false &&
          s.finalResidueCount === 0 &&
          s.autoRemovedCount > 0
        )
          return [];
        if (residueSummary(s)) return [i];
        if (!s.finalResidueCount) return [];
        const rendered = C.renderStamp(s);
        s.finalResidueCount = inspectFinal(rendered).candidates.length;
        rendered.canvas.width = rendered.canvas.height = 1;
        return s.finalResidueCount ? [i] : [];
      });
    if (!indexes.length) {
      notify(
        "削除可能な残留候補はありません。保護候補や完成一覧も目視で確認してください。",
      );
      return;
    }
    const current = $("stamp-dialog").open ? state.selectedStamp : -1;
    openEditor(indexes.find((i) => i > current) ?? indexes[0]);
    $("residue-panel").open = true;
    drawEditor();
  }
  $("review-residues").onclick = nextResidue;
  $("next-residue").onclick = nextResidue;
  function inspectFinal(rendered) {
    const ctx = rendered.canvas.getContext("2d"),
      image = ctx.getImageData(0, 0, 370, 320);
    let coverage = null;
    if (rendered.textPlan) {
      const text = C.canvas(370, 320),
        context = text.getContext("2d");
      T.paintPlan(context, rendered.textPlan);
      const rgba = context.getImageData(0, 0, 370, 320).data;
      coverage = Uint8ClampedArray.from(
        { length: 370 * 320 },
        (_, i) => rgba[i * 4 + 3],
      );
      text.width = text.height = 1;
    }
    return R.inspectFinal(image, coverage);
  }
  function residueSummary(stamp) {
    const key = JSON.stringify(C.stampCrop(stamp)),
      revision = stamp.residueRevision || 0,
      cache = stamp.residueSummary;
    if (
      cache &&
      cache.mask === stamp.mask &&
      cache.key === key &&
      cache.revision === revision
    )
      return cache.count;
    const scan = R.analyse(stamp.original, stamp.mask, C.stampCrop(stamp));
    stamp.residueSummary = {
      mask: stamp.mask,
      key,
      revision,
      count: scan.candidates.filter((c) => !c.protected).length,
    };
    return scan.candidates.filter((c) => !c.protected).length;
  }
  function updateResidueInspector(rendered) {
    const stamp = selected();
    if (!stamp) return;
    const preview = $("residue-preview");
    preview.getContext("2d").clearRect(0, 0, 370, 320);
    preview.getContext("2d").drawImage(rendered.canvas, 0, 0);
    residuePlacement = rendered.imagePlacement || C.imagePlacement(stamp);
    const key = JSON.stringify([
        C.stampCrop(stamp),
        rendered.autoRemoved || [],
        residuePlacement,
      ]),
      revision = stamp.residueRevision || 0;
    if (
      !drawing &&
      (!residueScan ||
        residueScan.stamp !== stamp ||
        residueScan.mask !== stamp.mask ||
        residueScan.key !== key ||
        residueScan.revision !== revision)
    ) {
      const scan = R.analyse(
        stamp.original,
        stamp.mask,
        C.stampCrop(stamp),
        true,
      );
      residueScan = { stamp, mask: stamp.mask, key, revision, scan };
      $("residue-candidates").replaceChildren();
      scan.candidates.slice(0, 50).forEach((component, index) => {
        const row = document.createElement("div"),
          label = document.createElement("label"),
          checkbox = document.createElement("input"),
          button = document.createElement("button");
        const p = residuePlacement;
        component.automatic = (rendered.autoRemoved || []).some(
          (line) =>
            Math.abs(
              p.offsetY +
                (component.y + component.height / 2) * p.ratio -
                (line.y + 0.5),
            ) < 2 &&
            Math.abs(
              p.offsetX +
                (component.x + component.width / 2) * p.ratio -
                (line.x + line.width / 2),
            ) < 2,
        );
        checkbox.type = "checkbox";
        checkbox.disabled = !!component.protected || component.automatic;
        checkbox.value = component.id;
        checkbox.dataset.residueId = component.id;
        checkbox.onchange = drawResidueOverlay;
        label.className = "check-label";
        label.append(
          checkbox,
          `候補${index + 1} · ${component.width}×${component.height}px${component.whiteFraction > 0.8 ? "・白系" : ""} · 左${component.x}／上${component.y}px · 不透明度${component.alphaMin}〜${component.alphaMax}/255${component.nearBoundary ? "・切り抜き境界付近（線・番号か要確認）" : ""}${component.protected ? "・装飾候補として保護" : ""}${component.automatic ? "・完成画像では自動除去済み" : ""}`,
        );
        button.className = "button secondary";
        button.textContent = "拡大";
        button.setAttribute("aria-label", `候補${index + 1}を拡大`);
        button.onclick = () => focusResidue(component);
        row.append(label, button);
        $("residue-candidates").append(row);
      });
      $("residue-status").textContent = scan.candidates.length
        ? `${scan.candidates.filter((c) => !c.protected && !c.automatic).length}件の要確認候補（不要物とは未確定）、${scan.candidates.filter((c) => c.protected).length}件の装飾候補を保護。自動除去済みの線は完成PNGには残りません。元の切り抜き画像に残っている前景です。輪郭から離れたものも確認し、不要なものだけ選択してください。${scan.candidates.length > 50 ? "先頭50件を表示。処理後に再検出できます。" : ""}`
        : "孤立した線・点の候補は見つかりませんでした。検出で全ての不要部分を判断できるわけではありません。完成画像も目視で確認してください。";
    }
    if (!drawing) {
      const final = inspectFinal(rendered);
      $("residue-output-status").textContent = final.candidates.length
        ? `完成PNGの候補 ${final.candidates.length}件（文字・白フチ・影の成分は保護）。${final.candidates
            .slice(0, 6)
            .map((c) => `左${c.x}・上${c.y}px／${c.width}×${c.height}px`)
            .join(
              "、",
            )}。下の元画像候補を選択して確認してください。一致する候補がない部分は消しゴムで修正できます。`
        : "完成PNGの孤立候補は0件です（文字・白フチ・影の成分は保護）。検出は完全ではないため、拡大表示でも確認してください。";
    }
    resizeResidueView();
    drawResidueOverlay();
  }
  function resizeResidueView() {
    const scale =
      Math.min(1, ($("residue-viewport").clientWidth || 370) / 370) *
      Number($("residue-zoom").value);
    $("residue-stage").style.width = `${370 * scale}px`;
    $("residue-stage").style.height = `${320 * scale}px`;
  }
  function drawResidueOverlay() {
    const canvas = $("residue-overlay"),
      ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 370, 320);
    if (!residueScan || !residuePlacement) return;
    const selectedIds = new Set(
      [...$("residue-candidates").querySelectorAll("input:checked")].map(
        (input) => Number(input.value),
      ),
    );
    residueScan.scan.candidates.slice(0, 50).forEach((component, index) => {
      const p = residuePlacement,
        x = p.offsetX + component.x * p.ratio,
        y = p.offsetY + component.y * p.ratio;
      ctx.strokeStyle = component.protected
        ? "#588c72"
        : selectedIds.has(component.id)
          ? "#f25454"
          : "#e7a32f";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        x - 2,
        y - 2,
        component.width * p.ratio + 4,
        component.height * p.ratio + 4,
      );
      ctx.font = "10px sans-serif";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(String(index + 1), Math.max(1, x), Math.max(10, y - 4));
    });
  }
  function focusResidue(component) {
    $("residue-zoom").value = "4";
    resizeResidueView();
    const p = residuePlacement,
      scale = $("residue-stage").getBoundingClientRect().width / 370,
      viewport = $("residue-viewport");
    viewport.scrollLeft =
      (p.offsetX + (component.x + component.width / 2) * p.ratio) * scale -
      viewport.clientWidth / 2;
    viewport.scrollTop =
      (p.offsetY + (component.y + component.height / 2) * p.ratio) * scale -
      viewport.clientHeight / 2;
  }
  $("residue-panel").ontoggle = () => {
    $("residue-panel")
      .closest(".dialog-content")
      .classList.toggle("residue-inspecting", $("residue-panel").open);
    if ($("residue-panel").open) drawEditor();
  };
  $("residue-zoom").onchange = resizeResidueView;
  $("residue-background").onchange = () => {
    $("residue-viewport").dataset.background = $("residue-background").value;
  };
  $("scan-residue").onclick = () => {
    residueScan = null;
    drawEditor();
  };
  $("remove-residue").onclick = () => {
    const ids = [
      ...$("residue-candidates").querySelectorAll("input:checked"),
    ].map((input) => Number(input.value));
    if (!ids.length) {
      notify("不要だと確認した候補だけにチェックを入れてください。", true);
      return;
    }
    if (
      !confirm(
        "選択した候補だけを消します。手足・葉っぱ・白い部分・装飾ではないことを確認しましたか？",
      )
    )
      return;
    try {
      const result = R.removeSelected(selected().mask, residueScan.scan, ids);
      snapshot(selected());
      selected().mask = result.mask;
      residueScan = null;
      changedImage();
      notify(
        `${result.removed}個の元画像ピクセルを削除しました。「1つ戻す」で取り消せます。`,
      );
    } catch (error) {
      notify(error.message, true);
      residueScan = null;
      drawEditor();
    }
  };
  function syncLayoutControls() {
    const stamp = selected();
    for (const [id, key] of [
      ["image-scale", "scale"],
      ["image-x", "x"],
      ["image-y", "y"],
    ]) {
      $(id).value = stamp.layout[key];
      $(`${id}-value`).textContent = stamp.layout[key];
    }
  }
  function changedImage() {
    selected().reviewed = false;
    $("reviewed-checkbox").checked = false;
    invalidate();
    drawEditor();
  }
  for (const [id, key] of [
    ["image-scale", "scale"],
    ["image-x", "x"],
    ["image-y", "y"],
  ]) {
    $(id).oninput = () => {
      selected().layout[key] = Number($(id).value);
      syncLayoutControls();
      changedImage();
    };
  }
  for (const [id, delta] of [
    ["image-smaller", -5],
    ["image-larger", 5],
  ]) {
    $(id).onclick = () => {
      selected().layout.scale = Math.max(
        20,
        Math.min(100, selected().layout.scale + delta),
      );
      syncLayoutControls();
      changedImage();
    };
  }
  $("reset-layout").onclick = () => {
    selected().layout = { scale: 100, x: 50, y: 50 };
    syncLayoutControls();
    changedImage();
  };
  $("reset-stamp-crop").onclick = () => {
    selected().crop = { top: 0, bottom: 0, left: 0, right: 0 };
    insetControls("stamp-insets", selected().crop, 40, changedImage);
    changedImage();
  };
  $("comparison-panel").ontoggle = drawEditor;
  function closeEditor() {
    $("stamp-dialog").close();
  }
  $("close-dialog").onclick = closeEditor;
  $("stamp-dialog").addEventListener("close", () => {
    endPaint();
    document.body.classList.remove("modal-open");
    renderResults();
    $("bulk-captions").value = state.slots
      .map((slot) => slot.caption)
      .join("\n")
      .replace(/\n+$/, "");
  });
  $("edit-background").onchange = () => {
    $("edit-preview").className = `edit-preview ${$("edit-background").value}`;
    $("comparison-panel").dataset.background = $("edit-background").value;
  };
  function syncCaptionControls() {
    if ($("safe-layout"))
      $("safe-layout").checked = selected().style.safeMargin === 20;
    const stamp = selected(),
      style = T.resolve(stamp.caption, stamp.style);
    $("font-family").value = style.font;
    $("text-color").value = style.color;
    $("text-outline").checked = style.outline;
    $("text-preset").value = stamp.style.preset || "manual";
    $("text-auto-place").checked = style.autoPlace;
    $("preset-suggestion").textContent =
      `おすすめ：${T.PRESETS[T.suggest(stamp.caption)].label}（セリフの言葉から端末内で提案）`;
    for (const [id, key] of [
      ["font-size", "size"],
      ["text-x", "x"],
      ["text-y", "y"],
      ["text-outline-width", "outlineWidth"],
      ["text-shadow", "shadow"],
      ["text-angle", "angle"],
    ]) {
      $(id).value = style[key];
      $(`${id}-value`).textContent = style[key];
    }
  }
  if ($("safe-layout"))
    $("safe-layout").onchange = () => {
      const stamp = selected();
      stamp.style = {
        ...stamp.style,
        safeMargin: $("safe-layout").checked ? 20 : 10,
        autoPlace: $("safe-layout").checked ? true : stamp.style.autoPlace,
      };
      syncCaptionControls();
      changedImage();
    };
  for (const [id, key] of [
    ["font-family", "font"],
    ["font-size", "size"],
    ["text-x", "x"],
    ["text-y", "y"],
    ["text-color", "color"],
    ["text-outline", "outline"],
    ["text-outline-width", "outlineWidth"],
    ["text-shadow", "shadow"],
    ["text-angle", "angle"],
  ]) {
    $(id).addEventListener("input", () => {
      const stamp = selected();
      const value =
        key === "outline"
          ? $(id).checked
          : ["font", "color"].includes(key)
            ? $(id).value
            : Number($(id).value);
      stamp.style = {
        ...stamp.style,
        [key]: value,
        overrides: [
          ...new Set([
            ...(stamp.style.overrides || []),
            ...(T.OVERRIDES.includes(key) ? [key] : []),
          ]),
        ],
      };
      syncCaptionControls();
      changedImage();
    });
  }
  $("caption-text").oninput = () => {
    selected().caption = $("caption-text").value;
    syncCaptionControls();
    changedImage();
  };
  $("text-preset").onchange = () => {
    const stamp = selected(),
      key = $("text-preset").value;
    stamp.style =
      key === "manual"
        ? {
            ...T.resolve(stamp.caption, stamp.style),
            preset: "manual",
            overrides: [],
            autoPlace: false,
          }
        : {
            ...T.presetStyle(key, stamp.caption),
            ...(stamp.style.safeMargin === 20 ? { safeMargin: 20 } : {}),
          };
    syncCaptionControls();
    changedImage();
  };
  $("text-auto-place").onchange = () => {
    selected().style.autoPlace = $("text-auto-place").checked;
    syncCaptionControls();
    changedImage();
  };
  $("auto-place-text").onclick = () => {
    selected().style = { ...selected().style, autoPlace: true };
    syncCaptionControls();
    changedImage();
  };
  $("apply-design-all").onclick = () => {
    if (
      !confirm(
        "全40番号の文字デザインと配置を変更します。個別の文字調整は上書きします。よろしいですか？",
      )
    )
      return;
    const key = $("batch-design").value;
    state.slots.forEach((slot) => {
      slot.style = {
        ...T.presetStyle(key, slot.caption),
        ...(slot.style.safeMargin === 20 ? { safeMargin: 20 } : {}),
      };
    });
    stamps().forEach((stamp) => {
      stamp.style = { ...state.slots[stamp.slot - 1].style };
      stamp.reviewed = false;
    });
    invalidate();
    renderResults();
    notify(
      "全番号にデザインと自動配置を適用しました。仕上がりを一覧で確認してください。",
    );
  };
  $("reviewed-checkbox").onchange = () => {
    selected().reviewed = $("reviewed-checkbox").checked;
    invalidate();
  };
  $("apply-style-all").onclick = () => {
    if (
      !confirm(
        "全40番号にこの文字の見た目・位置を適用します。個別設定を上書きしてよろしいですか？",
      )
    )
      return;
    const style = { ...selected().style };
    state.slots.forEach((slot) => {
      slot.style = { ...style, overrides: style.overrides?.slice() || [] };
    });
    stamps().forEach((stamp) => {
      stamp.style = { ...style, overrides: style.overrides?.slice() || [] };
      stamp.reviewed = false;
    });
    $("reviewed-checkbox").checked = false;
    invalidate();
    drawEditor();
    notify(
      T.resolve(selected().caption, style).autoPlace
        ? "全40番号に文字デザインを適用しました。セリフごとの配置は自動で調整します。"
        : "全40番号に手動の文字設定を適用しました。位置と重なりを確認してください。",
    );
  };
  $("save-edit").onclick = () => {
    if (!$("reviewed-checkbox").checked) {
      notify(
        "白い部分と透過の仕上がりを確認して、チェックを入れてください。",
        true,
      );
      $("reviewed-checkbox").focus();
      return;
    }
    selected().reviewed = true;
    invalidate();
    const next = stamps().findIndex(
      (stamp, i) => i > state.selectedStamp && !stamp.reviewed,
    );
    if (next >= 0) openEditor(next);
    else {
      closeEditor();
      notify("確認を保存しました。申請前チェックからZIPを作成できます。");
    }
  };
  for (const button of document.querySelectorAll("[data-brush]"))
    button.onclick = () => {
      state.brush = button.dataset.brush;
      document
        .querySelectorAll("[data-brush]")
        .forEach((b) => b.classList.toggle("selected", b === button));
      $("edit-canvas").style.cursor =
        state.brush === "none"
          ? "default"
          : state.brush === "text"
            ? "grab"
            : "crosshair";
    };
  $("brush-size").oninput = () => {
    $("brush-value").textContent = $("brush-size").value;
  };
  function snapshot(stamp) {
    stamp.redo = [];
    stamp.undo.push(stamp.mask.slice());
    if (stamp.undo.length > 8) stamp.undo.shift();
  }
  function brushPoint(e) {
    const r = $("edit-canvas").getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * 370) / r.width,
      y: ((e.clientY - r.top) * 320) / r.height,
    };
  }
  function paint(x, y) {
    selected().residueRevision = (selected().residueRevision || 0) + 1;
    C.applyBrush(
      selected(),
      x,
      y,
      Number($("brush-size").value) / 2,
      state.brush,
    );
  }
  $("edit-canvas").onpointerdown = (e) => {
    if (drawing || !e.isPrimary) return;
    const point = brushPoint(e),
      plan = selected().renderTextPlan;
    const hitsText =
      plan &&
      point.x >= plan.x &&
      point.x <= plan.x + plan.width &&
      point.y >= plan.y &&
      point.y <= plan.y + plan.height;
    if (state.brush === "text" || (state.brush === "none" && hitsText)) {
      if (!plan) return;
      e.preventDefault();
      drawing = true;
      textDrag = {
        start: point,
        x: (plan.centerX / 370) * 100,
        y: (plan.centerY / 320) * 100,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      selected().reviewed = false;
      $("reviewed-checkbox").checked = false;
      invalidate();
      return;
    }
    if (state.brush === "none") return;
    e.preventDefault();
    drawing = true;
    snapshot(selected());
    // Freeze the mapping for the whole stroke. Removing an edge must not move the brush target.
    selected().activePlacement = C.imagePlacement(selected());
    lastPoint = brushPoint(e);
    paint(lastPoint.x, lastPoint.y);
    e.currentTarget.setPointerCapture(e.pointerId);
    selected().reviewed = false;
    $("reviewed-checkbox").checked = false;
    invalidate();
    drawEditor();
  };
  $("edit-canvas").onpointermove = (e) => {
    if (!drawing) return;
    e.preventDefault();
    if (textDrag) {
      const point = brushPoint(e),
        stamp = selected();
      stamp.style.x = Math.max(
        10,
        Math.min(90, textDrag.x + ((point.x - textDrag.start.x) / 370) * 100),
      );
      stamp.style.y = Math.max(
        10,
        Math.min(90, textDrag.y + ((point.y - textDrag.start.y) / 320) * 100),
      );
      syncCaptionControls();
      invalidate();
      drawEditor();
      return;
    }
    const p = brushPoint(e),
      dx = p.x - lastPoint.x,
      dy = p.y - lastPoint.y,
      count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
    for (let i = 1; i <= count; i++)
      paint(lastPoint.x + (dx * i) / count, lastPoint.y + (dy * i) / count);
    lastPoint = p;
    drawEditor();
  };
  function endPaint() {
    const wasDrawing = drawing;
    drawing = false;
    textDrag = null;
    lastPoint = null;
    if (selected()) delete selected().activePlacement;
    if (wasDrawing) drawEditor();
  }
  $("edit-canvas").onpointerup = endPaint;
  $("edit-canvas").onpointercancel = endPaint;
  $("undo-brush").onclick = () => {
    const stamp = selected();
    if (stamp.undo.length) {
      stamp.redo.push(stamp.mask.slice());
      stamp.mask = stamp.undo.pop();
      stamp.reviewed = false;
      $("reviewed-checkbox").checked = false;
      invalidate();
      drawEditor();
    }
  };
  $("redo-brush").onclick = () => {
    const stamp = selected();
    if (stamp.redo.length) {
      stamp.undo.push(stamp.mask.slice());
      stamp.mask = stamp.redo.pop();
      changedImage();
    }
  };
  $("reset-mask").onclick = () => {
    const stamp = selected();
    snapshot(stamp);
    stamp.mask = stamp.autoMask.slice();
    stamp.reviewed = false;
    $("reviewed-checkbox").checked = false;
    invalidate();
    drawEditor();
  };
  function triggerDownload(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  }
  // Inspect the encoded PNG, not only the preview canvas. Decode one file at a
  // time and release its URL/canvas so 42 files do not accumulate mobile memory.
  async function checkedPng(canvas, name, width, height) {
    const blob = await C.pngBlob(canvas);
    if (!blob.size || blob.size > 1024 * 1024)
      throw new Error(`${name}：PNG容量が不正、または1MBを超えています。`);
    const url = URL.createObjectURL(blob), image = new Image();
    let decoded;
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error(`${name}：生成したPNGを読み込めません。メモリを確認して再作成してください。`));
        image.src = url;
      });
      decoded = C.canvas(image.naturalWidth, image.naturalHeight);
      const ctx = decoded.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const report = window.StampAudit.inspect(
        ctx.getImageData(0, 0, decoded.width, decoded.height),
        blob.size, width, height,
      );
      if (report.errors.length) throw new Error(`${name}：${report.errors.join(" / ")}`);
      return blob;
    } finally {
      URL.revokeObjectURL(url);
      if (decoded) decoded.width = decoded.height = 1;
    }
  }
  function zipShareFailure(error) {
    const reason = ({
      NotAllowedError: "共有がブラウザの権限または操作条件により拒否されました",
      TypeError: "このブラウザではZIPファイルの共有に対応していません",
      DataError: "共有先へZIPを渡せませんでした",
      InvalidStateError: "別の共有処理が実行中、または画面が操作できない状態です",
    })[error?.name] || "ブラウザまたは共有先でエラーが発生しました";
    notify(`共有できませんでした。原因：${reason}。ZIPは保持しています。「共有せずZIPをダウンロードする」を押し、Safariのダウンロード一覧・「ファイル」を確認してください。アプリ内ブラウザの場合はSafariで開いて再作成してください。`, true, true);
  }
  // A real user gesture is required for reliable iOS in-app browser downloads.
  // Keep the generated Blob URL alive so the user can explicitly open/share it.
  function prepareZipSaveLink(url, name) {
    const link = $("download-link");
    const direct = $("download-direct");
    direct.href = url;
    direct.download = name;
    direct.hidden = false;
    link.href = url;
    link.download = name;
    link.hidden = false;
    link.removeAttribute("target");
    link.setAttribute("aria-label", "作成したZIPを開いて保存する");
    link.onclick = (event) => {
      if (!state.zipURL) {
        event.preventDefault();
        notify("ZIPがありません。もう一度ZIPを作成してください。", true);
        return;
      }
      // Web Share with a File is an iOS-native route to "Save to Files".
      // It must be called directly from the tap handler to retain user activation.
      // Unsupported browsers keep the ordinary download link as a fallback.
      let canShare = false;
      try {
        canShare = /iPad|iPhone|iPod/.test(navigator.userAgent) &&
          state.zipFile && typeof navigator.share === "function" &&
          typeof navigator.canShare === "function" &&
          navigator.canShare({ files: [state.zipFile] });
      } catch (_) { /* Fall through to the ordinary download link. */ }
      if (canShare) {
        event.preventDefault();
        try {
          Promise.resolve(navigator.share({ files: [state.zipFile] })).catch((error) => {
            if (error?.name !== "AbortError")
              zipShareFailure(error);
            else
              notify("共有をキャンセルしました。ZIPは保持しています。保存リンクから再試行できます。", false, true);
          });
        } catch (error) {
          zipShareFailure(error);
        }
      }
    };
  }
  $("download-single").onclick = () =>
    task(async () => {
      const stamp = selected();
      if (pendingSuggestion(stamp))
        throw new Error(
          "承認後の画像生成が未完了です。セリフ一覧で再承認してください。",
        );
      const result = C.renderStamp(stamp);
      if (
        result.empty ||
        result.textClipped ||
        (result.textOverlap && T.resolve(stamp.caption, stamp.style).autoPlace)
      )
        throw new Error(
          "空画像・文字のはみ出し・自動配置の重なりがあります。調整してください。",
        );
      const blob = await C.pngBlob(result.canvas),
        url = URL.createObjectURL(blob);
      triggerDownload(url, `${String(stamp.slot).padStart(2, "0")}.png`);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  $("download-button").onclick = () =>
    task(async () => {
      if (stamps().some(pendingSuggestion))
        throw new Error(
          "承認後の画像生成が未完了です。セリフ一覧で再承認して生成してください。",
        );
      const v = updateValidation();
      if (v.stale.length)
        throw new Error(
          `元画像${v.stale.join(", ")}の分割・透過設定が変更されています。分割し直してから保存してください。`,
        );
      if (v.empty.length || v.clipped.length || v.unsafe.length)
        throw new Error(
          "空画像・文字のはみ出し・自動配置の重なりがあります。申請前チェックの番号を修正してください。",
        );
      if (v.complete && v.unreviewed)
        throw new Error(
          `申請用ZIPを作る前に、あと${v.unreviewed}個の透過を個別または一覧で目視確認してください。`,
        );
      if (
        !v.all.some((stamp) => stamp.slot === state.main) ||
        !v.all.some((stamp) => stamp.slot === state.tab)
      )
        throw new Error(
          "メイン画像・タブ画像に、加工済みのスタンプ番号を選んでください。",
        );
      clearZip();
      nextStep(3);
      const files = [];
      for (let i = 0; i < v.all.length; i++) {
        notify(`PNGを作成中… ${i + 1} / ${v.all.length + 2}`, false, true);
        await frame();
        const rendered = C.renderStamp(v.all[i]);
        const name = `${String(v.all[i].slot).padStart(2, "0")}.png`;
        let blob;
        try {
          blob = await checkedPng(rendered.canvas, name, 370, 320);
        } finally {
          rendered.canvas.width = rendered.canvas.height = 1;
        }
        files.push({
          name,
          blob,
        });
      }
      for (const [name, canvas, width, height] of [
        ["main.png", $("main-preview"), 240, 240],
        ["tab.png", $("tab-preview"), 96, 74],
      ]) {
        const blob = await checkedPng(canvas, name, width, height);
        files.push({ name, blob });
      }
      notify("ZIPにまとめています…", false, true);
      await frame();
      const zip = await C.makeZip(files);
      if (zip.size > 20 * 1024 * 1024)
        throw new Error("ZIPがこのツールの安全上限20MBを超えています。");
      if (state.zipURL) URL.revokeObjectURL(state.zipURL);
      state.zipURL = URL.createObjectURL(zip);
      const name = v.complete
        ? `line-stamps-${state.target}.zip`
        : `line-stamps-test-${v.all.length}.zip`;
      state.zipFile = typeof File === "function"
        ? new File([zip], name, { type: "application/zip" }) : null;
      prepareZipSaveLink(state.zipURL, name);
      const li = document.createElement("li");
      li.textContent = `実ファイル検査OK：${files.length}画像・${(zip.size / 1024 / 1024).toFixed(2)}MB`;
      $("validation-list").append(li);
      state.dirty = false;
      if (!/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        triggerDownload(state.zipURL, name);
      }
      notify(
        `${files.length}画像のZIPを作成しました。iPhoneでは「作成したZIPを保存する」をタップしてください。共有シートが出た場合は「ファイルに保存」を選んでください。出ない場合はSafariのダウンロード一覧を確認してください。画面が切り替わらない場合も元の編集画面は閉じないでください。`,
      );
    });
  $("target-count").onchange = () => {
    const count = Number($("target-count").value);
    if (
      count < state.target &&
      state.sources.some((source) =>
        source.assignments.some((slot) => slot > count),
      ) &&
      !confirm(
        `${count}個に変更し、範囲外のコマを除外します。番号ごとのセリフと加工設定は40番まで残します。よろしいですか？`,
      )
    ) {
      $("target-count").value = state.target;
      return;
    }
    captureSlots(true);
    state.target = count;
    for (const source of state.sources)
      source.assignments = source.assignments.map((slot) =>
        slot <= count ? slot : 0,
      );
    if (state.main > count) state.main = 1;
    if (state.tab > count) state.tab = 1;
    invalidate();
    renderSources();
    renderSourceEditor();
    renderResults();
  };
  $("save-project").onclick = () => {
    if (state.busy) return;
    captureSlots(true);
    const data = {
      format: "stamp-atelier-project",
      version: 1,
      imageDataIncluded: false,
      notice:
        "元画像・色付きの画像は含みません。元画像を再選択して加工すると、同じ画像・分割条件の場合のみ透明度の修正差分を復元します。",
      target: state.target,
      main: state.main,
      tab: state.tab,
      slots: state.slots,
      sources: state.sources.map((source) =>
        Object.fromEntries(
          [
            "name",
            "fingerprint",
            "width",
            "height",
            "columns",
            "rows",
            "xs",
            "ys",
            "columnYs",
            "manualColumnYs",
            "autoGridXs",
            "insets",
            "assignments",
            "mode",
            "tolerance",
            "color",
          ].map((key) => [key, source[key]]),
        ),
      ),
    };
    // Run the same validator used for imported settings before writing the file.
    try {
      P.readProject(data);
    } catch (error) {
      notify(error.message, true);
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    if (blob.size > 20 * 1024 * 1024) {
      notify(
        "設定JSONが20MBを超えています。消しゴム修正を減らすか、画像を小さくしてから加工してください。",
        true,
      );
      return;
    }
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "stamp-atelier-project.json");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $("project-status").textContent =
      "設定JSONを作成しました。元画像は含まれません。同じ元画像のファイルも手元で保管してください。";
    notify("セリフと加工設定をJSON保存しました。元画像は含まれません。");
  };
  $("load-project").onchange = () => {
    const file = $("load-project").files[0];
    if (!file) return;
    task(async () => {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("設定JSONは20MB以下のファイルを選んでください。");
      let raw;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        throw new Error(
          "JSONを読み込めません。STAMP atelierで保存した設定を選んでください。",
        );
      }
      const data = P.readProject(raw);
      if (
        state.dirty &&
        !confirm(
          "現在のセリフ・加工設定を読み込んだJSONに置き換えます。保存していない変更は失われます。続けますか？",
        )
      )
        return;
      const used = new Set();
      const sources = data.sources.map((settings) => {
        const previous = state.sources.find(
          (source) =>
            !used.has(source) &&
            source.image &&
            source.fingerprint === settings.fingerprint &&
            source.width === settings.width &&
            source.height === settings.height,
        );
        if (previous) used.add(previous);
        return {
          ...settings,
          id: nextId++,
          image: previous?.image || null,
          stamps: [],
        };
      });
      for (const old of state.sources)
        if (old.image && !used.has(old)) old.image.width = old.image.height = 1;
      Object.assign(state, {
        sources,
        slots: data.slots,
        target: data.target,
        main: data.main,
        tab: data.tab,
        selectedSource: 0,
        selectedStamp: -1,
      });
      easyCaptionDirty = false;
      Object.assign(easyRun, { phase: "idle", stage: "", error: "" });
      $("easy-style-enabled").checked = false;
      $("target-count").value = state.target;
      $("bulk-captions").value = state.slots
        .map((slot) => slot.caption)
        .join("\n")
        .replace(/\n+$/, "");
      invalidate();
      renderSources();
      renderSourceEditor();
      renderResults();
      const missing = state.sources.filter((source) => !source.image).length;
      $("project-status").textContent =
        `JSONを読み込みました。元画像${missing}枚を再選択し、加工ボタンで画像を作成してください。透過確認はやり直しになります。`;
      notify(
        missing
          ? `設定を復元しました。元画像${missing}枚を選び直してください。`
          : "設定を復元しました。加工ボタンで仕上がりを再作成してください。",
      );
    }).finally(() => {
      $("load-project").value = "";
    });
  };
  let easyCaptionDirty = false;
  function easyStep(index) {
    $("easy-steps")
      .querySelectorAll("li")
      .forEach((li, i) => {
        if (i === index) li.setAttribute("aria-current", "step");
        else li.removeAttribute("aria-current");
      });
  }
  function easyWarnings(messages) {
    $("easy-warnings").replaceChildren();
    for (const message of messages) {
      const li = document.createElement("li");
      li.className = "warning";
      li.textContent = message;
      $("easy-warnings").append(li);
    }
  }
  function pendingSuggestion(stamp) {
    const draft = suggestionDrafts.get(stamp.slot);
    return draft?.stamp === stamp && draft.needsRender;
  }
  function currentSuggestionDrafts() {
    return stamps().map((stamp) => {
      let draft = suggestionDrafts.get(stamp.slot);
      if (
        !draft ||
        draft.stamp !== stamp ||
        draft.baseCaption !== stamp.caption
      ) {
        draft = {
          stamp,
          slot: stamp.slot,
          baseCaption: stamp.caption,
          caption: stamp.caption,
          emotion: "unknown",
          approved: false,
        };
        suggestionDrafts.set(stamp.slot, draft);
      }
      return draft;
    });
  }
  function suggestionSummary() {
    const rows = currentSuggestionDrafts();
    const duplicates = window.StampSuggestions.duplicates(rows);
    $("suggestion-summary").textContent =
      `${rows.length}画像 / 未分類${rows.filter((row) => row.emotion === "unknown").length} / 未入力${rows.filter((row) => !row.caption.trim()).length} / 承認済み${rows.filter((row) => row.approved).length}` +
      (duplicates.length
        ? "。重複警告：" +
          duplicates
            .map(
              (group) =>
                `${group.slots.map((slot) => String(slot).padStart(2, "0")).join("・")}番「${group.caption}」`,
            )
            .join(" / ")
        : "。重複なし。");
  }
  function changedSuggestion(draft) {
    draft.approved = false;
    $("suggestion-ack").checked = false;
    suggestionSummary();
  }
  function renderSuggestionPanel() {
    const list = $("suggestion-grid");
    list.replaceChildren();
    for (const draft of currentSuggestionDrafts()) {
      const card = document.createElement("article");
      card.className = "suggestion-card";
      card.dataset.slot = draft.slot;
      const title = document.createElement("h4");
      title.textContent = `${String(draft.slot).padStart(2, "0")}.png`;
      const preview = C.canvas(185, 160);
      preview.className = "suggestion-preview checker";
      const index = stamps().indexOf(draft.stamp),
        from = $("stamp-grid").querySelectorAll("canvas")[index];
      if (from) preview.getContext("2d").drawImage(from, 0, 0, 185, 160);
      const evidence = document.createElement("p");
      evidence.className = "hint";
      evidence.textContent =
        draft.analysisReason || "画像解析は未実施。表情は手動選択できます。";
      const emotionLabel = document.createElement("label");
      emotionLabel.textContent = "表情（手動選択）";
      const emotion = document.createElement("select");
      emotion.dataset.kind = "emotion";
      for (const [key, group] of Object.entries(window.StampSuggestions.groups))
        emotion.add(new Option(group.label, key));
      emotion.value = draft.emotion;
      emotionLabel.append(emotion);
      const captionLabel = document.createElement("label");
      captionLabel.textContent = "提案セリフ（編集可）";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 120;
      input.placeholder =
        "判定できない場合は表情を選ぶか、直接入力してください";
      input.value = draft.caption;
      input.dataset.kind = "caption";
      captionLabel.append(input);
      const next = document.createElement("button");
      next.className = "button secondary wide";
      next.textContent = "次の候補";
      const applyCandidate = () => {
        input.value = draft.caption;
        changedSuggestion(draft);
      };
      emotion.onchange = () => {
        draft.emotion = emotion.value;
        const used = currentSuggestionDrafts()
          .filter((row) => row !== draft)
          .map((row) => row.caption);
        const value = window.StampSuggestions.choose(draft.emotion, used);
        if (value !== null) draft.caption = value;
        applyCandidate();
      };
      input.oninput = () => {
        draft.caption = input.value;
        changedSuggestion(draft);
      };
      next.onclick = () => {
        const pool = window.StampSuggestions.candidates(draft.emotion);
        if (!pool.length) {
          notify(
            "表情を手動で選ぶか、セリフを直接入力してください。自動判定は行いません。",
            true,
          );
          return;
        }
        draft.caption = pool[(pool.indexOf(draft.caption) + 1) % pool.length];
        applyCandidate();
      };
      const edit = document.createElement("button");
      edit.className = "text-button wide";
      edit.textContent = "画像・文字を個別編集";
      edit.onclick = () => {
        if (!state.busy) openEditor(stamps().indexOf(draft.stamp));
      };
      const remember = document.createElement("button");
      remember.className = "button secondary wide";
      remember.dataset.action = "remember-pose";
      remember.textContent = "選んだ表情をこの端末の見本に記憶";
      remember.onclick = () => {
        if (state.busy) return;
        try {
          window.StampCaptionVision.remember(
            draft.stamp.original,
            draft.stamp.mask,
            draft.emotion,
            window.StampSuggestions.groups[draft.emotion]?.label,
          );
          draft.analysisReason =
            "利用者が表情を指定した見本です。AIによる自動判定ではありません。近い画像の再提案に使用します。";
          renderSuggestionPanel();
          notify(
            "画素見本をこのブラウザ内だけに保存しました。他の画像は再提案ボタンで確認してください。",
          );
        } catch (error) {
          notify(error.message, true);
        }
      };
      card.append(
        title,
        preview,
        evidence,
        emotionLabel,
        captionLabel,
        next,
        remember,
        edit,
      );
      list.append(card);
    }
    suggestionSummary();
  }
  if ($("suggestion-panel")) {
    $("suggestion-panel").ontoggle = () => {
      if ($("suggestion-panel").open) renderSuggestionPanel();
    };
    $("suggest-safe-layout").onchange = () => {
      $("suggestion-ack").checked = false;
    };
    $("suggest-all").onclick = () => {
      const rows = currentSuggestionDrafts(),
        used = rows
          .filter((row) => row.emotion === "unknown")
          .map((row) => row.caption);
      for (const row of rows) {
        const value = window.StampSuggestions.choose(row.emotion, used);
        if (value !== null) {
          row.caption = value;
          row.approved = false;
          used.push(value);
        }
      }
      $("suggestion-ack").checked = false;
      renderSuggestionPanel();
      notify(
        "選択した表情から候補を提案しました。未分類の画像は変更していません。まだ画像には反映していません。",
      );
    };
    $("approve-suggestions").onclick = () =>
      task(async () => {
        const rows = currentSuggestionDrafts();
        let restoredInput = false;
        for (const row of rows) {
          const input = $("suggestion-grid").querySelector(
            `[data-slot="${row.slot}"] input[data-kind="caption"]`,
          );
          if (input && input.value !== row.caption) {
            row.caption = input.value;
            row.approved = false;
            restoredInput = true;
          }
        }
        if (restoredInput) {
          $("suggestion-ack").checked = false;
          suggestionSummary();
          throw new Error(
            "復元・変更された入力を読み取りました。セリフと重複警告を再確認して承認してください。",
          );
        }
        if (!$("suggestion-ack").checked)
          throw new Error(
            "全画像・セリフと重複警告を目視し、チェックを入れてください。",
          );
        if (
          !rows.length ||
          rows.some(
            (row) =>
              !row.caption.trim() || Array.from(row.caption).length > 120,
          )
        )
          throw new Error(
            "未入力のセリフがあります。表情を選ぶか120文字以内で直接入力してください。",
          );
        const reuse = new Map(
          lastValidation?.all.map((stamp, i) => [
            stamp,
            lastValidation.rendered[i],
          ]) || [],
        );
        const changed = [];
        for (const row of rows) {
          const stamp = row.stamp,
            safe = $("suggest-safe-layout").checked;
          if (
            row.needsRender ||
            stamp.caption !== row.caption ||
            (safe && (stamp.style.safeMargin !== 20 || !stamp.style.autoPlace))
          ) {
            stamp.caption = row.caption;
            if (safe)
              stamp.style = { ...stamp.style, safeMargin: 20, autoPlace: true };
            stamp.reviewed = false;
            changed.push(stamp.slot);
            reuse.delete(stamp);
            row.needsRender = true;
          }
          row.baseCaption = stamp.caption;
          row.approved = !row.needsRender;
        }
        $("suggestion-ack").checked = false;
        suggestionSummary();
        if (changed.length) {
          invalidate();
          const all = stamps(),
            cards = $("stamp-grid").querySelectorAll(".stamp-card");
          for (const slot of changed) {
            const i = all.findIndex((stamp) => stamp.slot === slot),
              stamp = all[i],
              card = cards[i];
            await frame();
            notify(`変更した画像を生成中… ${slot}番`, false, true);
            card.classList.remove("reviewed");
            card.querySelector(".review-state").textContent = "画像を生成中";
            C.renderStamp(stamp, card.querySelector("canvas"));
            card.querySelector(".review-state").textContent = "透過を確認";
            card.querySelector(".stamp-caption").textContent =
              stamp.caption || "（セリフなし）";
          }
          updateSpecial(changed);
          updateValidation(reuse);
          renderCaptionList();
          $("bulk-captions").value = state.slots
            .map((slot) => slot.caption)
            .join("\n")
            .replace(/\n+$/, "");
          if (!easyCaptionDirty)
            $("easy-captions").value = state.slots
              .map((slot) => slot.caption)
              .join("\n")
              .replace(/\n+$/, "");
        }
        for (const row of rows) {
          row.needsRender = false;
          row.approved = true;
        }
        $("suggestion-ack").checked = false;
        renderSuggestionPanel();
        notify(
          `セリフを承認し、変更した${changed.length}画像だけ生成しました。透過の目視確認は別途必要です。`,
        );
      });
  }
  async function proposeLoadedImages(replace = false) {
    const field = $(
      $("production-mode").value === "easy" ? "easy-captions" : "bulk-captions",
    );
    const saved = state.slots
      .map((slot) => slot.caption)
      .join("\n")
      .replace(/\n+$/, "");
    const pending =
      field.value.trim() && field.value !== saved
        ? field.value.replace(/\r/g, "").split("\n")
        : null;
    if (
      pending &&
      (pending.length > 40 ||
        pending.some((line) => Array.from(line).length > 120))
    )
      throw new Error("セリフは40行以内、各行120文字以内で入力してください。");
    const plan = easyPlan();
    if (plan.errors.length) throw new Error(plan.errors.join(" / "));
    for (const source of state.sources) {
      if (
        source.image &&
        source.assignments.some(Boolean) &&
        (source.processSignature !== signature(source) || !source.stamps.length)
      ) {
        notify(`提案用に分割・透過中… ${source.name}`, false, true);
        await processSource(source);
      }
    }
    const rows = currentSuggestionDrafts();
    if (replace) for (const row of rows) row.caption = "";
    if (pending && !replace)
      for (const row of rows) {
        if (pending[row.slot - 1] !== undefined)
          row.caption = pending[row.slot - 1];
      }
    const used = rows
      .filter((row) => row.caption.trim())
      .map((row) => row.caption);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.caption.trim()) continue; // Existing captions and user corrections win.
      await frame();
      const result = window.StampSuggestions.analyze(
        row.stamp.original,
        row.stamp.mask,
      );
      row.emotion = result.emotion;
      row.analysisReason = result.reason;
      const generic = $("allow-generic-captions")?.checked || false;
      row.caption =
        result.emotion === "unknown"
          ? generic
            ? window.StampSuggestions.automatic([
                ...used.map((caption) => ({ caption })),
                {
                  caption: "",
                  image: row.stamp.original,
                  mask: row.stamp.mask,
                },
              ]).at(-1).caption
            : ""
          : window.StampSuggestions.choose(result.emotion, used);
      if (result.emotion === "unknown")
        row.analysisReason += generic
          ? "。汎用候補（画像に合う保証なし）"
          : "。セリフは自動入力していません。表情を選ぶと候補が入ります。";
      used.push(row.caption);
      row.approved = false;
    }
    easyCaptionDirty = false;
    $("bulk-captions").value = saved;
    renderResults();
    $("suggestion-panel").open = true;
    $("suggestion-ack").checked = false;
    renderSuggestionPanel();
    $("auto-caption-status").textContent =
      `${rows.length}個を確認し、セリフ未入力は${rows.filter((row) => !row.caption.trim()).length}個です。確認済み見本との画素照合と限定的な涙特徴検査を使用。一致しない画像は判定できずとして扱い、汎用候補は希望した場合だけ入力します。一覧を修正・承認すると文字入りPNGを生成します。`;
  }
  if ($("clear-pose-references"))
    $("clear-pose-references").onclick = () => {
      if (state.busy) return;
      window.StampCaptionVision.clearLearned();
      notify(
        "このブラウザで記憶した画素見本を解除しました。画像・セリフは変更していません。",
      );
    };
  if ($("auto-captions"))
    $("auto-captions").onclick = () =>
      task(async () => {
        await proposeLoadedImages($("resuggest-existing")?.checked || false);
        $("suggestion-panel").scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
        notify(
          "番号別の提案を確認・承認してください。画像の表情・ポーズを確定する機能ではありません。",
        );
      });
  function easyPlan() {
    if (window.StampEasy?.version !== EASY_VERSION)
      return {
        errors: [
          "表示ファイルの版が一致しません。セリフをコピーし、設定JSONを保存してから画面を再読み込みしてください。Safari・ホーム画面追加版の両方で、版 easy-state-1 を確認してください。",
        ],
        warnings: [],
        missing: [],
      };
    return window.StampEasy.plan(state.sources, state.target, {
      allowPartial: true,
    });
  }
  function easyCaptionPending() {
    const saved = state.slots
      .map((slot) => slot.caption)
      .join("\n")
      .replace(/\n+$/, "");
    return (
      easyCaptionDirty || $("easy-captions").value.replace(/\r/g, "") !== saved
    );
  }
  function updateEasyState() {
    // Cached pre-update HTML may not yet contain the diagnostic fields.
    for (const [id, className, role] of [
      ["easy-failure", "easy-failure", "alert"],
      ["easy-state", "hint", "status"],
    ]) {
      if (!$(id)) {
        const field = document.createElement("p");
        field.id = id;
        field.className = className;
        field.setAttribute("role", role);
        $("easy-sources").insertAdjacentElement("afterend", field);
      }
    }
    const loaded = state.sources.filter((source) => source.image).length;
    const assigned = state.sources.reduce(
      (n, source) => n + source.assignments.filter(Boolean).length,
      0,
    );
    const count = stamps().length;
    $("easy-state").textContent =
      `読込済み${loaded}枚 / 採用${assigned}個 / 加工済み${count}個 / 申請${state.target}個` +
      (easyRun.phase === "processing"
        ? ` — 処理中：${easyRun.stage}`
        : easyRun.error
          ? " — 前回の加工に失敗"
          : "") +
      `（版 ${EASY_VERSION}）`;
    $("easy-failure").hidden = !easyRun.error;
    $("easy-failure").textContent = easyRun.error;
  }
  function easyStage(stage) {
    easyRun.stage = stage;
    updateEasyState();
  }
  function syncEasySources() {
    $("easy-sources").textContent =
      state.sources
        .map(
          (s, i) =>
            `${i + 1}. ${s.name}（${s.columns}列×${s.rows}段、${s.assignments.filter(Boolean).length}個）`,
        )
        .join(" / ") || "読み込み済み画像なし";
    $("easy-target").value = String(state.target);
    updateEasyState();
  }
  $("production-mode").onchange = () => {
    const easy = $("production-mode").value === "easy";
    document.body.classList.toggle("easy-mode", easy);
    $("easy-panel").hidden = !easy;
    if (easy) {
      if (!easyCaptionDirty)
        $("easy-captions").value = state.slots
          .map((slot) => slot.caption)
          .join("\n")
          .replace(/\n+$/, "");
      syncEasySources();
      const plan = easyPlan();
      easyWarnings([...plan.errors, ...plan.warnings]);
    }
  };
  $("easy-details").onclick = () => {
    const open = document.body.classList.toggle("easy-details-open");
    $("easy-details").setAttribute("aria-expanded", String(open));
    $("easy-details").textContent = open
      ? "詳細調整を閉じる"
      : "分割線・余白を細かく調整する";
    if (open && state.sources.length) {
      renderSourceEditor();
      $("split-section").scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };
  window.stampImportFiles = async (files) => {
    if (!files.length) return;
    const feedback = $("easy-upload-feedback");
    feedback.textContent = `選択：${files.map((f) => f.name).join("、")}（読み込み中）`;
    await importFiles(files, true);
    const loaded = state.sources.filter((source) => source.image).length;
    feedback.textContent = loaded
      ? `読み込み済み：${loaded}枚。次に一括加工へ進んでください。`
      : "画像を読み込めませんでした。形式やサイズを確認してください。";
  };
  window.dispatchEvent(new Event("stamp-import-ready"));
  $("easy-target").onchange = () => {
    $("target-count").value = $("easy-target").value;
    $("target-count").onchange();
    syncEasySources();
    const plan = easyPlan();
    easyWarnings([...plan.errors, ...plan.warnings]);
  };
  $("easy-captions").oninput = () => {
    easyCaptionDirty = true;
  };
  $("easy-process").onclick = () => {
    if (state.busy) {
      notify(
        "現在の読み込み・加工処理が終わるまでお待ちください。",
        false,
        true,
      );
      return;
    }
    Object.assign(easyRun, {
      phase: "processing",
      stage: "読み込み状態と設定の確認",
      error: "",
    });
    updateEasyState();
    return task(async () => {
      try {
        easyCaptionDirty = easyCaptionPending();
        // Partial production may preview captions; application export stays strict.
        const plan = easyPlan();
        easyWarnings([...plan.errors, ...plan.warnings]);
        if (plan.errors.length) throw new Error(plan.errors.join(" / "));
        const captionMode = ({auto:"auto",existing:"embedded",suggest:"empty"})[$("easy-caption-mode")?.value] || "auto";
        // Never overlay new text on an image that might already contain text.
        // Auto is conservative until reliable per-tile Japanese OCR is available.
        if (captionMode === "auto" && easyCaptionDirty) {
          throw new Error("自動判定では画像内文字の有無を確実に識別できません。二重文字を防ぐため、セリフ入り・なしを選択してください。");
        }
        if (captionMode === "embedded" && easyCaptionDirty) {
          throw new Error("「セリフあり」では新しい文字を追加しません。入力欄を空にするか、セリフなしモードに切り替えてください。");
        }
        if (captionMode === "empty" && !easyCaptionDirty &&
            !state.slots.some((slot) => slot.caption.trim())) {
          $("easy-caption-mode-status").textContent =
            "画像加工後、「セリフ候補を再確認」で40個の提案を確認・承認してください。";
        }
        if (easyCaptionDirty)
          window.StampEasy.captions($("easy-captions").value);
        if ($("easy-style-enabled").checked) {
          for (const id of ["easy-size", "easy-x", "easy-y"])
            if (!$(id).checkValidity() || !$(id).value)
              throw new Error(
                "文字サイズは16〜72、位置は0〜100の数値を指定してください。",
              );
        }
        if (easyCaptionDirty) {
          easyStage("セリフを番号へ登録");
          $("bulk-captions").value = $("easy-captions").value;
          applyCaptions();
          easyCaptionDirty = false;
        }
        if ($("easy-style-enabled").checked) {
          captureSlots();
          const patch = {
            font: $("easy-font").value,
            size: Number($("easy-size").value),
            color: $("easy-color").value,
            outline: $("easy-outline").checked,
            x: Number($("easy-x").value),
            y: Number($("easy-y").value),
            autoPlace: $("easy-auto-place").checked,
          };
          for (const slot of state.slots)
            slot.style = {
              ...slot.style,
              ...patch,
              overrides: [
                ...new Set([
                  ...(slot.style.overrides || []),
                  ...Object.keys(patch).filter((key) =>
                    T.OVERRIDES.includes(key),
                  ),
                ]),
              ],
            };
          for (const stamp of stamps()) {
            stamp.style = { ...state.slots[stamp.slot - 1].style };
            stamp.reviewed = false;
          }
          invalidate();
          $("easy-style-enabled").checked = false;
        }
        easyStep(1);
        for (let i = 0; i < state.sources.length; i++) {
          const source = state.sources[i];
          if (
            source.assignments.some(Boolean) &&
            (source.processSignature !== signature(source) ||
              !source.stamps.length)
          ) {
            notify(
              `元画像を自動加工中… ${i + 1} / ${state.sources.length}`,
              false,
              true,
            );
            await processSource(source);
          }
        }
        // Never silently overlay generated text on source artwork.
        // Automatic text detection is not reliable without OCR: ask for review instead.
        const captionSuggestionMode = $("easy-caption-mode").value;
        if (captionSuggestionMode === "suggest") {
          easyStage("セリフ候補を準備");
          await proposeLoadedImages(false);
        } else if (captionSuggestionMode === "auto") {
          notify("セリフの有無を確実に自動識別できないため、既存文字は保持し、必要な場合は「セリフ候補を再確認」を押してください。", false, true);
        }
        easyStage("文字合成・一覧プレビュー");
        finishedProcessing();
        easyStage("完成PNGの一括検査");
        notify("完成PNGを一括検査中…", false, true);
        await inspectAll();
        if (captionMode === "empty" && !easyCaptionDirty &&
            !state.slots.some((slot) => slot.caption.trim())) {
          $("easy-caption-mode-status").textContent =
            "分割完了。セリフ候補を確認して承認してください。";
          $("auto-caption-panel").scrollIntoView({ block: "start", behavior: "smooth" });
        } else if (captionMode === "auto") {
          $("easy-caption-mode-status").textContent =
            "自動判定（安全優先）：画像内の文字は保持し、未確認の文字追加は行いません。文字なしの場合は「セリフなし」に切り替えて候補を生成してください。";
        }
        Object.assign(easyRun, { phase: "complete", stage: "", error: "" });
        updateEasyState();
        easyStep(2);
        notify(
          (plan.missing.length
            ? `${stamps().length} / ${state.target}個のテスト加工です。申請用ZIPには全${state.target}個が必要です。`
            : "") +
            "自動加工と検査が完了しました。下の一覧を目視し、必要な画像だけ編集してください。自動承認はしていません。",
          false,
          true,
        );
      } catch (error) {
        const detail = error.message || String(error);
        easyRun.error = `加工に失敗しました（${easyRun.stage}）：${detail}。入力と元画像は維持しています。原因を確認して②で再試行してください。`;
        easyRun.phase = "failed";
        updateEasyState();
        throw new Error(easyRun.error);
      }
    });
  };
  $("easy-review").onclick = () => {
    if (state.busy) {
      notify(
        `処理中です：${easyRun.stage || "画像の読み込み"}。完了までお待ちください。`,
        false,
        true,
      );
      return;
    }
    if (easyRun.error) {
      notify(easyRun.error, true, true);
      return;
    }
    if (!stamps().length) {
      const loaded = state.sources.filter((source) => source.image).length;
      notify(
        loaded
          ? `画像${loaded}枚は読み込み済みです。加工結果はまだ0個です。② 自動加工して一括検査する を押してください。`
          : state.sources.length
            ? "保存した設定だけが読み込まれています。元画像を再選択してから②を押してください。"
            : "画像がまだ読み込まれていません。①から元画像を選択してください。",
        true,
        true,
      );
      updateEasyState();
      return;
    }
    $("bulk-review-heading").scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
    easyStep(2);
  };
  $("easy-export").onclick = () => {
    if (easyCaptionPending() || $("easy-style-enabled").checked) {
      notify(
        "未反映のセリフ・文字設定があります。自動加工して一括検査してください。",
        true,
      );
      return;
    }
    const v = validation();
    if (!v.complete || v.unreviewed || v.stale.length) {
      notify(
        "全画像を加工し、一覧または個別画面で目視確認してからZIPを保存してください。",
        true,
      );
      return;
    }
    easyStep(3);
    $("download-button").onclick();
  };
  renderCaptionList();
  $("production-mode").onchange();
  updateEasyState();
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
