/* Local phrase dictionary. No image classification is performed or implied. */
(function (root) {
  "use strict";
  const groups = {
    unknown: { label: "判定できず／未分類", phrases: [] },
    smile: {
      label: "笑顔・うれしい",
      phrases: [
        "ありがとう",
        "うれしい！",
        "やったー！",
        "いいね！",
        "大好き",
        "最高！",
        "楽しみ♪",
        "わーい！",
        "にこにこ",
        "またね",
      ],
    },
    cry: {
      label: "泣き顔・悲しい",
      phrases: [
        "ごめんね",
        "さみしい",
        "しょんぼり",
        "泣いちゃう",
        "つらいよ",
        "残念…",
        "会いたいな",
        "助けて〜",
        "ぐすん",
        "大丈夫かな",
      ],
    },
    angry: {
      label: "怒り顔・不満",
      phrases: [
        "ぷんぷん",
        "もう！",
        "ちょっと待って",
        "むむっ",
        "だめだよ",
        "困ったな",
        "聞いてよ〜",
        "えーっ",
        "納得できない",
        "がまん中",
      ],
    },
    surprised: {
      label: "驚き顔",
      phrases: [
        "びっくり！",
        "えっ！？",
        "ほんとに？",
        "まさか！",
        "すごい！",
        "なんと！",
        "そうなの？",
        "わあ！",
        "おおっ",
        "信じられない",
      ],
    },
    sleepy: {
      label: "眠そう・寝ている",
      phrases: [
        "おやすみ",
        "ねむい…",
        "すやすや",
        "また明日",
        "ひと休み",
        "お先に失礼",
        "もう寝ます",
        "のんびり中",
        "あと5分…",
        "おつかれさま",
      ],
    },
    greeting: {
      label: "あいさつ・返事",
      phrases: [
        "おはよう",
        "こんにちは",
        "こんばんは",
        "よろしくね",
        "了解です",
        "はーい",
        "ただいま",
        "いってきます",
        "いってらっしゃい",
        "おかえり",
      ],
    },
    support: {
      label: "応援・やさしい",
      phrases: [
        "応援してるよ",
        "無理しないでね",
        "だいじょうぶ",
        "ゆっくりでいいよ",
        "がんばって",
        "お大事に",
        "いつも感謝です",
        "よろしくお願いします",
        "お疲れさまです",
        "気をつけてね",
      ],
    },
  };
  Object.assign(groups, {
    wave: {
      label: "手を振る（見本照合）",
      phrases: [
        "やっほー！",
        "またね！",
        "はーい！",
        "おーい！",
        "こんにちは！",
        "よろしくね！",
      ],
    },
    bow: {
      label: "お辞儀（見本照合）",
      phrases: [
        "ありがとう",
        "よろしくお願いします",
        "感謝です",
        "お世話になります",
        "ありがとうございます",
        "どうもです",
      ],
    },
    approve: {
      label: "親指を立てる（見本照合）",
      phrases: [
        "いいね！",
        "OKです！",
        "ばっちり！",
        "了解です！",
        "まかせて！",
        "その調子！",
      ],
    },
    worried: {
      label: "困る（見本照合）",
      phrases: [
        "どうしよう…",
        "困ったな",
        "大丈夫かな",
        "うーん…",
        "助けて〜",
        "むずかしい…",
      ],
    },
    joy: {
      label: "喜ぶ（見本照合）",
      phrases: [
        "やったー！",
        "うれしい！",
        "わーい！",
        "最高！",
        "楽しみ！",
        "ばんざーい！",
      ],
    },
    love: {
      label: "ハート（見本照合）",
      phrases: [
        "大好き",
        "ありがとう♡",
        "だいすき！",
        "愛をこめて",
        "きゅん♡",
        "感謝の気持ち",
      ],
    },
  });
  function candidates(emotion) {
    return (groups[emotion] || groups.unknown).phrases.slice();
  }
  function choose(emotion, used = [], offset = 0) {
    const pool = candidates(emotion);
    if (!pool.length) return null;
    const occupied = new Set(used.map((text) => text.normalize("NFKC").trim()));
    const free = pool.filter(
      (text) => !occupied.has(text.normalize("NFKC").trim()),
    );
    const values = free.length ? free : pool;
    return values[((offset % values.length) + values.length) % values.length];
  }
  // Conservative visual cues, not a general expression/pose classifier.
  // Source pixels and the transparency mask are read only; no generated text is sampled.
  function analyze(image, mask) {
    const vision =
      root.StampCaptionVision ||
      (typeof module !== "undefined" ? require("./caption-vision.js") : null);
    const matched = vision?.match(image, mask);
    if (matched && matched.emotion !== "unknown") return matched;
    const { width: w, height: h, data } = image;
    const unknown = {
      emotion: "unknown",
      reason:
        matched?.reason ||
        "判定できず：利用できる画素見本がありません。汎用的な表情・ポーズ解析モデルは未実装です。",
    };
    if (!w || !h || data.length !== w * h * 4 || mask.length !== w * h)
      return unknown;
    const seen = new Uint8Array(w * h),
      regions = [];
    const blue = (i) =>
      mask[i] >= 96 &&
      data[i * 4 + 2] > 125 &&
      data[i * 4 + 2] - data[i * 4] > 35 &&
      data[i * 4 + 1] - data[i * 4] > 15;
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || !blue(i)) continue;
      const queue = [i];
      seen[i] = 1;
      let left = w,
        right = 0,
        top = h,
        bottom = 0;
      for (let q = 0; q < queue.length; q++) {
        const n = queue[q],
          x = n % w,
          y = Math.floor(n / w);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (const k of [
          x > 0 ? n - 1 : -1,
          x < w - 1 ? n + 1 : -1,
          y > 0 ? n - w : -1,
          y < h - 1 ? n + w : -1,
        ])
          if (k >= 0 && !seen[k] && blue(k)) {
            seen[k] = 1;
            queue.push(k);
          }
      }
      const rw = right - left + 1,
        rh = bottom - top + 1;
      if (
        queue.length >= Math.max(6, w * h * 0.00015) &&
        queue.length < w * h * 0.025 &&
        rh >= rw * 1.15 &&
        rh < h * 0.3 &&
        top > h * 0.2 &&
        bottom < h * 0.8
      )
        regions.push({ x: (left + right) / 2, y: (top + bottom) / 2 });
    }
    for (const a of regions)
      for (const b of regions)
        if (
          a.x < w * 0.5 &&
          b.x > w * 0.5 &&
          b.x - a.x > w * 0.15 &&
          b.x - a.x < w * 0.75 &&
          Math.abs(a.y - b.y) < h * 0.12
        )
          return {
            emotion: "cry",
            reason:
              "画素特徴：左右に小さな青系の縦長領域。涙の可能性（推測・要確認）",
          };
    return unknown;
  }
  // Explicit neutral fallback. When pixels are supplied, a stable pixel fingerprint selects the starting candidate.
  function automatic(rows) {
    const pool = [
      "了解です",
      "ありがとう",
      "確認します",
      "そうなんだ",
      "なるほど",
      "わかりました",
      "見ました",
      "助かります",
      "感謝です",
      "承知しました",
      "ありがとうね",
      "連絡ありがとう",
      "確認しました",
      "了解だよ",
      "そうですね",
      "なるほどね",
      "いつもありがとう",
      "助かるよ",
      "見てみます",
      "確認するね",
      "お知らせありがとう",
      "承知です",
      "わかったよ",
      "ありがとうございます",
      "なるほどです",
      "確認中です",
      "ありがとうです",
      "了解しました",
      "そうなんですね",
      "連絡感謝です",
      "受け取りました",
      "チェックします",
      "確認してみるね",
      "わかりました！",
      "感謝してます",
      "ありがとね",
      "見ておきます",
      "承知したよ",
      "連絡見ました",
      "受け取ったよ",
      "確認するよ",
      "どうもです",
      "見たよ",
      "お知らせ感謝です",
    ];
    const used = new Set(
      rows.map((row) => row.caption.normalize("NFKC").trim()).filter(Boolean),
    );
    return rows.map((row) => {
      if (row.caption.trim()) return { ...row };
      const vision =
        root.StampCaptionVision ||
        (typeof module !== "undefined" ? require("./caption-vision.js") : null);
      const offset =
        row.image && row.mask
          ? vision.fingerprint(row.image, row.mask) % pool.length
          : 0;
      const ordered = [...pool.slice(offset), ...pool.slice(0, offset)];
      const caption =
        ordered.find((text) => !used.has(text.normalize("NFKC").trim())) ||
        ordered[0];
      if (!caption) throw new Error("重複しない候補が不足しています。");
      used.add(caption.normalize("NFKC").trim());
      return { ...row, caption };
    });
  }
  function duplicates(rows) {
    const counts = new Map();
    for (const row of rows) {
      const key = row.caption.normalize("NFKC").trim();
      if (!key) continue;
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key).push(row.slot);
    }
    return [...counts.entries()]
      .filter(([, slots]) => slots.length > 1)
      .map(([caption, slots]) => ({ caption, slots }));
  }
  const api = { groups, candidates, choose, duplicates, automatic, analyze };
  root.StampSuggestions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
