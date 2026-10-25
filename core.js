/* Browser-only image processing and dependency-free, uncompressed ZIP writer. */
(function (root) {
  "use strict";
  const WIDTH = 370,
    HEIGHT = 320,
    MARGIN = 10;
  const FONTS = {
    sans: '-apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif',
    serif: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif',
    rounded: '"Hiragino Maru Gothic ProN", "Yu Gothic", Meiryo, sans-serif',
  };
  function canvas(width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  function near(data, p, color, tolerance) {
    return (
      data[p + 3] === 0 ||
      Math.max(
        Math.abs(data[p] - color[0]),
        Math.abs(data[p + 1] - color[1]),
        Math.abs(data[p + 2] - color[2]),
      ) <= tolerance
    );
  }
  function backgroundColor(data, width, height) {
    const points = [
      0,
      (width - 1) * 4,
      (height - 1) * width * 4,
      (width * height - 1) * 4,
    ];
    const colors = points
      .filter((p) => data[p + 3] > 0)
      .map((p) => Array.from(data.slice(p, p + 3)));
    if (!colors.length) return [255, 255, 255];
    let best = colors[0],
      score = -1;
    for (const color of colors) {
      const count = colors.filter((c) =>
        c.every((v, i) => Math.abs(v - color[i]) <= 24),
      ).length;
      if (count > score) {
        best = color;
        score = count;
      }
    }
    return best;
  }
  // Repeated opaque neutral alternation on multiple perimeter scanlines is
  // evidence of a baked-in checkerboard, never evidence of alpha transparency.
  // Conservative detection: preserve pixels and ask for local background edits.
  function paintedCheckerboard({ data, width, height }) {
    let patterned = 0;
    const scan = (length, point) => {
      const runs = [];
      for (let n = 0; n < length; n++) {
        const p = point(n) * 4;
        const rgb = data.subarray(p, p + 3);
        if (data[p + 3] !== 255 || Math.max(...rgb) - Math.min(...rgb) > 10 || Math.min(...rgb) < 150) return;
        const value = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3 / 12);
        if (runs.length && runs.at(-1).value === value) runs.at(-1).size++;
        else runs.push({value, size: 1});
      }
      const middle = runs.slice(1, -1);
      if (middle.length < 4) return;
      const sizes = middle.map(r => r.size), size = sizes.slice().sort((a,b)=>a-b)[Math.floor(sizes.length/2)];
      if (size < 2 || !sizes.every(n => Math.abs(n-size) <= 1)) return;
      if (!runs.every((r,i) => i < 2 || r.value === runs[i-2].value)) return;
      if (Math.abs(runs[0].value-runs[1].value) < 2) return;
      patterned++;
    };
    scan(width, x => x);
    scan(width, x => (height-1)*width+x);
    scan(height, y => y*width);
    scan(height, y => y*width+width-1);
    return patterned >= 2;
  }
  function floodMask(
    imageData,
    mode = "auto",
    tolerance = 24,
    custom = "#ffffff",
  ) {
    const { data, width, height } = imageData;
    const mask = new Uint8ClampedArray(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3];
    // A transparent corner is evidence of an already-transparent source, not a white background.
    const corners = [0, width - 1, (height - 1) * width, width * height - 1];
    if (
      mode === "none" ||
      paintedCheckerboard(imageData) ||
      (mode === "auto" && corners.some((i) => data[i * 4 + 3] === 0))
    )
      return mask;
    const color =
      mode === "white"
        ? [255, 255, 255]
        : mode === "custom"
          ? [1, 3, 5].map((i) => parseInt(custom.slice(i, i + 2), 16))
          : backgroundColor(data, width, height);
    const seen = new Uint8Array(width * height),
      queue = new Uint32Array(width * height);
    let head = 0,
      tail = 0;
    // Warm near-white fills in open outlines are artwork. A broad default
    // tolerance swallows them from the exterior; keep auto white removal tight.
    if (mode === "auto" && Math.min(...color) >= 245)
      tolerance = Math.min(tolerance, 8);
    function visit(i) {
      if (!seen[i]) {
        seen[i] = 1;
        if (
          (data[i * 4 + 3] === 0 || data[i * 4 + 3] === 255) &&
          near(data, i * 4, color, tolerance)
        ) {
          queue[tail++] = i;
          mask[i] = 0;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    while (head < tail) {
      const i = queue[head++],
        x = i % width;
      if (x > 0) visit(i - 1);
      if (x + 1 < width) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i + width < mask.length) visit(i + width);
    }
    return mask;
  }
  // Only exterior-connected neutral white is background. Warm white artwork
  // and enclosed white areas are deliberately excluded from this wider flood.
  function exteriorWhiteMatte(image, mask) {
    const {data,width,height}=image;
    const bg=backgroundColor(data,width,height);
    if (Math.min(...bg)<245 || paintedCheckerboard(image) ||
        [0,width-1,(height-1)*width,width*height-1].some(i=>data[i*4+3]!==255)) return null;
    const queue=new Uint32Array(mask.length), seen=new Uint8Array(mask.length);
    let head=0,tail=0;
    function visit(i) {
      if(seen[i])return;seen[i]=1;
      const rgb=data.subarray(i*4,i*4+3);
      if(mask[i]===0 || (data[i*4+3]===255 && Math.max(...rgb)-Math.min(...rgb)<=6 &&
          bg.every((v,k)=>Math.abs(v-rgb[k])<=30))) {
        mask[i]=0;queue[tail++]=i;
      }
    }
    for(let x=0;x<width;x++){visit(x);visit((height-1)*width+x);}
    for(let y=0;y<height;y++){visit(y*width);visit(y*width+width-1);}
    while(head<tail){const i=queue[head++],x=i%width;
      if(x)visit(i-1);if(x+1<width)visit(i+1);
      if(i>=width)visit(i-width);if(i+width<mask.length)visit(i+width);
    }
    // Letter counters can be enclosed by a single glyph. Restrict this pass
    // to small components entirely above the largest (character) component;
    // never apply it to the face, hands, body, bedding or mouth interiors.
    seen.fill(0);
    const groups=[];
    for(let start=0;start<mask.length;start++) {
      if(seen[start]||!mask[start])continue;
      head=0;tail=0;queue[tail++]=start;seen[start]=1;
      let minY=height,maxY=0;
      while(head<tail) {
        const i=queue[head++],x=i%width,y=Math.floor(i/width),rgb=data.subarray(i*4,i*4+3);
        minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        for(const n of [x?i-1:-1,x+1<width?i+1:-1,i>=width?i-width:-1,i+width<mask.length?i+width:-1])
          if(n>=0&&!seen[n]&&mask[n]){seen[n]=1;queue[tail++]=n;}
      }
      groups.push({pixels:queue.slice(0,tail),minY,maxY});
    }
    const main=groups.reduce((a,b)=>!a||b.pixels.length>a.pixels.length?b:a,null);
    for(const g of groups)if(main&&g!==main&&g.maxY<main.minY&&g.maxY-g.minY<height*.32)
      for(const i of g.pixels) {
        const rgb=data.subarray(i*4,i*4+3);
        if(data[i*4+3]===255&&Math.max(...rgb)-Math.min(...rgb)<=11&&bg.every((v,k)=>Math.abs(v-rgb[k])<=30))mask[i]=0;
      }
    const artwork=new Uint8Array(mask.length), upperGlyph=new Uint8Array(mask.length);
    for(const g of groups)for(const i of g.pixels) {
      if(main&&g.maxY>=main.minY)artwork[i]=1;
      else if(main&&g.maxY-g.minY<height*.32)upperGlyph[i]=1;
    }
    const result=new Uint8ClampedArray(data), base=mask.slice();
    // Estimate coverage on the single exposed antialias rim from a nearby
    // stronger sample, then remove the white contribution from RGB as well.
    // Alpha-only fading would keep a white halo on dark chat backgrounds.
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++) {
      const i=y*width+x,p=i*4,rgb=data.subarray(p,p+3);
      if(base[i]!==255 || data[p+3]!==255 ||
          ![i-1,i+1,i-width,i+width].some(n=>base[n]===0))continue;
      const hi=Math.max(...rgb),lo=Math.min(...rgb);
      if((artwork[i] || y>=height*.30) && hi>=250 && lo>=230 && hi-lo>=12)continue;
      const distance=Math.max(...bg.map((v,k)=>Math.abs(v-rgb[k])));
      if(distance<1 || distance>180)continue;
      let strongest=distance;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++) {
        const xx=x+dx,yy=y+dy;
        if(xx<0||xx>=width||yy<0||yy>=height)continue;
        const n=yy*width+xx;if(base[n]!==255)continue;
        strongest=Math.max(strongest,...bg.map((v,k)=>Math.abs(v-data[n*4+k])));
      }
      if(strongest<distance+30)continue;
      const alpha=distance/strongest;
      mask[i]=Math.max(1,Math.round(alpha*255));
      for(let k=0;k<3;k++)result[p+k]=Math.max(0,Math.min(255,Math.round((rgb[k]-bg[k]*(1-alpha))/alpha)));
    }
    return result;
  }
  // Preview-only proposal. Change alpha on one exposed opaque matte rim;
  // never recolor artwork, flood further inward or modify existing partial alpha.
  function proposeMatteCleanup(
    image,
    mask,
    mode,
    tolerance = 24,
    custom = "#ffffff",
  ) {
    const { width, height, data } = image,
      result = mask.slice();
    if (
      mode === "none" ||
      (mode === "auto" &&
        [0, width - 1, (height - 1) * width, width * height - 1].some(
          (i) => data[i * 4 + 3] === 0,
        ))
    )
      return { mask: result, changed: 0 };
    const color =
      mode === "white"
        ? [255, 255, 255]
        : mode === "custom"
          ? [1, 3, 5].map((i) => parseInt(custom.slice(i, i + 2), 16))
          : backgroundColor(data, width, height);
    let changed = 0;
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (data[i * 4 + 3] !== 255 || mask[i] !== 255) continue;
        const exposed = [i - 1, i + 1, i - width, i + width].filter(
          (n) => mask[n] === 0,
        ).length;
        if (exposed < 2) continue;
        const distance = Math.max(
          ...color.map((c, k) => Math.abs(data[i * 4 + k] - c)),
        );
        if (distance <= tolerance || distance >= tolerance + 32) continue;
        result[i] = Math.max(
          1,
          Math.round((255 * (distance - tolerance)) / 32),
        );
        changed++;
      }
    return { mask: result, changed };
  }
  function alphaBounds(data, width, height) {
    let left = width,
      right = -1,
      top = height,
      bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    return right < 0
      ? null
      : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }
  function tileRect(source, column, row) {
    const { xs, ys, image } = source;
    const rowGrid = activeRowGrid(source);
    const columnLines = rowGrid?.xs[row] || xs;
    const left = Math.round(columnLines[column] * image.width);
    const rowLines = rowGrid?.ys || source.columnYs?.[column] || ys;
    const top = Math.round(rowLines[row] * image.height);
    const right = Math.round(columnLines[column + 1] * image.width);
    const bottom = Math.round(rowLines[row + 1] * image.height);
    const inset = source.insets || { left: 0, right: 0, top: 0, bottom: 0 };
    const x = Math.min(
      right - 1,
      left + Math.ceil(((right - left) * inset.left) / 100),
    );
    const y = Math.min(
      bottom - 1,
      top + Math.ceil(((bottom - top) * inset.top) / 100),
    );
    return {
      x,
      y,
      width: Math.max(
        1,
        right - Math.ceil(((right - left) * inset.right) / 100) - x,
      ),
      height: Math.max(
        1,
        bottom - Math.ceil(((bottom - top) * inset.bottom) / 100) - y,
      ),
    };
  }
  function isolateRect(image, rect) {
    // First copy integer pixels at 1:1. drawImage(source, sx, sy, sw, sh, ...) can
    // sample neighbouring pixels outside that source rectangle when interpolating.
    const isolated = canvas(rect.width, rect.height);
    isolated.getContext("2d").drawImage(image, -rect.x, -rect.y);
    return isolated;
  }
  // Transparent RGB is undefined; on transparent sheets alpha alone defines ink.
  // Mixed corner alpha cannot establish one reliable background model.
  function gridInk(image) {
    const { data, width, height } = image;
    const corners = [0, width - 1, (height - 1) * width, width * height - 1];
    if (corners.every((p) => data[p * 4 + 3] === 0))
      return (x, y) => data[(y * width + x) * 4 + 3] > 0;
    if (corners.some((p) => data[p * 4 + 3] !== 255)) return null;
    const bg = Array.from(data.slice(0, 3));
    if (corners.some((p) => bg.some((v, k) => Math.abs(data[p * 4 + k] - v) > 18)))
      return null;
    return (x, y) => {
      const p = (y * width + x) * 4;
      return data[p + 3] > 0 && bg.some((v, k) => Math.abs(data[p + k] - v) > 30);
    };
  }
  // Locate nearly blank gutters close to the expected grid positions.
  // Only return strong suggestions; uncertain sheets keep their manual grid.
  function suggestGridLines(image, columns, rows, preferNearest = false) {
    const width = image.width, height = image.height;
    if (!columns || !rows || width < columns * 20 || height < rows * 20)
      return null;
    const sample = canvas(width, height);
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const isInk = gridInk(ctx.getImageData(0, 0, width, height));
    sample.width = sample.height = 1;
    if (!isInk) return null;
    function line(axis, index, total, count) {
      const nominal = Math.round((index * total) / count);
      const cross = axis === "x" ? height : width;
      const step = 1; // Never skip a thin antenna, guide digit or punctuation.
      const start = Math.max(1, nominal - Math.max(2, Math.round((total / count) * 0.16)));
      const end = Math.min(total - 2, nominal + Math.max(2, Math.round((total / count) * 0.16)));
      const blank = [];
      for (let pos = start; pos <= end; pos++) {
        let ink = 0;
        for (let other = 0; other < cross; other += step) {
          const x = axis === "x" ? pos : other;
          const y = axis === "x" ? other : pos;
          if (isInk(x, y)) ink++;
        }
        blank.push(ink === 0);
      }
      // Choose the center of a blank corridor, not its edge. This preserves
      // nearby ears, paws and decorations and avoids spurious boundary alerts.
      let best = null;
      for (let i = 0; i < blank.length;) {
        if (!blank[i]) { i++; continue; }
        let j = i;
        while (j + 1 < blank.length && blank[j + 1]) j++;
        const center = Math.round((i + j) / 2) + start;
        const candidate = { center, length: j - i + 1 };
        if (preferNearest && candidate.length < 2) { i = j + 1; continue; }
        if (!best || (preferNearest
          ? Math.abs(center - nominal) < Math.abs(best.center - nominal)
          : candidate.length > best.length) ||
          (candidate.length === best.length &&
            Math.abs(center - nominal) < Math.abs(best.center - nominal)))
          best = candidate;
        i = j + 1;
      }
      const minCorridor = preferNearest ? 2 : Math.max(3, Math.round(total / count * 0.015));
      return best && best.length >= minCorridor ? best.center / total : null;
    }
    const xs = [0], ys = [0];
    for (let i = 1; i < columns; i++) {
      const x = line("x", i, width, columns);
      if (x === null) return null;
      xs.push(x);
    }
    for (let i = 1; i < rows; i++) {
      const y = line("y", i, height, rows);
      if (y === null) return null;
      ys.push(y);
    }
    xs.push(1); ys.push(1);
    return { xs, ys };
  }
  // Find a safe horizontal gutter separately in each column. Sticker artwork
  // can be vertically staggered, so a single row boundary may cut another cat.
  function suggestColumnRowLines(image, xs, rows, diagnostics = null) {
    const width = image.width, height = image.height;
    const sample = canvas(width, height);
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const isInk = gridInk(ctx.getImageData(0, 0, width, height));
    sample.width = sample.height = 1;
    if (!isInk) return null;
    const lines = [];
    for (let c = 0; c < xs.length - 1; c++) {
      const x0 = Math.round(xs[c] * width), x1 = Math.round(xs[c+1] * width);
      const perColumn = [0];
      for (let r = 1; r < rows; r++) {
        const nominal = Math.round(r * height / rows);
        // Search around the expected divider, not inside neighboring artwork.
        const start = Math.max(1, nominal - Math.round(height / rows * 0.26));
        const end = Math.min(height - 2, nominal + Math.round(height / rows * 0.26));
        // Count foreground pixels in each scanline. A true gutter must
        // separate two foreground groups, not just pass through a letter.
        const densities = [];
        const look = Math.max(8, Math.round(height / rows * 0.09));
        // The evidence on either side may lie outside the candidate window.
        const densityStart = Math.max(0, start - look);
        const densityEnd = Math.min(height - 1, end + look);
        const step = 1; // Subsampling can miss one-pixel-wide foreground.
        for (let y = densityStart; y <= densityEnd; y++) {
          let ink = 0, count = 0;
          for (let x = x0; x < x1; x += step) {
            if (isInk(x, y)) ink++;
            count++;
          }
          densities.push(ink / Math.max(1, count));
        }
        const searchDensities = densities.slice(start - densityStart, end - densityStart + 1);
        const blank = searchDensities.map((v) => v === 0);
        const minLength = Math.max(5, Math.round(height / rows * 0.018));
        const maxDrift = Math.round(height / rows * 0.24);
        let best = null;
        for (let i = 0; i < blank.length;) {
          if (!blank[i]) { i++; continue; }
          let j = i;
          while (j + 1 < blank.length && blank[j + 1]) j++;
          const center = start + Math.round((i + j) / 2);
          const length = j - i + 1;
          const distance = Math.abs(center - nominal);
          if (length >= minLength && distance <= maxDrift) {
            // Inspect the image on both sides of the proposed boundary.
            // An empty interior gap in a caption or drawing is unsafe.
            const upper = densities.slice(Math.max(0, start - densityStart + i - look), start - densityStart + i);
            const lower = densities.slice(start - densityStart + j + 1, Math.min(densities.length, start - densityStart + j + 1 + look));
            const upperInk = upper.reduce((a, b) => a + b, 0);
            const lowerInk = lower.reduce((a, b) => a + b, 0);
            const hasBothGroups = upperInk >= 0.02 && lowerInk >= 0.02;
            // Prefer a broad empty corridor between actual groups.
            if (hasBothGroups) {
              const score = length - distance * 0.08 +
                Math.min(upperInk, lowerInk) * 4;
              if (!best || score > best.score)
                best = { center, length, score };
            }
          }
          i = j + 1;
        }
        // Never guess a boundary if there is no defensible separation.
        if (!best) {
          if (!diagnostics) return null;
          diagnostics.push({ column: c, boundary: r });
        }
        perColumn.push(best ? best.center / height : r / rows);
      }
      perColumn.push(1);
      if (perColumn.some((v,i)=>i>0 && v<=perColumn[i-1])) return null;
      lines.push(perColumn);
    }
    return lines;
  }
  function activeRowGrid(source) {
    const grid = source.autoRowGrid;
    return grid && grid.key === JSON.stringify([source.xs, source.ys, !!source.manualColumnYs]) ? grid : null;
  }
  // Some sheets have clear horizontal gutters but staggered column gaps.
  // Accept this alternative only if there are exactly the requested row bands,
  // and every row has foreground-free column corridors at full resolution.
  function suggestRowGrid(image, columns, rows) {
    const {width,height}=image, sample=canvas(width,height);
    const ctx=sample.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
    const ink=gridInk(ctx.getImageData(0,0,width,height));
    sample.width=sample.height=1;
    if(!ink || rows<2) return null;
    const occupied=[];
    for(let y=0;y<height;y++) {
      let found=false;for(let x=0;x<width&&!found;x++) found=ink(x,y);
      occupied.push(found);
    }
    const gaps=[];
    for(let y=0;y<height;) {
      if(occupied[y]){y++;continue;}
      const start=y;while(y<height&&!occupied[y])y++;
      if(start>0&&y<height&&y-start>=Math.max(5,Math.round(height/rows*.018)))gaps.push((start+y-1)/2);
    }
    if(gaps.length!==rows-1)return null;
    const ys=[0,...gaps.map(y=>Math.round(y)/height),1],xs=[];
    for(let r=0;r<rows;r++) {
      const top=Math.round(ys[r]*height),bottom=Math.round(ys[r+1]*height);
      if(bottom-top<height/rows*.55||bottom-top>height/rows*1.45)return null;
      const crop=isolateRect(image,{x:0,y:top,width,height:bottom-top});
      const grid=suggestGridLines(crop,columns,1,true);crop.width=crop.height=1;
      if(!grid)return null;xs.push(grid.xs);
    }
    return {xs,ys};
  }
  // A source-grid cut through visible artwork needs a human ownership check.
  // This is diagnostic only: never erase thin antennae, lettering or decorations.
  function tileBoundaryReview(mask, width, height) {
    const band = Math.max(2, Math.ceil(Math.min(width, height) * 0.015));
    const edges = [];
    const count = (side) => {
      let pixels = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          if (side === "left" && x >= band) continue;
          if (side === "right" && x < width - band) continue;
          if (side === "top" && y >= band) continue;
          if (side === "bottom" && y < height - band) continue;
          if (mask[y * width + x] > 0) pixels++;
        }
      return pixels;
    };
    for (const side of ["left", "right", "top", "bottom"])
      if (count(side) >= 2) edges.push(side);
    // Detect small disconnected opaque islands along a vertical cut. They
    // can be neighboring guide digits, but may also be valid punctuation or
    // antenna tips. Report only: never erase source pixels automatically.
    const seen = new Uint8Array(mask.length);
    const queue = new Uint32Array(mask.length);
    const suspicious = [];
    const maxIsland = Math.max(8, Math.floor(width * height * 0.012));
    for (const side of ["left", "right"]) {
      const startX = side === "left" ? 0 : width - band;
      const endX = side === "left" ? band : width;
      for (let y = 0; y < height; y++)
        for (let x = startX; x < endX; x++) {
          const start = y * width + x;
          if (seen[start] || mask[start] === 0) continue;
          let head = 0, tail = 0, count = 0;
          let minX = x, maxX = x, minY = y, maxY = y;
          seen[start] = 1;
          queue[tail++] = start;
          while (head < tail) {
            const p = queue[head++];
            const px = p % width, py = (p - px) / width;
            count++;
            minX = Math.min(minX, px); maxX = Math.max(maxX, px);
            minY = Math.min(minY, py); maxY = Math.max(maxY, py);
            for (const n of [px > 0 ? p - 1 : -1,
              px + 1 < width ? p + 1 : -1,
              py > 0 ? p - width : -1,
              py + 1 < height ? p + width : -1]) {
              if (n >= 0 && !seen[n] && mask[n] > 0) {
                seen[n] = 1;
                queue[tail++] = n;
              }
            }
          }
          if (count >= 3 && count <= maxIsland &&
              maxX - minX + 1 <= width * 0.20 &&
              maxY - minY + 1 <= height * 0.20)
            suspicious.push(side);
        }
    }
    for (const side of suspicious)
      if (!edges.includes(side + "・小さな独立部分")) edges.push(side + "・小さな独立部分");
    const touching=[];
    for(const side of ["left","right","top","bottom"]) {
      const length=side==="left"||side==="right"?height:width;
      for(let n=0;n<length;n++) {
        const i=side==="left"?n*width:side==="right"?n*width+width-1:
          side==="top"?n:(height-1)*width+n;
        if(mask[i]>0){touching.push(side);break;}
      }
    }
    return { needsReview: edges.length > 0, edges, touching };
  }
  // Inspect complete alpha components (including antialiasing), not only their
  // dark cores. A dark facial detail can be connected to a colored character.
  // Ambiguous components remain visible and require manual review.
  function isolatedGuideGroups(original, mask, region = {}) {
    const w = original.width, h = original.height;
    const cw = region.width || w, ch = region.height || h;
    const ox = region.x || 0, oy = region.y || 0;
    const x0 = Math.max(0, Math.floor(ox + cw * 0.025));
    const x1 = Math.min(w, Math.ceil(ox + cw * 0.24));
    const y0 = Math.max(0, Math.floor(oy + ch * 0.005));
    const y1 = Math.min(h, Math.ceil(oy + ch * 0.30));
    const seen = new Uint8Array(w * h), queue = new Uint32Array(w * h);
    const groups = [];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const start = y * w + x;
        if (seen[start] || !mask[start]) continue;
        let head = 0, tail = 0, dark = 0, colored = false;
        let minX = x, maxX = x, minY = y, maxY = y;
        seen[start] = 1; queue[tail++] = start;
        while (head < tail) {
          const p = queue[head++], px = p % w, py = (p - px) / w;
          minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          minY = Math.min(minY, py); maxY = Math.max(maxY, py);
          const rgb = original.data.subarray(p * 4, p * 4 + 3);
          if (Math.max(...rgb) < 95 && mask[p] > 64) dark++;
          if (Math.max(...rgb) - Math.min(...rgb) > 35) colored = true;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx, ny = py + dy;
              if ((!dx && !dy) || nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
              const n = ny * w + nx;
              if (!seen[n] && mask[n]) { seen[n] = 1; queue[tail++] = n; }
            }
        }
        if (!colored && dark >= 1 && tail <= Math.max(20, w * h * 0.006) &&
            minX > x0 && maxX < x1 - 1 && minY > y0 && maxY < y1 - 1 &&
            maxX - minX + 1 <= w * 0.10 && maxY - minY + 1 <= h * 0.10)
          groups.push({ minX, maxX, minY, maxY, pixels: Array.from(queue.subarray(0, tail)) });
      }
    return groups;
  }
  function guideNumberCandidate(original, mask, region) {
    return isolatedGuideGroups(original, mask, region).length > 0;
  }
  function removeIsolatedGuideNumber(original, mask, region = {}) {
    let groups = isolatedGuideGroups(original, mask, region);
    const w = original.width, h = original.height;
    const cw = region.width || w, ch = region.height || h;
    const ox = region.x || 0, oy = region.y || 0;
    // Antialiased digits can touch through pale pixels, and a glyph can have
    // a detached serif. Merge overlapping x spans before inspecting dark cores.
    groups.sort((a, b) => a.minX - b.minX);
    const merged = [];
    for (const g of groups) {
      const a = merged.at(-1);
      if (a && g.minX <= a.maxX && g.minY <= a.maxY + 1 && g.maxY >= a.minY - 1) {
        a.minX = Math.min(a.minX, g.minX); a.maxX = Math.max(a.maxX, g.maxX);
        a.minY = Math.min(a.minY, g.minY); a.maxY = Math.max(a.maxY, g.maxY);
        a.pixels.push(...g.pixels);
      } else merged.push({ ...g, pixels: [...g.pixels] });
    }
    groups = merged;
    let glyphs = groups;
    if (groups.length === 1) {
      const g = groups[0], columns = new Map();
      for (const p of g.pixels) {
        const rgb = original.data.subarray(p * 4, p * 4 + 3);
        if (Math.max(...rgb) >= 95 || mask[p] <= 64) continue;
        const x = p % w, y = Math.floor(p / w);
        if (!columns.has(x)) columns.set(x, []);
        columns.get(x).push(y);
      }
      glyphs = [];
      for (let x = g.minX; x <= g.maxX; x++) {
        if (!columns.has(x)) continue;
        const ys = []; const minX = x;
        while (columns.has(x)) { ys.push(...columns.get(x)); x++; }
        glyphs.push({ minX, maxX: x - 1, minY: Math.min(...ys), maxY: Math.max(...ys) });
      }
    }
    // Require two aligned dark glyphs even when their antialias fringes touch.
    if (glyphs.length !== 2 || groups.length > 2) return 0;
    const [a, b] = glyphs;
    const ah = a.maxY - a.minY + 1, bh = b.maxY - b.minY + 1;
    if (Math.min(ah, bh) < 4 ||
        Math.abs(a.minY - b.minY) > Math.max(1, Math.min(ah, bh) * 0.2) ||
        Math.min(ah, bh) / Math.max(ah, bh) < 0.75 ||
        b.minX <= a.maxX || b.minX - a.maxX > Math.max(ah, bh) ||
        b.maxX >= ox + cw * 0.21 || Math.max(a.maxY, b.maxY) >= oy + ch * 0.26 ||
        b.maxX - a.minX > cw * 0.13) return 0;
    let removed = 0;
    // Delete only the isolated glyph pixels. Never erase a padded bounding
    // rectangle: neighboring punctuation and colored artwork must survive.
    for (const group of groups)
      for (const p of group.pixels) { mask[p] = 0; removed++; }
    return removed;
  }
  function createTile(source, column, row, mode, tolerance, color) {
    const rect = tileRect(source, column, row);
    // Keep the source layer at up to 600px, rather than repeatedly enlarging a 250px image.
    const scale = Math.min(1, 600 / Math.max(rect.width, rect.height));
    const crop = canvas(
      Math.max(1, Math.round(rect.width * scale)),
      Math.max(1, Math.round(rect.height * scale)),
    );
    const ctx = crop.getContext("2d", { willReadFrequently: true });
    const isolated = isolateRect(source.image, rect);
    ctx.drawImage(isolated, 0, 0, crop.width, crop.height);
    isolated.width = isolated.height = 1;
    const original = ctx.getImageData(0, 0, crop.width, crop.height);
    const mask = floodMask(original, mode, tolerance, color);
    const matte = mode === "auto" ? exteriorWhiteMatte(original, mask) : null;
    crop.width = crop.height = 1;
    const isNumberedSheet = source.columns === 5 && source.rows === 8;
    // Guide numbers belong to the detected cell, not the equal-grid origin.
    // Map its un-inset top-left into crop pixels so row drift and manual
    // insets do not move the search away from the original printed number.
    const sx = original.width / rect.width, sy = original.height / rect.height;
    const guideRegion = {
      x: (Math.round((activeRowGrid(source)?.xs[row] || source.xs)[column] * source.image.width) - rect.x) * sx,
      y: (Math.round((activeRowGrid(source)?.ys || source.columnYs?.[column] || source.ys)[row] * source.image.height) - rect.y) * sy,
      width: source.image.width / source.columns * sx,
      height: source.image.height / source.rows * sy,
    };
    const possibleNumber = isNumberedSheet && guideNumberCandidate(original, mask, guideRegion);
    const guidePixelsRemoved = possibleNumber
      ? removeIsolatedGuideNumber(original, mask, guideRegion) : 0;
    const boundaryReview = tileBoundaryReview(mask, original.width, original.height);
    if (paintedCheckerboard(original)) {
      boundaryReview.needsReview = true;
      boundaryReview.edges.push("描き込み市松模様：透過情報ではありません。個別編集で背景を調整");
    }
    if (possibleNumber) {
      boundaryReview.needsReview = true;
      boundaryReview.edges.push(guidePixelsRemoved
        ? "左上・管理番号を自動除去（要目視確認）"
        : "左上・元画像の管理番号の可能性");
    }
    return {
      sourceRect: { ...rect },
      boundaryReview,
      guidePixelsRemoved,
      original,
      matteData: matte,
      mask,
      autoMask: mask.slice(),
      caption: "",
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      layout: { scale: 90, x: 50, y: 50 },
      style: {
        font: "sans",
        size: 32,
        x: 50,
        y: 84,
        color: "#293c33",
        outline: true,
      },
      reviewed: false,
      undo: [],
      redo: [],
    };
  }
  function stampCrop(stamp) {
    const { width, height } = stamp.original;
    const crop = stamp.crop || { left: 0, right: 0, top: 0, bottom: 0 };
    const x = Math.ceil((width * crop.left) / 100),
      y = Math.ceil((height * crop.top) / 100);
    return {
      x,
      y,
      width: Math.max(1, width - Math.ceil((width * crop.right) / 100) - x),
      height: Math.max(1, height - Math.ceil((height * crop.bottom) / 100) - y),
    };
  }
  function maskBounds(
    mask,
    width,
    height,
    rect = { x: 0, y: 0, width, height },
  ) {
    let left = width,
      right = -1,
      top = height,
      bottom = -1;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if (mask[y * width + x]) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return right < 0
      ? null
      : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }
  function baseImagePlacement(stamp) {
    if (stamp.activePlacement) return stamp.activePlacement;
    const margin = stamp.style?.safeMargin === 20 ? 20 : MARGIN;
    const crop = stampCrop(stamp);
    const bounds =
      maskBounds(
        stamp.mask,
        stamp.original.width,
        stamp.original.height,
        crop,
      ) || crop;
    const layout = stamp.layout || { scale: 90, x: 50, y: 50 };
    const ratio =
      (Math.min(
        (WIDTH - margin * 2) / bounds.width,
        (HEIGHT - margin * 2) / bounds.height,
      ) *
        Math.max(20, Math.min(100, layout.scale))) /
      100;
    const width = bounds.width * ratio,
      height = bounds.height * ratio;
    const x =
      margin +
      ((WIDTH - margin * 2 - width) * Math.max(0, Math.min(100, layout.x))) /
        100;
    const y =
      margin +
      ((HEIGHT - margin * 2 - height) * Math.max(0, Math.min(100, layout.y))) /
        100;
    return {
      crop,
      bounds,
      ratio,
      offsetX: x - bounds.x * ratio,
      offsetY: y - bounds.y * ratio,
    };
  }
  function imagePlacement(stamp) {
    if (stamp.activePlacement) return stamp.activePlacement;
    if (
      root.StampTypography &&
      stamp.caption?.trim() &&
      root.StampTypography.resolve(stamp.caption, stamp.style).autoPlace
    ) {
      const result = renderStamp(stamp);
      result.canvas.width = result.canvas.height = 1;
      return result.imagePlacement;
    }
    return baseImagePlacement(stamp);
  }
  function applyBrush(stamp, x, y, radius, mode) {
    const p = imagePlacement(stamp),
      crop = p.crop;
    const sx = (x - p.offsetX) / p.ratio,
      sy = (y - p.offsetY) / p.ratio,
      sr = radius / p.ratio;
    for (
      let py = Math.max(crop.y, Math.floor(sy - sr));
      py < Math.min(crop.y + crop.height, Math.ceil(sy + sr));
      py++
    ) {
      for (
        let px = Math.max(crop.x, Math.floor(sx - sr));
        px < Math.min(crop.x + crop.width, Math.ceil(sx + sr));
        px++
      ) {
        if ((px - sx) ** 2 + (py - sy) ** 2 <= sr ** 2) {
          const i = py * stamp.original.width + px;
          stamp.mask[i] =
            mode === "restore" ? stamp.original.data[i * 4 + 3] : 0;
        }
      }
    }
  }
  function renderBefore(stamp, target = canvas(WIDTH, HEIGHT)) {
    target.width = WIDTH;
    target.height = HEIGHT;
    const layer = canvas(stamp.original.width, stamp.original.height);
    layer.getContext("2d").putImageData(stamp.original, 0, 0);
    const ratio = Math.min(350 / layer.width, 300 / layer.height);
    target
      .getContext("2d")
      .drawImage(
        layer,
        (WIDTH - layer.width * ratio) / 2,
        (HEIGHT - layer.height * ratio) / 2,
        layer.width * ratio,
        layer.height * ratio,
      );
    layer.width = layer.height = 1;
    return target;
  }
  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      const chars =
        typeof Intl.Segmenter === "function"
          ? Array.from(
              new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(
                paragraph,
              ),
              (s) => s.segment,
            )
          : Array.from(paragraph);
      for (const char of chars) {
        if (line && ctx.measureText(line + char).width > maxWidth) {
          lines.push(line);
          line = char;
        } else line += char;
      }
      lines.push(line);
    }
    return lines;
  }
  function clearAutomaticLines(ctx, stamp) {
    if (stamp.cleanupEnabled === false || !root.StampResidue?.automaticLines)
      return [];
    const lines = root.StampResidue.automaticLines(
      ctx.getImageData(0, 0, WIDTH, HEIGHT),
    );
    for (const line of lines)
      ctx.clearRect(line.x, line.y, line.width, line.height);
    return lines;
  }
  function renderUncleaned(stamp, target = canvas(WIDTH, HEIGHT)) {
    return renderStamp({ ...stamp, cleanupEnabled: false }, target);
  }
  function renderStamp(stamp, target = canvas(WIDTH, HEIGHT)) {
    const margin = stamp.style?.safeMargin === 20 ? 20 : MARGIN;
    target.width = WIDTH;
    target.height = HEIGHT;
    const ctx = target.getContext("2d", { willReadFrequently: true });
    const { width, height } = stamp.original;
    const data = new ImageData(
      new Uint8ClampedArray(stamp.matteData || stamp.original.data),
      width,
      height,
    );
    for (let i = 0; i < stamp.mask.length; i++) {
      // Manual restore/erase owns the pixel once it differs from the auto mask.
      if(stamp.matteData && stamp.mask[i]!==stamp.autoMask?.[i])
        data.data.set(stamp.original.data.subarray(i*4,i*4+3),i*4);
      data.data[i * 4 + 3] = stamp.mask[i];
    }
    const layer = canvas(width, height);
    layer.getContext("2d").putImageData(data, 0, 0);
    const selectedCrop = stampCrop(stamp);
    const croppedLayer =
      selectedCrop.x ||
      selectedCrop.y ||
      selectedCrop.width !== width ||
      selectedCrop.height !== height
        ? isolateRect(layer, selectedCrop)
        : layer;
    if (root.StampTypography) {
      const T = root.StampTypography,
        base = baseImagePlacement(stamp);
      function drawArt(p) {
        const art = canvas(WIDTH, HEIGHT),
          context = art.getContext("2d"),
          crop = p.crop;
        context.save();
        context.beginPath();
        context.rect(margin, margin, WIDTH - margin * 2, HEIGHT - margin * 2);
        context.clip();
        context.drawImage(
          croppedLayer,
          0,
          0,
          croppedLayer.width,
          croppedLayer.height,
          p.offsetX + crop.x * p.ratio,
          p.offsetY + crop.y * p.ratio,
          crop.width * p.ratio,
          crop.height * p.ratio,
        );
        context.restore();
        return art;
      }
      const art = drawArt(base);
      let finalArt = art,
        plan = null,
        placement = base;
      if (stamp.caption.trim()) {
        if (stamp.activePlacement && stamp.renderTextPlan)
          plan = stamp.renderTextPlan;
        else {
          const result = T.compose(stamp.caption, stamp.style, art, (t) =>
            drawArt({
              ...base,
              ratio: base.ratio * t.scale,
              offsetX: base.offsetX * t.scale + t.x,
              offsetY: base.offsetY * t.scale + t.y,
            }),
          );
          finalArt = result.art;
          plan = result.plan;
          placement = {
            ...base,
            ratio: base.ratio * result.transform.scale,
            offsetX: base.offsetX * result.transform.scale + result.transform.x,
            offsetY: base.offsetY * result.transform.scale + result.transform.y,
          };
        }
      }
      ctx.drawImage(finalArt, 0, 0);
      const autoRemoved = clearAutomaticLines(ctx, stamp);
      if (plan) T.paintPlan(ctx, plan);
      stamp.renderTextPlan = plan;
      const bounds = alphaBounds(
        ctx.getImageData(0, 0, WIDTH, HEIGHT).data,
        WIDTH,
        HEIGHT,
      );
      if (croppedLayer !== layer) croppedLayer.width = croppedLayer.height = 1;
      layer.width = layer.height = art.width = art.height = 1;
      if (finalArt !== art) finalArt.width = finalArt.height = 1;
      return {
        canvas: target,
        bounds,
        empty: !bounds,
        textClipped: plan?.clipped || false,
        textOverlap: plan?.overlapPixels || 0,
        textAutoScaled: plan?.autoScaled || false,
        effectiveFontSize: plan?.style.size || stamp.style.size,
        imagePlacement: placement,
        textPlan: plan,
        autoRemoved,
      };
    }
    const p = baseImagePlacement(stamp),
      crop = p.crop;
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN, MARGIN, WIDTH - MARGIN * 2, HEIGHT - MARGIN * 2);
    ctx.clip();
    ctx.drawImage(
      croppedLayer,
      0,
      0,
      croppedLayer.width,
      croppedLayer.height,
      p.offsetX + crop.x * p.ratio,
      p.offsetY + crop.y * p.ratio,
      crop.width * p.ratio,
      crop.height * p.ratio,
    );
    ctx.restore();
    if (croppedLayer !== layer) croppedLayer.width = croppedLayer.height = 1;
    layer.width = layer.height = 1;
    const autoRemoved = clearAutomaticLines(ctx, stamp);
    let textClipped = false;
    if (stamp.caption.trim()) {
      const s = stamp.style,
        stroke = s.outline ? Math.max(3, s.size / 6) : 0;
      ctx.font = `700 ${s.size}px ${FONTS[s.font] || FONTS.sans}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      const x = (WIDTH * s.x) / 100,
        y = (HEIGHT * s.y) / 100;
      const maxWidth = Math.max(
        s.size,
        2 * Math.min(x - MARGIN - stroke, WIDTH - MARGIN - x - stroke),
      );
      const lines = wrapText(ctx, stamp.caption, maxWidth),
        lineHeight = s.size * 1.25;
      const firstY = y - ((lines.length - 1) * lineHeight) / 2;
      // Detect actual ink bounds, including strokes, before applying the mandatory transparent margin.
      for (let i = 0; i < lines.length; i++) {
        const m = ctx.measureText(lines[i]),
          cy = firstY + i * lineHeight;
        const left = x - (m.actualBoundingBoxLeft ?? m.width / 2) - stroke / 2;
        const right =
          x + (m.actualBoundingBoxRight ?? m.width / 2) + stroke / 2;
        const top = cy - (m.actualBoundingBoxAscent ?? s.size / 2) - stroke / 2;
        const bottom =
          cy + (m.actualBoundingBoxDescent ?? s.size / 2) + stroke / 2;
        if (
          left < MARGIN ||
          right > WIDTH - MARGIN ||
          top < MARGIN ||
          bottom > HEIGHT - MARGIN
        )
          textClipped = true;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(MARGIN, MARGIN, WIDTH - 2 * MARGIN, HEIGHT - 2 * MARGIN);
      ctx.clip();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = stroke;
      ctx.fillStyle = s.color;
      lines.forEach((line, i) => {
        if (s.outline) ctx.strokeText(line, x, firstY + i * lineHeight);
        ctx.fillText(line, x, firstY + i * lineHeight);
      });
      ctx.restore();
    }
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const bounds = alphaBounds(pixels.data, WIDTH, HEIGHT);
    return {
      canvas: target,
      textClipped,
      empty: !bounds,
      bounds,
      autoRemoved,
      imagePlacement: p,
    };
  }
  function specialImage(stamp, width, height) {
    const rendered = renderStamp(stamp),
      output = canvas(width, height),
      ctx = output.getContext("2d");
    const bounds = rendered.bounds;
    if (bounds) {
      const ratio = Math.min(
        (width - 20) / bounds.width,
        (height - 20) / bounds.height,
      );
      const w = Math.max(1, Math.round(bounds.width * ratio)),
        h = Math.max(1, Math.round(bounds.height * ratio));
      ctx.drawImage(
        rendered.canvas,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        Math.floor((width - w) / 2),
        Math.floor((height - h) / 2),
        w,
        h,
      );
    }
    rendered.canvas.width = rendered.canvas.height = 1;
    return output;
  }
  function pngBlob(c) {
    return new Promise((resolve, reject) =>
      c.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(
                new Error(
                  "PNGを作成できませんでした。画像サイズやメモリを確認してください。",
                ),
              ),
        "image/png",
      ),
    );
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function makeZip(files) {
    const chunks = [],
      central = [];
    let offset = 0;
    const encoder = new TextEncoder();
    for (const file of files) {
      const name = encoder.encode(file.name),
        bytes = new Uint8Array(await file.blob.arrayBuffer()),
        crc = crc32(bytes);
      const local = new Uint8Array(30 + name.length),
        v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x0800, true);
      v.setUint16(12, 0x0021, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, bytes.length, true);
      v.setUint32(22, bytes.length, true);
      v.setUint16(26, name.length, true);
      local.set(name, 30);
      const entry = new Uint8Array(46 + name.length),
        e = new DataView(entry.buffer);
      e.setUint32(0, 0x02014b50, true);
      e.setUint16(4, 20, true);
      e.setUint16(6, 20, true);
      e.setUint16(8, 0x0800, true);
      e.setUint16(14, 0x0021, true);
      e.setUint32(16, crc, true);
      e.setUint32(20, bytes.length, true);
      e.setUint32(24, bytes.length, true);
      e.setUint16(28, name.length, true);
      e.setUint32(42, offset, true);
      entry.set(name, 46);
      chunks.push(local, bytes);
      central.push(entry);
      offset += local.length + bytes.length;
    }
    const centralSize = central.reduce((sum, e) => sum + e.length, 0),
      end = new Uint8Array(22),
      e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true);
    e.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: "application/zip" });
  }
  const api = {
    WIDTH,
    HEIGHT,
    MARGIN,
    FONTS,
    canvas,
    backgroundColor,
    paintedCheckerboard,
    floodMask,
    exteriorWhiteMatte,
    proposeMatteCleanup,
    alphaBounds,
    createTile,
    isolateRect,
    tileRect,
    activeRowGrid,
    suggestRowGrid,
    suggestGridLines,
    suggestColumnRowLines,
    tileBoundaryReview,
    guideNumberCandidate,
    removeIsolatedGuideNumber,
    stampCrop,
    maskBounds,
    imagePlacement,
    applyBrush,
    renderBefore,
    renderStamp,
    renderUncleaned,
    specialImage,
    pngBlob,
    crc32,
    makeZip,
    wrapText,
  };
  root.StampCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
