/**
 * components/coach.js  (Vanilla JS)
 *
 * Drop-in Coach Tab + Coach Teaser (no npm, no build).
 * Attaches to window.Coach.
 *
 * You provide:
 *   - getCoachInput(): returns CoachInput (can be dummy first)
 * Optional:
 *   - onOpenCoach(): callback when teaser clicked
 *
 * Usage (in app.js):
 *   Coach.mountTeaser({ mountId: "coach-teaser", getInput: getCoachInput, onOpenCoach: () => showTab("coach") });
 *   Coach.mountTab({ mountId: "tab-coach", getInput: getCoachInput });
 */

(function () {
  // ---------- Style injection (keeps your project simple) ----------
  const STYLE_ID = "coach-style-v1";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      .coach-wrap{max-width:980px;margin:0 auto;padding:18px;display:flex;flex-direction:column;gap:12px}
      .coach-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
      .coach-title{margin:0;font-size:18px;font-weight:700}
      .coach-sub{margin-top:4px;font-size:13px;opacity:.7}
      .coach-card{
  border:1px solid rgba(255,255,255,0.12);
  border-radius:16px;
  padding:16px;
  background:linear-gradient(
    180deg,
    rgba(20,25,35,0.85),
    rgba(10,14,22,0.85)
  );
  backdrop-filter: blur(10px);
  color: #e5e7eb;
}
      .coach-card-title{
  font-size:12px;
  letter-spacing:.04em;
  text-transform:uppercase;
  color:#9ca3af;
}
      .coach-chiprow{display:flex;flex-wrap:wrap;gap:8px}
      .coach-chip{
  background:rgba(255,255,255,0.08);
  border:1px solid rgba(255,255,255,0.14);
  color:#e5e7eb;
}
      .coach-chip-label{opacity:.65;font-size:12px}
      .coach-chip-value{font-weight:600}
      .coach-grid2{display:grid;grid-template-columns:1fr;gap:12px}
      .coach-grid3{display:grid;grid-template-columns:1fr;gap:12px}
      @media(min-width:880px){.coach-grid2{grid-template-columns:1fr 1fr}.coach-grid3{grid-template-columns:1fr 1fr 1fr}}
      .coach-ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}
      .coach-li{
  font-size:14px;
  line-height:1.45;
  color:#e5e7eb;
}
      .coach-empty{font-size:14px;opacity:.7}
      .coach-tone{display:inline-flex;border:1px solid rgba(0,0,0,.12);border-radius:999px;overflow:hidden;background:rgba(255,255,255,.8)}
      .coach-tone button{padding:8px 10px;font-size:12px;cursor:pointer;border:none;background:transparent}
      .coach-tone button.active{background:rgba(0,0,0,.06)}
      .coach-teaser{
  background:linear-gradient(
    180deg,
    rgba(20,25,35,0.75),
    rgba(10,14,22,0.75)
  );
  border:1px solid rgba(255,255,255,0.12);
  color:#e5e7eb;
}
      .coach-teaser[role="button"]{cursor:pointer}
      .coach-teaser-title{font-size:12px;opacity:.7}
      .coach-teaser-summary{font-size:13px;line-height:1.25}
      .coach-pill{font-size:12px;padding:6px 10px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.9);white-space:nowrap}
      .coach-debug{font-size:13px;opacity:.75;margin-bottom:8px}
    `;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ---------- Copy (tone system) ----------
  const COPIES = {
    mild: {
      summary: {
        noClear: "Geen duidelijke afwijkingen in gedrag. Rustig en consistent.",
        behaviorOverResult: (s) => `Let op: ${s} — klein bijsturen kan veel schelen.`,
      },
      labels: {
        disciplineGood: "Discipline: stabiel",
        disciplineOkay: "Discipline: redelijk",
        disciplineOff: "Discipline: afwijkend",
      },
      focus: {
        cooldown: (m) => `Na een verlies: ${m} min pauze (even resetten).`,
        maxTrades: (n) => `Max ${n} trades vandaag — kwaliteit boven kwantiteit.`,
        sizeLock: "Houd je positie-size gelijk aan je baseline (niet opschalen in drawdown).",
        neutral: "Focus: voer je plan rustig en consistent uit (geen extra regels nodig vandaag).",
      },
      patterns: {
        afterLoss:
          "Na een verlies zakt je performance vaker weg. Een korte pauze kan dit doorbreken.",
        overtradeRecurring:
          "Je trade-intensiteit piekt vaker op vergelijkbare dagen. Een trade-budget helpt.",
      },
    },
    neutral: {
      summary: {
        noClear: "Geen duidelijke gedragsafwijkingen. Consistent uitgevoerd.",
        behaviorOverResult: (s) => `Dominant thema: ${s}.`,
      },
      labels: {
        disciplineGood: "Discipline: goed",
        disciplineOkay: "Discipline: matig",
        disciplineOff: "Discipline: afwijkend",
      },
      focus: {
        cooldown: (m) => `Na een verlies: ${m} min cooldown.`,
        maxTrades: (n) => `Max ${n} trades vandaag.`,
        sizeLock: "Geen opschalen van size tijdens drawdown.",
        neutral: "Focus: voer je plan rustig en consistent uit (geen extra regels nodig vandaag).",
      },
      patterns: {
        afterLoss:
          "Na een verlies is je volgende serie trades structureel zwakker dan je baseline.",
        overtradeRecurring:
          "Overtrading komt vaker terug in je data. Een vaste limiet voorkomt ruis-trades.",
      },
    },
    confronting: {
      summary: {
        noClear: "Geen opvallende fouten. Hou dit vast.",
        behaviorOverResult: (s) => `Dit kost je: ${s}. Stop ermee.`,
      },
      labels: {
        disciplineGood: "Discipline: strak",
        disciplineOkay: "Discipline: slap",
        disciplineOff: "Discipline: uit de bocht",
      },
      focus: {
        cooldown: (m) => `Na verlies: ${m} min weg van het scherm. Punt.`,
        maxTrades: (n) => `Meer dan ${n} trades = impuls. Stop op ${n}.`,
        sizeLock: "Size omhoog in drawdown = tilt. Niet doen.",
        neutral: "Focus: voer je plan rustig en consistent uit.",
      },
      patterns: {
        afterLoss:
          "Je maakt je dag kapot na een verlies. Neem pauze, anders blijf je betalen.",
        overtradeRecurring:
          "Je overtrade’t. Limiet instellen en eraan houden.",
      },
    },
  };

  function getCopy(tone) {
    return COPIES[tone] || COPIES.neutral;
  }

  function pickSummaryTheme(signals) {
    const high = signals.find((s) => s.severity === "high");
    const warn = signals.find((s) => s.severity === "warn");
    const pick = high || warn || signals[0];
    if (!pick) return null;
    switch (pick.kind) {
      case "revenge":
        return "gedrag na verlies (revenge/impuls)";
      case "overtrading":
        return "te veel trades (overtrading)";
      case "tilt":
        return "tilt/drawdown-gedrag";
      case "lowRest":
        return "te weinig rust tussen trades";
      case "sizeUp":
        return "positie-size hoger dan baseline";
      case "flipChop":
        return "flippen/overmatig wisselen van bias";
      default:
        return null;
    }
  }

  // ---------- Signals (heuristics) ----------
  function detectSignals(input) {
    const s = [];
    const b = (input && input.behavior) || {};
    const base = (input && input.baselines30d) || null;
    const seq = (input && input.sequences) || null;

    // Overtrading
    if (base && base.tradesPerDayMedian != null && base.tradesPerDayIQR != null) {
      const over = b.trades > base.tradesPerDayMedian + 1.5 * base.tradesPerDayIQR;
      if (over) {
        s.push({
          kind: "overtrading",
          severity:
            b.trades > base.tradesPerDayMedian + 2.5 * base.tradesPerDayIQR ? "high" : "warn",
          reason: `trades ${b.trades} vs baseline median ${base.tradesPerDayMedian}`,
        });
      }
    } else if (b.trades >= 20) {
      s.push({ kind: "overtrading", severity: "warn", reason: "trades >= 20 (fallback)" });
    }

    // Low rest
    if (b.medianMinutesBetweenTrades != null && base && base.medianMinutesBetweenTrades != null) {
      if (b.medianMinutesBetweenTrades < base.medianMinutesBetweenTrades * 0.6) {
        s.push({ kind: "lowRest", severity: "warn", reason: "rest dropped vs baseline" });
      }
    } else if (b.medianMinutesBetweenTrades != null && b.medianMinutesBetweenTrades < 6) {
      s.push({ kind: "lowRest", severity: "warn", reason: "median rest < 6m (fallback)" });
    }

    // Size up
    if (b.sizeVsBaselinePct != null && b.sizeVsBaselinePct >= 25) {
      s.push({
        kind: "sizeUp",
        severity: b.sizeVsBaselinePct >= 50 ? "high" : "warn",
        reason: `size +${b.sizeVsBaselinePct}%`,
      });
    }

    // Revenge
    if (seq && seq.firstLossTimeISO && seq.afterLossTrades != null) {
      const afterLossMany = seq.afterLossTrades >= 4;
      const afterLossSizeUp = (seq.afterLossSizeVsBaselinePct || 0) >= 20;
      if (afterLossMany && afterLossSizeUp) {
        s.push({ kind: "revenge", severity: "high", reason: "after-loss trades high + size up" });
      } else if (afterLossMany) {
        s.push({ kind: "revenge", severity: "warn", reason: "after-loss trade count high" });
      }
    }

    // Tilt
    const ls = seq ? (seq.lossStreakMax || 0) : 0;
    if (ls >= 4) s.push({ kind: "tilt", severity: "high", reason: "loss streak >= 4" });
    else if (ls === 3) s.push({ kind: "tilt", severity: "warn", reason: "loss streak == 3" });

    const flips = seq ? (seq.flipCountSameSymbol || 0) : 0;
    if (flips >= 3) s.push({ kind: "flipChop", severity: "warn", reason: "flip count >= 3" });

    if (s.length === 0) s.push({ kind: "noClear", severity: "info", reason: "no clear signals" });

    const rank = { high: 0, warn: 1, info: 2 };
    s.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return s;
  }

  // ---------- ViewModel ----------
  function clampList(items, n) {
    return (items || []).filter(Boolean).slice(0, n);
  }

  function buildViewModel(input, tone) {
    const copy = getCopy(tone);
    const signals = detectSignals(input);
    const theme = pickSummaryTheme(signals);
    const summary = theme ? copy.summary.behaviorOverResult(theme) : copy.summary.noClear;

    const base = (input && input.baselines30d) || {};
    const b = (input && input.behavior) || {};

    const intensity =
      base.tradesPerDayMedian != null
        ? b.trades < base.tradesPerDayMedian * 0.7
          ? "laag"
          : b.trades > base.tradesPerDayMedian * 1.3
          ? "hoog"
          : "normaal"
        : b.trades >= 20
        ? "hoog"
        : "normaal";

    const rest =
      b.medianMinutesBetweenTrades == null
        ? "onbekend"
        : b.medianMinutesBetweenTrades < 6
        ? "te kort"
        : "voldoende";

    const afterLoss = signals.some((s) => s.kind === "revenge" || s.kind === "tilt") ? "impulsief" : "stabiel";

    const sizing =
      b.sizeVsBaselinePct == null
        ? "onbekend"
        : b.sizeVsBaselinePct >= 25
        ? "hoger"
        : b.sizeVsBaselinePct <= -15
        ? "lager"
        : "gelijk";

    const behaviorChips = [
      { label: "Trade-intensiteit", value: intensity },
      { label: "Rust", value: rest },
      { label: "Na verlies", value: afterLoss },
      { label: "Sizing", value: sizing },
    ];

    // helped/hurt
    const segs = (input && input.segments) || [];
    const helpedSeg = segs.filter((x) => x.effect === "helped").map((x) => x.label);
    const hurtSeg = segs.filter((x) => x.effect === "hurt").map((x) => x.label);

    const helpedFallback = [];
    const hurtFallback = [];
    if (signals.some((s) => s.kind === "noClear")) helpedFallback.push("Consistente uitvoering zonder duidelijke gedragsafwijkingen.");
    if (signals.some((s) => s.kind === "lowRest")) hurtFallback.push("Te weinig rust tussen trades (sneller beslissen = vaker ruis).");
    if (signals.some((s) => s.kind === "overtrading")) hurtFallback.push("Te veel trades: edge per trade zakt vaak weg bij hoge frequentie.");
    if (signals.some((s) => s.kind === "revenge")) hurtFallback.push("Na verlies versnelde je (revenge/impuls) — dat kost doorgaans geld.");
    if (signals.some((s) => s.kind === "sizeUp")) hurtFallback.push("Position sizing lag boven je baseline (risico neemt disproportioneel toe).");
    if (signals.some((s) => s.kind === "tilt")) hurtFallback.push("Tilt-signaal: verliesstreak/gedrag geeft verhoogd risico.");

    const helped = clampList(helpedSeg.length ? helpedSeg : helpedFallback, 3);
    const hurt = clampList(hurtSeg.length ? hurtSeg : hurtFallback, 3);

    // patterns
    const patterns = [];
    if (input && input.baselines30d && signals.some((s) => s.kind === "revenge")) patterns.push(copy.patterns.afterLoss);
    if (signals.some((s) => s.kind === "overtrading")) patterns.push(copy.patterns.overtradeRecurring);

    // discipline
    const reasons = [];
    const rules = (input && input.discipline) || {};
    if (rules.maxTradesRule && rules.maxTradesRule.enabled && b.trades > rules.maxTradesRule.maxTrades) {
      reasons.push(`Max trades overschreden (${b.trades}/${rules.maxTradesRule.maxTrades}).`);
    }
    if (signals.some((s) => s.kind === "lowRest") && rules.cooldownAfterLossRule && rules.cooldownAfterLossRule.enabled) {
      reasons.push("Cooldown/rust werd niet consistent genomen.");
    }
    if (signals.some((s) => s.kind === "sizeUp")) reasons.push("Sizing boven baseline tijdens risico-momenten.");

    const disciplineLabel =
      reasons.length === 0
        ? copy.labels.disciplineGood
        : reasons.length === 1
        ? copy.labels.disciplineOkay
        : copy.labels.disciplineOff;

    // focus (exactly one)
    let focus = "";
    if (rules.cooldownAfterLossRule && rules.cooldownAfterLossRule.enabled && signals.some((s) => s.kind === "revenge" || s.kind === "tilt")) {
      focus = copy.focus.cooldown(rules.cooldownAfterLossRule.minutes);
    } else if (rules.maxTradesRule && rules.maxTradesRule.enabled && signals.some((s) => s.kind === "overtrading")) {
      focus = copy.focus.maxTrades(rules.maxTradesRule.maxTrades);
    } else if (signals.some((s) => s.kind === "sizeUp")) {
      focus = copy.focus.sizeLock;
    } else {
      focus = copy.focus.neutral;
    }

    // if-then
    const ifThen = [];
    if (rules.dailyStopRule && rules.dailyStopRule.enabled) {
      if (rules.dailyStopRule.maxLossR != null) ifThen.push(`Als je ${rules.dailyStopRule.maxLossR}R verlies bereikt → stop voor vandaag.`);
      else if (rules.dailyStopRule.maxLossPct != null) ifThen.push(`Als je ${rules.dailyStopRule.maxLossPct}% verlies bereikt → stop voor vandaag.`);
    }
    if (rules.cooldownAfterLossRule && rules.cooldownAfterLossRule.enabled && (signals.some((s) => s.kind === "revenge") || signals.some((s) => s.kind === "tilt"))) {
      ifThen.push(`Na een verlies → ${rules.cooldownAfterLossRule.minutes} min weg van het scherm.`);
    }

    return {
      tone,
      periodLabel: (input && input.period && input.period.label) || "—",
      summary,
      behaviorChips,
      helped,
      hurt,
      patterns: clampList(patterns, 2),
      disciplineStatus: { label: disciplineLabel, reasons: clampList(reasons, 2) },
      focus,
      ifThen: clampList(ifThen, 2),
      signals,
    };
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "class") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k === "style") n.setAttribute("style", attrs[k]);
        else if (k.startsWith("on") && typeof attrs[k] === "function") n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => n.appendChild(c));
    return n;
  }

  function renderBullets(items, emptyText) {
    if (!items || items.length === 0) return el("div", { class: "coach-empty", text: emptyText || "—" });
    const ul = el("ul", { class: "coach-ul" });
    items.forEach((x) => ul.appendChild(el("li", { class: "coach-li", text: x })));
    return ul;
  }

  function renderChipRow(chips) {
    const row = el("div", { class: "coach-chiprow" });
    chips.forEach((c) => {
      row.appendChild(
        el("div", { class: "coach-chip" }, [
          el("span", { class: "coach-chip-label", text: c.label + ":" }),
          el("span", { class: "coach-chip-value", text: c.value }),
        ])
      );
    });
    return row;
  }

  function renderToneToggle(currentTone, onChange) {
    const wrap = el("div", { class: "coach-tone" });
    const tones = [
      { id: "mild", label: "Mild" },
      { id: "neutral", label: "Neutraal" },
      { id: "confronting", label: "Confronterend" },
    ];
    tones.forEach((t) => {
      const btn = el("button", {
        text: t.label,
        onclick: () => onChange(t.id),
      });
      if (t.id === currentTone) btn.classList.add("active");
      wrap.appendChild(btn);
    });
    return wrap;
  }

  // ---------- Public mount points ----------
  function mountTeaser(opts) {
    ensureStyles();
    const mount = document.getElementById(opts.mountId);
    if (!mount) {
      console.warn("[Coach] mountTeaser: mount not found:", opts.mountId);
      return;
    }
    function rerender() {
      const input = opts.getInput();
      const tone = (opts.getTone && opts.getTone()) || "neutral";
      const vm = buildViewModel(input, tone);
      mount.innerHTML = "";

      const left = el("div", null, [
        el("div", { class: "coach-teaser-title", text: `Coach • ${vm.periodLabel}` }),
        el("div", { class: "coach-teaser-summary", text: vm.summary }),
      ]);
      const pill = el("div", { class: "coach-pill", text: vm.disciplineStatus.label });
      const cont = el("div", { class: "coach-teaser" }, [left, pill]);

      if (opts.onOpenCoach) {
        cont.setAttribute("role", "button");
        cont.addEventListener("click", opts.onOpenCoach);
      }
      mount.appendChild(cont);
    }
    rerender();
    return { rerender };
  }

  function mountTab(opts) {
    ensureStyles();
    const mount = document.getElementById(opts.mountId);
    if (!mount) {
      console.warn("[Coach] mountTab: mount not found:", opts.mountId);
      return;
    }

    let tone = opts.defaultTone || "neutral";

    function rerender() {
      const input = opts.getInput();
      const vm = buildViewModel(input, tone);

      mount.innerHTML = "";
      const wrap = el("div", { class: "coach-wrap" });

      const headerLeft = el("div", null, [
        el("h2", { class: "coach-title", text: "Coach" }),
        el("div", { class: "coach-sub", text: `Rust • Overzicht • Coaching • ${vm.periodLabel}` }),
      ]);

      const toggle = renderToneToggle(tone, (t) => {
        tone = t;
        rerender();
        if (opts.onToneChange) opts.onToneChange(tone);
      });

      wrap.appendChild(el("div", { class: "coach-header" }, [headerLeft, toggle]));

      // Summary
      wrap.appendChild(
        el("div", { class: "coach-card" }, [
          el("div", { class: "coach-card-title", text: "Coach samenvatting" }),
          el("div", { text: vm.summary }),
        ])
      );

      // Behavior
      wrap.appendChild(
        el("div", { class: "coach-card" }, [
          el("div", { class: "coach-card-title", text: "Gedragsstatus" }),
          renderChipRow(vm.behaviorChips),
        ])
      );

      // Helped / Hurt
      wrap.appendChild(
        el("div", { class: "coach-grid2" }, [
          el("div", { class: "coach-card" }, [
            el("div", { class: "coach-card-title", text: "Wat hielp" }),
            renderBullets(vm.helped, "Geen duidelijke positieve drivers gevonden (nog)."),
          ]),
          el("div", { class: "coach-card" }, [
            el("div", { class: "coach-card-title", text: "Wat schaadde" }),
            renderBullets(vm.hurt, "Geen duidelijke negatieve drivers gevonden."),
          ]),
        ])
      );

      // Patterns (conditional)
      if (vm.patterns && vm.patterns.length) {
        wrap.appendChild(
          el("div", { class: "coach-card" }, [
            el("div", { class: "coach-card-title", text: "Patronen" }),
            renderBullets(vm.patterns),
          ])
        );
      }

      // Discipline / Focus / If-Then
      wrap.appendChild(
        el("div", { class: "coach-grid3" }, [
          el("div", { class: "coach-card" }, [
            el("div", { class: "coach-card-title", text: "Discipline" }),
            el("div", { style: "font-size:15px;font-weight:700", text: vm.disciplineStatus.label }),
            el("div", { style: "height:8px" }),
            renderBullets(vm.disciplineStatus.reasons, "Geen overtredingen gedetecteerd."),
          ]),
          el("div", { class: "coach-card" }, [
            el("div", { class: "coach-card-title", text: "Focus (volgende sessie)" }),
            el("div", { text: vm.focus }),
          ]),
          el("div", { class: "coach-card" }, [
            el("div", { class: "coach-card-title", text: "Als–dan plan" }),
            vm.ifThen && vm.ifThen.length
              ? renderBullets(vm.ifThen)
              : el("div", { class: "coach-empty", text: "Geen extra regels nodig vandaag." }),
          ]),
        ])
      );

      // Debug signals (remove later)
      wrap.appendChild(
        el("div", { class: "coach-card" }, [
          el("div", { class: "coach-card-title", text: "Debug (signals)" }),
          el("div", { class: "coach-debug", text: "Alleen voor bouwen. Later uitzetten." }),
          renderBullets(vm.signals.map((x) => `${x.severity.toUpperCase()} • ${x.kind} — ${x.reason}`)),
        ])
      );

      mount.appendChild(wrap);
    }

    rerender();
    return {
      rerender,
      setTone: (t) => {
        tone = t;
        rerender();
      },
    };
  }

  window.Coach = {
    detectSignals,
    buildViewModel,
    mountTeaser,
    mountTab,
  };
})();
