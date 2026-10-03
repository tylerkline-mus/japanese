// demo.js — fake WaniKani data in the real API shape, for previewing with ?demo
// (no token needed). Nothing here is your real data.

const KANJI =
  "一二三四五六七八九十人口大小山川上下中日月火水木金土本入出力手目田子女千夕正生白百右左休先名字早学気見車赤青森林空雨町村天音花草竹糸貝石耳足犬虫王玉円年文校立男西東北南方前後午半外国話語言読書聞食飲行来帰会社員店買売道歩走止紙米肉魚鳥牛馬羊色黄黒茶春夏秋冬朝昼夜晩毎週曜今何時分間長高安新古多少強弱遠近明暗太細広楽歌作家内外理科同計画工場電話雪晴風光切元首心思考知自分体頭顔声多少教室堂堂所者主住地池通遊旅館病院医薬予定約族親兄弟姉妹父母友";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function demoRaw(now = new Date()) {
  const r = rng(42);
  const day = 86400000;
  const iso = (t) => new Date(t).toISOString();
  const level = 10;
  const kanjiChars = [...new Set([...KANJI])].slice(0, 290);
  const kanjiSubjects = kanjiChars.map((ch, i) => ({
    id: 1000 + i,
    object: "kanji",
    data: {
      characters: ch,
      level: Math.min(level, 1 + Math.floor(i / 29)),
      meanings: [{ meaning: "demo meaning", primary: true }],
      readings: [{ reading: "でも", primary: true, type: "onyomi" }],
      document_url: "https://www.wanikani.com/kanji/" + encodeURIComponent(ch),
    },
  }));

  const assignments = [];
  const stats = [];
  let id = 1;
  const push = (subject_id, subject_type, lvl) => {
    const age = level - lvl;
    let stage = age >= 6 ? 5 + Math.floor(r() * 5) : age >= 3 ? 3 + Math.floor(r() * 5) : 1 + Math.floor(r() * 5);
    stage = Math.min(9, stage);
    const overdue = stage < 9 && r() < 0.88;
    const available_at = stage === 9 ? null : iso(overdue ? now.getTime() - r() * 30 * day : now.getTime() + r() * 7 * day);
    assignments.push({ id: id++, data: { subject_id, subject_type, srs_stage: stage, available_at, unlocked_at: iso(now - 200 * day) } });
    const mi = Math.floor(r() * r() * 9);
    const ri = subject_type === "radical" ? 0 : Math.floor(r() * r() * 11);
    stats.push({
      data_updated_at: iso(r() < 0.06 ? now.getTime() - r() * 3600000 : now.getTime() - (1 + r() * 20) * day),
      data: {
        subject_id,
        subject_type,
        meaning_correct: 4 + Math.floor(r() * 14),
        meaning_incorrect: mi,
        reading_correct: subject_type === "radical" ? 0 : 3 + Math.floor(r() * 14),
        reading_incorrect: ri,
        meaning_current_streak: 1 + Math.floor(r() * 5),
        reading_current_streak: subject_type === "radical" ? 1 : 1 + Math.floor(r() * 5),
        percentage_correct: 70 + Math.floor(r() * 30),
      },
    });
  };
  for (let i = 0; i < 150; i++) push(5000 + i, "radical", 1 + Math.floor(i / 15));
  kanjiSubjects.forEach((k) => push(k.id, "kanji", k.data.level));
  for (let i = 0; i < 820; i++) push(9000 + i, "vocabulary", 1 + Math.floor(i / 82));

  // Force the queue to the real-world number from the conversation.
  const availNow = assignments.filter((a) => a.data.available_at && Date.parse(a.data.available_at) <= now.getTime());
  const ids = availNow.slice(0, 976).map((a) => a.data.subject_id);
  const summary = {
    data: {
      lessons: [{ available_at: iso(now - 3600000), subject_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }],
      reviews: [{ available_at: iso(now - 3600000), subject_ids: ids }],
    },
  };

  const levels = [];
  let t = now.getTime() - 420 * day;
  const spans = [9, 8, 11, 10, 12, 14, 9, 13, 21];
  for (let l = 1; l <= level; l++) {
    const started = t;
    const passed = l < level ? t + spans[l - 1] * day : null;
    levels.push({ data: { level: l, unlocked_at: iso(started), started_at: iso(started), passed_at: passed ? iso(passed) : null } });
    if (passed) t = passed;
  }
  // a long break before the current level
  levels[level - 1].data.started_at = iso(now.getTime() - 160 * day);
  levels[level - 1].data.unlocked_at = levels[level - 1].data.started_at;

  const user = { data: { username: "demo", level } };
  const leechSubjects = [];
  return { user, summary, assignments, stats, levels, kanjiSubjects, leechSubjects, demo: true };
}

export function demoHistory(now = new Date()) {
  const rows = [];
  const day = 86400000;
  let q = 1160;
  let correct = 21000;
  let incorrect = 4400;
  const r = rng(7);
  for (let i = 20; i >= 1; i--) {
    const d = new Date(now.getTime() - i * day);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const skipped = r() < 0.18;
    const done = skipped ? 0 : 40 + Math.floor(r() * 70);
    q = Math.max(120, q + (skipped ? 30 : -Math.floor(done * 0.14)));
    correct += Math.floor(done * 0.8);
    incorrect += Math.floor(done * 0.2);
    rows.push({ date: key, level: 10, queue: q, lessons: 12, correct, incorrect, reviewedToday: done });
  }
  return rows;
}
