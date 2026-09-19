(() => {
  'use strict';

  /* ══════════════════════════ CONFIG ══════════════════════════ */
  const CFG = {
    API_KEY: "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",
    API_URL: "https://api.groq.com/openai/v1/chat/completions",

    /* Reasoning-first models — always invoked with reasoning_effort=high */
    REASONERS: [
      "openai/gpt-oss-120b",
      "deepseek-r1-distill-llama-70b",
      "qwen/qwen3-32b",
    ],
    /* Cross-check generalists */
    GENERALISTS: [
      "moonshotai/kimi-k2-instruct-0905",
      "llama-3.3-70b-versatile",
    ],
    /* Independent verifier — runs after round 1 */
    VERIFIER: "openai/gpt-oss-120b",
    /* Adjudicator — only called if round-1 + verifier disagree hard */
    ADJUDICATOR: "deepseek-r1-distill-llama-70b",

    SELF_CONSISTENCY: 2,       // 2 samples per reasoner
    ENABLE_VERIFY:   true,
    ENABLE_ADJUDICATE: true,   // tie-break when models split
    TIMEOUT_MS:      40000,
    MAX_TOKENS:      1600,
    DEBOUNCE_MS:     500,
    POLL_MS:         2500,
    VERBOSE:         true,     // console only

    /* Answer strategy — always click something */
    ALWAYS_ANSWER:   true,
    SKIP_VISUAL:     false,    // attempt image questions too
  };

  const RANK   = { UNSURE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  const WEIGHT = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.25, UNSURE: 0.05 };
  const MODEL_W = {
    "openai/gpt-oss-120b":            1.40,
    "deepseek-r1-distill-llama-70b":  1.30,
    "qwen/qwen3-32b":                 1.20,
    "moonshotai/kimi-k2-instruct-0905": 1.10,
    "llama-3.3-70b-versatile":        1.00,
  };
  const mw = m => MODEL_W[m] ?? 1.0;

  const TAG = "[askGroq]";
  const log  = (...a) => CFG.VERBOSE && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  /* ══════════════════════════ TEARDOWN ══════════════════════════ */
  const NS = (window.__askGroq = window.__askGroq || {});
  try { NS.cleanup?.(); } catch {}
  NS.cleanup = () => {
    try { NS.observer?.disconnect(); } catch {}
    clearTimeout(NS.timer);
    clearInterval(NS.poll);
    try { NS.abort?.abort(); } catch {}
    document.getElementById("askGroqBar")?.remove();
    document.getElementById("askGroqHud")?.remove(); // legacy
  };
  NS.solved = new Set();
  NS.busy = false;
  NS.suppressUntil = 0;
  NS.stats = { ok: 0, calls: 0 };

  /* ══════════════════════════ DOM UTILS ══════════════════════════ */
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
  }
  function sameOriginDocs() {
    const out = [];
    for (const f of document.querySelectorAll("iframe")) {
      try { if (f.contentDocument) out.push(f.contentDocument); } catch {}
    }
    return out;
  }
  function commonAncestor(els) {
    if (!els.length) return null;
    let a = els[0];
    while (a && !els.every(e => a.contains(e))) a = a.parentElement;
    return a;
  }

  /* ══════════════════════════ UI (thin bar only) ══════════════════════════ */
  document.getElementById("askGroqHud")?.remove();
  const bar = document.createElement("div");
  bar.id = "askGroqBar";
  Object.assign(bar.style, {
    position: "fixed", top: "0", right: "0", width: "5px", height: "100vh",
    background: "linear-gradient(180deg,#4f8cff,#8b5cf6)",
    zIndex: "2147483647", cursor: "pointer", opacity: "0.5",
    transition: "opacity .15s",
  });
  bar.onmouseenter = () => (bar.style.opacity = "1");
  bar.onmouseleave = () => (bar.style.opacity = "0.5");
  bar.onclick = () => evaluate(true);
  document.body.appendChild(bar);

  /* ══════════════════════════ EXTRACTION ══════════════════════════ */
  const BLACK = /Mark for Review|Clear Response|Save\s*&\s*Next|Question Palette|Legend|Submit\s*(test|exam)|Instructions|Time Left|Total Questions|Max attempts|Calculator|Stu\.?\s*ID|Powered by|Copyright/i;

  function questionNumber() {
    const t = document.body.innerText || "";
    for (const p of [
      /Question\s*(?:No\.?|Number|#)?\s*[:\-]?\s*(\d{1,4})/i,
      /\bQ(?:uestion)?\.?\s*(\d{1,4})\b/i,
      /^\s*(\d{1,4})\s*[.)]\s/m,
    ]) { const m = t.match(p); if (m) return m[1]; }
    return "?";
  }

  function extractLabelText(input) {
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return clean(l.innerText);
    }
    const cl = input.closest("label");
    if (cl) return clean(cl.innerText);
    let p = input.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      if (p.querySelectorAll("input").length > 1) break;
      const t = clean(p.innerText);
      if (t.length > 1 && t.length < 500) return t;
    }
    return clean(input.value);
  }

  function buildOptions(els, kind) {
    const seen = new Set(), options = [];
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      let raw = kind === "role" ? clean(el.innerText) : extractLabelText(el);
      if (!raw) continue;
      raw = raw.replace(/^\s*[\(\[]?([A-Ha-h])[\)\].:\-]\s*/, "");
      const letter = String.fromCharCode(65 + options.length);
      options.push({ letter, text: `${letter}) ${raw}`, el, kind });
    }
    return options.length >= 2 ? { type: "MCQ", options } : { type: "UNKNOWN", options: [] };
  }

  function detectOptions(root = document) {
    // radio
    let inputs = [...root.querySelectorAll("input[type=radio]")].filter(isVisible);
    if (inputs.length >= 2) {
      const groups = new Map();
      for (const i of inputs) {
        const k = i.name || "__noname";
        (groups.get(k) || groups.set(k, []).get(k)).push(i);
      }
      let best = null;
      for (const g of groups.values()) {
        if (g.length >= 2 && g.length <= 8 && (!best || g.length > best.length)) best = g;
      }
      if (best) return buildOptions(best, "radio");
    }
    // checkbox
    inputs = [...root.querySelectorAll("input[type=checkbox]")].filter(isVisible);
    if (inputs.length >= 2 && inputs.length <= 8) return buildOptions(inputs, "checkbox");
    // ARIA radio
    const roleRadios = [...root.querySelectorAll('[role="radio"],[role="option"]')].filter(isVisible);
    if (roleRadios.length >= 2 && roleRadios.length <= 8) return buildOptions(roleRadios, "role");
    return { type: "UNKNOWN", options: [] };
  }

  function detectTextInput(root = document) {
    const cands = [...root.querySelectorAll(
      "input[type=text],input[type=number],input[type=search],input:not([type]),textarea"
    )].filter(isVisible);
    const best = cands.find(el => !el.readOnly && !el.disabled);
    return best ? { type: "TEXT", el: best } : null;
  }

  function findQuestionText(optionEls) {
    let region = commonAncestor(optionEls);
    for (let i = 0; i < 8 && region?.parentElement; i++) region = region.parentElement;
    if (!region || region === document.documentElement) region = document.body;

    const cands = [];
    const scan = (root) => {
      root.querySelectorAll("div,p,section,article,main,td,li").forEach(el => {
        if (!isVisible(el)) return;
        if (optionEls.some(o => el === o || el.contains(o))) return;
        const t = clean(el.innerText);
        if (t.length < 30 || t.length > 6000) return;
        if (BLACK.test(t)) return;
        if (el.querySelectorAll("input,textarea,button,select").length > 8) return;
        cands.push({ el, text: t, len: t.length });
      });
    };
    scan(region);
    if (cands.length < 3) { cands.length = 0; scan(document); }
    if (!cands.length) return "";

    const score = c => {
      let s = 0;
      const L = c.len;
      if (L >= 80 && L <= 2000) s += 200;
      else if (L < 80)          s += 40;
      s += Math.min(L, 900) * 0.15;
      if (/\?/.test(c.text)) s += 25;
      if (/\b(what|which|how many|how much|find|calculate|determine|value|answer|total|ratio|probability)\b/i.test(c.text)) s += 18;
      s -= (c.text.match(/\b[A-D]\)/g) || []).length * 35;
      s -= (c.text.match(/\b(True|False)\b/g) || []).length * 10;
      return s;
    };
    cands.sort((a, b) => score(b) - score(a));
    return cands[0].text
      .replace(/^Question\s*(?:No\.?|Number|#)?\s*[:\-]?\s*\d+\s*[:.\-]?\s*/i, "")
      .trim();
  }

  /* ══════════════════════════ PROMPTS ══════════════════════════ */
  const SYS_SOLVE =
`You are the strongest analytical solver in the world. You handle ANY subject:
quantitative aptitude, logical reasoning, verbal, GK, computer science, general
science — anything. You do not need to know the exam syllabus; you solve the
exact question shown.

STRICT METHOD:
1. Read the question and every option carefully.
2. Identify what is being asked (single best answer).
3. Work it out step-by-step. Show the reasoning numerically or logically.
4. Eliminate options that contradict the reasoning.
5. Choose exactly one option letter.

You MUST always choose a letter. Never leave the answer blank. If unsure,
pick your single best guess — an attempt is mandatory.

Output format — end your reply with EXACTLY these two lines and nothing after:
CONFIDENCE: HIGH | MEDIUM | LOW | UNSURE
ANSWER: <A|B|C|D>

Where CONFIDENCE:
- HIGH   = logically certain
- MEDIUM = very confident
- LOW    = best guess
- UNSURE = pure fallback`;

  const SYS_VERIFY =
`You are a strict independent examiner. You will be shown a question, its options,
and a proposed answer from another model.

Your job: re-derive the answer from scratch. Do NOT assume the proposed answer
is correct — verify by your own reasoning. If the proposal is wrong, pick the
correct letter. You MUST output a letter.

End with EXACTLY:
CONFIDENCE: HIGH | MEDIUM | LOW | UNSURE
ANSWER: <A|B|C|D>`;

  const SYS_ADJUDICATE =
`Two experts disagree on the answer to the question below. You are the final
adjudicator. Re-derive the answer independently and pick the correct option.

End with EXACTLY:
CONFIDENCE: HIGH | MEDIUM | LOW | UNSURE
ANSWER: <A|B|C|D>`;

  const SYS_FILL =
`Solve the question and return ONLY the final answer value on the last line,
prefixed with "ANSWER: ". No units, no extra words, just the value.
Then, on the line before it, write "CONFIDENCE: HIGH | MEDIUM | LOW | UNSURE".`;

  /* ══════════════════════════ GROQ API ══════════════════════════ */
  function parseMCQ(blob) {
    if (!blob) return { conf: "UNSURE", letter: null };
    const cm = blob.match(/CONFIDENCE\s*[:\-]\s*(HIGH|MEDIUM|LOW|UNSURE)/i);
    const conf = cm ? cm[1].toUpperCase() : "UNSURE";

    const pats = [
      /\bFINAL\s+ANSWER\s*[:\-]?\s*\(?([A-E])\)?/i,
      /\bANSWER\s*(?:IS)?\s*[:\-]?\s*\(?([A-E])\)?\b/i,
      /\\boxed\{\s*\(?([A-E])\)?\s*\}/i,
      /^\s*\(?([A-E])\)?\s*[.):]?\s*$/m,
      /\boption\s*\(?([A-E])\)?\b/i,
    ];
    let letter = null;
    for (const p of pats) { const m = blob.match(p); if (m) { letter = m[1].toUpperCase(); break; } }
    return { conf, letter };
  }

  function parseFill(blob) {
    if (!blob) return { conf: "UNSURE", value: null };
    const cm = blob.match(/CONFIDENCE\s*[:\-]\s*(HIGH|MEDIUM|LOW|UNSURE)/i);
    const conf = cm ? cm[1].toUpperCase() : "UNSURE";
    let value = null;
    const m = blob.match(/ANSWER\s*[:\-]\s*(.+?)(?:\n|$)/i);
    if (m) value = m[1].replace(/[`"'*]/g, "").trim();
    if (!value) {
      const lastLine = blob.trim().split("\n").pop()?.trim();
      if (lastLine && lastLine.length < 200) value = lastLine.replace(/[`"'*]/g, "");
    }
    return { conf, value };
  }

  async function callModel(model, sysMsg, userMsg, signal, reasoningHigh = false) {
    const body = {
      model,
      temperature: 0,
      max_tokens: CFG.MAX_TOKENS,
      messages: [
        { role: "system", content: sysMsg },
        { role: "user",   content: userMsg },
      ],
    };
    if (reasoningHigh || /gpt-oss|deepseek-r1|qwen3/i.test(model)) {
      body.reasoning_effort = "high";
    }

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), CFG.TIMEOUT_MS);

    try {
      const res = await fetch(CFG.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.API_KEY },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${t.slice(0, 140)}`);
      }
      const json = await res.json();
      const msg = json.choices?.[0]?.message || {};
      const content   = (msg.content   || "").trim();
      const reasoning = (msg.reasoning || "").trim();
      NS.stats.calls++;
      return { model, blob: content + "\n" + reasoning, raw: content || reasoning };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /* ══════════════════════════ DECISION ══════════════════════════ */
  function tallyMCQ(results) {
    const map = new Map();
    for (const r of results) {
      if (!r.letter) continue;
      const rk = RANK[r.conf] ?? 0;
      const w  = WEIGHT[r.conf] * mw(r.model);
      const cur = map.get(r.letter) || { letter: r.letter, score: 0, votes: 0, best: 0, models: [] };
      cur.score += w;
      cur.votes += 1;
      cur.best   = Math.max(cur.best, rk);
      cur.models.push(`${r.model.replace(/[^/]+\//, "")}:${r.conf}`);
      map.set(r.letter, cur);
    }
    return [...map.values()].sort((a, b) => b.score - a.score || b.best - a.best);
  }

  function tallyFill(results) {
    const norm = s => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
    const map = new Map();
    for (const r of results) {
      if (!r.value) continue;
      const key = norm(r.value);
      const w   = WEIGHT[r.conf] * mw(r.model);
      const cur = map.get(key) || { key, value: r.value, score: 0, votes: 0, best: 0 };
      cur.score += w;
      cur.votes += 1;
      cur.best   = Math.max(cur.best, RANK[r.conf] ?? 0);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.score - a.score || b.best - a.best);
  }

  /* ══════════════════════════ CLICKING / FILLING ══════════════════════════ */
  function clickOption(opt) {
    const el = opt.el;
    try { el.click(); } catch {}
    if (opt.kind !== "role" && !el.checked) {
      const label = el.id
        ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        : el.closest("label");
      try { label?.click(); } catch {}
    }
    if (opt.kind !== "role" && !el.checked) {
      for (const type of ["mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return opt.kind === "role" ? true : !!el.checked;
  }

  function fillText(input, value) {
    if (!input || value == null) return false;
    input.focus();
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try { setter?.call(input, value); } catch { input.value = value; }
    for (const type of ["input", "change", "blur"]) {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    }
    return true;
  }

  /* ══════════════════════════ PIPELINE ══════════════════════════ */
  function userMsgMCQ(qn, question, options) {
    return `Question ${qn}:\n${question}\n\nOptions:\n${options.map(o => o.text).join("\n")}`;
  }
  function userMsgFill(qn, question) {
    return `Question ${qn}:\n${question}\n\nReturn the final answer value.`;
  }

  async function phaseSolve(sysMsg, userMsg, signal) {
    const jobs = [];
    for (const m of CFG.REASONERS) {
      jobs.push(callModel(m, sysMsg, userMsg, signal, true));
      for (let i = 1; i < CFG.SELF_CONSISTENCY; i++) {
        jobs.push(callModel(m, sysMsg, userMsg, signal, true));
      }
    }
    for (const m of CFG.GENERALISTS) {
      jobs.push(callModel(m, sysMsg, userMsg, signal));
    }
    const settled = await Promise.allSettled(jobs);
    return settled.filter(r => r.status === "fulfilled").map(r => r.value);
  }

  async function phaseVerify(sysMsg, userMsg, signal) {
    try { return await callModel(CFG.VERIFIER, sysMsg, userMsg, signal, true); }
    catch (e) { if (e?.name !== "AbortError") warn("verify:", e.message); return null; }
  }

  async function phaseAdjudicate(sysMsg, userMsg, signal) {
    try { return await callModel(CFG.ADJUDICATOR, sysMsg, userMsg, signal, true); }
    catch (e) { if (e?.name !== "AbortError") warn("adjudicate:", e.message); return null; }
  }

  /* ══════════════════════════ MAIN EVALUATE ══════════════════════════ */
  async function evaluate(force = false) {
    if (NS.busy) return;

    /* ---- Locate answer area (MCQ first, then text) ---- */
    let area = detectOptions(document);
    let textArea = null;
    if (area.type !== "MCQ") {
      for (const d of sameOriginDocs()) {
        const a = detectOptions(d);
        if (a.type === "MCQ") { area = a; break; }
      }
    }
    if (area.type !== "MCQ") {
      textArea = detectTextInput(document);
      if (!textArea) {
        for (const d of sameOriginDocs()) {
          const t = detectTextInput(d);
          if (t) { textArea = t; break; }
        }
      }
    }

    const isMCQ = area.type === "MCQ" && area.options.length >= 2;
    const isFill = !isMCQ && !!textArea;
    if (!isMCQ && !isFill) return;

    const optionEls = isMCQ ? area.options.map(o => o.el) : [textArea.el];
    const qn = questionNumber();
    const qText = findQuestionText(optionEls);
    if (!qText) return;

    const sig = `${qn}|${qText.slice(0, 180)}|${isMCQ ? area.options.length : "F"}`;
    if (!force && NS.solved.has(sig)) return;

    NS.busy = true;
    log(`Q${qn} solving (${isMCQ ? "MCQ" : "FILL"})…`);
    NS.abort?.abort();
    const roundAbort = (NS.abort = new AbortController());

    try {
      if (isMCQ) {
        await solveMCQ(qn, qText, area.options, roundAbort.signal, sig);
      } else {
        await solveFill(qn, qText, textArea.el, roundAbort.signal, sig);
      }
    } catch (e) {
      if (e?.name !== "AbortError") warn(e);
    } finally {
      NS.busy = false;
    }
  }

  async function solveMCQ(qn, qText, options, signal, sig) {
    const userMsg = userMsgMCQ(qn, qText, options);

    /* Round 1 — ensemble */
    const raw = await phaseSolve(SYS_SOLVE, userMsg, signal);
    if (signal.aborted) return;
    const results = raw.map(r => ({ model: r.model, ...parseMCQ(r.blob) }));
    results.forEach(r => log(`Q${qn} · ${r.model} → ${r.letter ?? "?"} (${r.conf})`));

    const ranked = tallyMCQ(results);
    log(`Q${qn} tally:`, ranked.slice(0,4).map(x => `${x.letter}:${x.votes}(${x.score.toFixed(2)})`).join("  "));
    let winner = ranked[0];

    /* Round 2 — verifier on the current top */
    if (CFG.ENABLE_VERIFY && winner) {
      const vMsg =
        `Question ${qn}:\n${qText}\n\nOptions:\n${options.map(o => o.text).join("\n")}\n\n` +
        `Proposed answer: ${winner.letter}\nRe-derive and confirm or correct.`;
      const vRaw = await phaseVerify(SYS_VERIFY, vMsg, signal);
      if (vRaw) {
        const v = parseMCQ(vRaw.blob);
        log(`Q${qn} verify → ${v.letter} (${v.conf})`);
        if (v.letter && RANK[v.conf] >= RANK.MEDIUM) {
          if (v.letter === winner.letter) {
            winner = { ...winner, reason: "verified", verifier: v };
          } else if (RANK[v.conf] >= RANK.HIGH) {
            const alt = ranked.find(r => r.letter === v.letter);
            winner = alt
              ? { ...alt, reason: "verifier-override" }
              : { letter: v.letter, votes: 1, score: 1.0, best: RANK.HIGH, models: ["verifier"], reason: "verifier-override" };
          }
        }
      }
    }

    /* Round 3 — adjudicate only if the top two are extremely close */
    if (CFG.ENABLE_ADJUDICATE && ranked.length >= 2) {
      const [a, b] = ranked;
      const close = (a.score - b.score) < 0.35 && a.letter !== b.letter;
      if (close) {
        const adjMsg =
          `Question ${qn}:\n${qText}\n\nOptions:\n${options.map(o => o.text).join("\n")}\n\n` +
          `Model A picked ${a.letter}, Model B picked ${b.letter}. Decide.`;
        const adjRaw = await phaseAdjudicate(SYS_ADJUDICATE, adjMsg, signal);
        if (adjRaw) {
          const adj = parseMCQ(adjRaw.blob);
          log(`Q${qn} adjudicate → ${adj.letter} (${adj.conf})`);
          if (adj.letter) {
            const target = ranked.find(r => r.letter === adj.letter);
            winner = target
              ? { ...target, reason: "adjudicated" }
              : { letter: adj.letter, votes: 1, score: 1.0, best: RANK[adj.conf], models: ["adjudicator"], reason: "adjudicated" };
          }
        }
      }
    }

    /* Guaranteed click */
    if (!winner && CFG.ALWAYS_ANSWER) {
      if (ranked.length) {
        winner = { ...ranked[0], reason: "best-effort" };
      } else {
        const rnd = options[Math.floor(Math.random() * options.length)];
        winner = { letter: rnd.letter, votes: 0, score: 0, best: 0, models: ["random"], reason: "random" };
      }
    }
    if (!winner) return;

    const opt = options.find(o => o.letter === winner.letter);
    if (!opt) { log(`Q${qn}: option ${winner.letter} not found`); return; }

    const ok = clickOption(opt);
    NS.solved.add(sig);
    NS.stats.ok++;
    NS.suppressUntil = Date.now() + 1500;
    log(`Q${qn} → ${winner.letter} ${ok ? "✓" : "⚠"} (${winner.reason})  · solved=${NS.stats.ok} calls=${NS.stats.calls}`);
  }

  async function solveFill(qn, qText, inputEl, signal, sig) {
    const userMsg = userMsgFill(qn, qText);
    const raw = await phaseSolve(SYS_FILL, userMsg, signal);
    if (signal.aborted) return;
    const results = raw.map(r => ({ model: r.model, ...parseFill(r.blob) }));
    results.forEach(r => log(`Q${qn} · ${r.model} → "${r.value}" (${r.conf})`));

    const ranked = tallyFill(results);
    if (!ranked.length) {
      log(`Q${qn} fill: no answers`);
      return;
    }
    const winner = ranked[0];
    const ok = fillText(inputEl, winner.value);
    NS.solved.add(sig);
    NS.stats.ok++;
    NS.suppressUntil = Date.now() + 1200;
    log(`Q${qn} fill → "${winner.value}" ${ok ? "✓" : "⚠"} (score=${winner.score.toFixed(2)})`);
  }

  /* ══════════════════════════ WATCHERS ══════════════════════════ */
  const schedule = () => {
    if (Date.now() < NS.suppressUntil) return;
    clearTimeout(NS.timer);
    NS.timer = setTimeout(() => evaluate(false), CFG.DEBOUNCE_MS);
  };

  NS.observer = new MutationObserver(schedule);
  NS.observer.observe(document.body, { childList: true, subtree: true });
  NS.poll = setInterval(() => evaluate(false), CFG.POLL_MS);

  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      evaluate(true);
    }
  });

  setTimeout(schedule, 700);

  log(`ready · MCQ+FILL · ensemble=${CFG.REASONERS.length + CFG.GENERALISTS.length} models · Ctrl+Shift+G to force`);
})();