import React, { useMemo, useState } from "react";

/**
 * CoachTabComplete.tsx
 * - Single-file drop-in version (to avoid import path/type errors)
 * - Exports:
 *   - CoachTabComplete
 *   - CoachTeaserComplete
 *
 * Usage:
 *   <CoachTabComplete input={coachInput} />
 *   <CoachTeaserComplete input={coachInput} onOpenCoach={() => goToTab("coach")} />
 */

export type CoachTone = "mild" | "neutral" | "confronting";

export type CoachPeriod = {
  label: string;
  startISO: string;
  endISO: string;
};

export type CoachBehavior = {
  trades: number;
  tradesPerHourPeak?: number;
  medianMinutesBetweenTrades?: number;
  medianHoldingMinutes?: number;
  reentriesSameSymbol?: number;
  sizeVsBaselinePct?: number;
  leverageVsBaselinePct?: number;
};

export type CoachResults = {
  netPnl?: number;
  winRate?: number;
  profitFactor?: number;
  expectancyR?: number;
  maxDrawdownR?: number;
};

export type DisciplineRules = {
  maxTradesRule?: { enabled: boolean; maxTrades: number };
  maxLeverageRule?: { enabled: boolean; maxLeverage: number };
  cooldownAfterLossRule?: { enabled: boolean; minutes: number };
  dailyStopRule?: { enabled: boolean; maxLossR?: number; maxLossPct?: number };
};

export type CoachBaselines30d = {
  tradesPerDayMedian?: number;
  tradesPerDayIQR?: number;
  medianMinutesBetweenTrades?: number;
  medianHoldingMinutes?: number;
  sizeMedian?: number;
  leverageMedian?: number;
};

export type CoachSequences = {
  firstLossTimeISO?: string | null;
  afterLossTrades?: number;
  afterLossSizeVsBaselinePct?: number;
  lossStreakMax?: number;
  flipCountSameSymbol?: number;
};

export type CoachSegmentInsight = {
  label: string;
  effect: "helped" | "hurt";
  confidence?: "low" | "medium" | "high";
};

export type CoachInput = {
  period: CoachPeriod;
  behavior: CoachBehavior;
  results: CoachResults;
  discipline: DisciplineRules;
  baselines30d?: CoachBaselines30d;
  sequences?: CoachSequences;
  segments?: CoachSegmentInsight[];
};

export type CoachSignalKind =
  | "overtrading"
  | "revenge"
  | "tilt"
  | "lowRest"
  | "sizeUp"
  | "flipChop"
  | "sessionWeak"
  | "noClear";

export type CoachSignal = {
  kind: CoachSignalKind;
  severity: "info" | "warn" | "high";
  reason: string;
};

export type CoachViewModel = {
  tone: CoachTone;
  periodLabel: string;
  summary: string;
  behaviorChips: { label: string; value: string }[];
  helped: string[];
  hurt: string[];
  patterns: string[];
  disciplineStatus: { label: string; reasons: string[] };
  focus: string;
  ifThen: string[];
  signals: CoachSignal[];
};

// -------------------- Copy (tone) --------------------

type ToneCopy = {
  summary: {
    noClear: string;
    behaviorOverResult: (s: string) => string;
  };
  labels: {
    disciplineGood: string;
    disciplineOkay: string;
    disciplineOff: string;
  };
  focusTemplates: {
    cooldown: (m: number) => string;
    maxTrades: (n: number) => string;
    sessionOnly: (s: string) => string;
    sizeLock: string;
  };
  patternTemplates: {
    afterLoss: string;
    nyWeak: string;
    overtradeRecurring: string;
  };
};

const COPIES: Record<CoachTone, ToneCopy> = {
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
    focusTemplates: {
      cooldown: (m) => `Na een verlies: ${m} min pauze (even resetten).`,
      maxTrades: (n) => `Max ${n} trades vandaag — kwaliteit boven kwantiteit.`,
      sessionOnly: (s) => `Vandaag alleen ${s} sessie traden.`,
      sizeLock: "Houd je positie-size gelijk aan je baseline (niet opschalen in drawdown).",
    },
    patternTemplates: {
      afterLoss: "Na een verlies zakt je performance vaker weg. Een korte pauze kan dit doorbreken.",
      nyWeak: "De NY-open lijkt voor jou relatief zwak. Minder exposure daar kan helpen.",
      overtradeRecurring: "Je trade-intensiteit piekt vaker op vergelijkbare dagen. Een trade-budget helpt.",
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
    focusTemplates: {
      cooldown: (m) => `Na een verlies: ${m} min cooldown.`,
      maxTrades: (n) => `Max ${n} trades vandaag.`,
      sessionOnly: (s) => `Alleen traden in ${s} sessie.`,
      sizeLock: "Geen opschalen van size tijdens drawdown.",
    },
    patternTemplates: {
      afterLoss: "Na een verlies is je volgende serie trades structureel zwakker dan je baseline.",
      nyWeak: "NY-open is een zwakker segment voor je (over tijd).",
      overtradeRecurring: "Overtrading komt vaker terug in je data. Een vaste limiet voorkomt ruis-trades.",
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
    focusTemplates: {
      cooldown: (m) => `Na verlies: ${m} min weg van het scherm. Punt.`,
      maxTrades: (n) => `Meer dan ${n} trades = impuls. Stop op ${n}.`,
      sessionOnly: (s) => `${s} only. Buiten dat: niet traden.`,
      sizeLock: "Size omhoog in drawdown = tilt. Niet doen.",
    },
    patternTemplates: {
      afterLoss: "Je maakt je dag kapot na een verlies. Neem pauze, anders blijf je betalen.",
      nyWeak: "NY-open is waar jij geld weggeeft. Verminder of vermijd.",
      overtradeRecurring: "Je overtrade’t. Limiet instellen en eraan houden.",
    },
  },
};

function getCopy(tone: CoachTone): ToneCopy {
  return COPIES[tone];
}

function pickSummaryTheme(signals: CoachSignal[]): string | null {
  const high = signals.find((s) => s.severity === "high");
  const warn = signals.find((s) => s.severity === "warn");
  const pick = high ?? warn ?? signals[0];
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

// -------------------- Signals --------------------

function detectSignals(input: CoachInput): CoachSignal[] {
  const s: CoachSignal[] = [];
  const b = input.behavior;
  const base = input.baselines30d;
  const seq = input.sequences;

  if (base?.tradesPerDayMedian != null && base?.tradesPerDayIQR != null) {
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
    s.push({ kind: "overtrading", severity: "warn", reason: "trades >= 20 (fallback threshold)" });
  }

  if (b.medianMinutesBetweenTrades != null && base?.medianMinutesBetweenTrades != null) {
    if (b.medianMinutesBetweenTrades < base.medianMinutesBetweenTrades * 0.6) {
      s.push({ kind: "lowRest", severity: "warn", reason: "rest dropped vs baseline" });
    }
  } else if (b.medianMinutesBetweenTrades != null && b.medianMinutesBetweenTrades < 6) {
    s.push({ kind: "lowRest", severity: "warn", reason: "median rest < 6m (fallback)" });
  }

  if (b.sizeVsBaselinePct != null && b.sizeVsBaselinePct >= 25) {
    s.push({
      kind: "sizeUp",
      severity: b.sizeVsBaselinePct >= 50 ? "high" : "warn",
      reason: `size +${b.sizeVsBaselinePct}%`,
    });
  }

  if (seq?.firstLossTimeISO && seq.afterLossTrades != null) {
    const afterLossMany = seq.afterLossTrades >= 4;
    const afterLossSizeUp = (seq.afterLossSizeVsBaselinePct ?? 0) >= 20;
    if (afterLossMany && afterLossSizeUp) {
      s.push({ kind: "revenge", severity: "high", reason: "after-loss trades high + size up" });
    } else if (afterLossMany) {
      s.push({ kind: "revenge", severity: "warn", reason: "after-loss trade count high" });
    }
  }

  if ((seq?.lossStreakMax ?? 0) >= 4) {
    s.push({ kind: "tilt", severity: "high", reason: "loss streak >= 4" });
  } else if ((seq?.lossStreakMax ?? 0) === 3) {
    s.push({ kind: "tilt", severity: "warn", reason: "loss streak == 3" });
  }

  if ((seq?.flipCountSameSymbol ?? 0) >= 3) {
    s.push({ kind: "flipChop", severity: "warn", reason: "flip count same symbol >= 3" });
  }

  if (s.length === 0) {
    s.push({ kind: "noClear", severity: "info", reason: "no clear signals" });
  }

  const sevRank = { high: 0, warn: 1, info: 2 } as const;
  return s.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
}

// -------------------- ViewModel --------------------

function clampList(items: string[], n: number) {
  return (items ?? []).filter(Boolean).slice(0, n);
}
function behaviorValue(label: string, value: string) {
  return { label, value };
}

function buildCoachViewModel(input: CoachInput, tone: CoachTone = "neutral"): CoachViewModel {
  const copy = getCopy(tone);
  const signals = detectSignals(input);

  const theme = pickSummaryTheme(signals);
  const summary = theme == null ? copy.summary.noClear : copy.summary.behaviorOverResult(theme);

  const base = input.baselines30d;
  const b = input.behavior;

  const intensity =
    base?.tradesPerDayMedian != null
      ? b.trades < base.tradesPerDayMedian * 0.7
        ? "laag"
        : b.trades > base.tradesPerDayMedian * 1.3
        ? "hoog"
        : "normaal"
      : b.trades >= 20
      ? "hoog"
      : "normaal";

  const rest =
    b.medianMinutesBetweenTrades == null ? "onbekend" : b.medianMinutesBetweenTrades < 6 ? "te kort" : "voldoende";

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
    behaviorValue("Trade-intensiteit", intensity),
    behaviorValue("Rust", rest),
    behaviorValue("Na verlies", afterLoss),
    behaviorValue("Sizing", sizing),
  ];

  const segments = input.segments ?? [];
  const helpedSeg = segments.filter((x) => x.effect === "helped").map((x) => x.label);
  const hurtSeg = segments.filter((x) => x.effect === "hurt").map((x) => x.label);

  const helpedFallback: string[] = [];
  const hurtFallback: string[] = [];

  if (signals.some((s) => s.kind === "noClear")) helpedFallback.push("Consistente uitvoering zonder duidelijke gedragsafwijkingen.");
  if (signals.some((s) => s.kind === "lowRest")) hurtFallback.push("Te weinig rust tussen trades (sneller beslissen = vaker ruis).");
  if (signals.some((s) => s.kind === "overtrading")) hurtFallback.push("Te veel trades: edge per trade zakt vaak weg bij hoge frequentie.");
  if (signals.some((s) => s.kind === "revenge")) hurtFallback.push("Na verlies versnelde je (revenge/impuls) — dat kost doorgaans geld.");
  if (signals.some((s) => s.kind === "sizeUp")) hurtFallback.push("Position sizing lag boven je baseline (risico neemt disproportioneel toe).");
  if (signals.some((s) => s.kind === "tilt")) hurtFallback.push("Tilt-signaal: verliesstreak/gedrag geeft verhoogd risico.");

  const helped = clampList(helpedSeg.length ? helpedSeg : helpedFallback, 3);
  const hurt = clampList(hurtSeg.length ? hurtSeg : hurtFallback, 3);

  const patterns: string[] = [];
  if (input.baselines30d && signals.some((s) => s.kind === "revenge")) patterns.push(copy.patternTemplates.afterLoss);
  if (signals.some((s) => s.kind === "overtrading")) patterns.push(copy.patternTemplates.overtradeRecurring);

  const reasons: string[] = [];
  const rules = input.discipline;

  if (rules.maxTradesRule?.enabled && b.trades > rules.maxTradesRule.maxTrades) {
    reasons.push(`Max trades overschreden (${b.trades}/${rules.maxTradesRule.maxTrades}).`);
  }
  if (signals.some((s) => s.kind === "lowRest") && rules.cooldownAfterLossRule?.enabled) {
    reasons.push("Cooldown/rust werd niet consistent genomen.");
  }
  if (signals.some((s) => s.kind === "sizeUp")) {
    reasons.push("Sizing boven baseline tijdens risico-momenten.");
  }

  const disciplineLabel =
    reasons.length === 0 ? copy.labels.disciplineGood : reasons.length === 1 ? copy.labels.disciplineOkay : copy.labels.disciplineOff;

  let focus = "";
  if (rules.cooldownAfterLossRule?.enabled && signals.some((s) => s.kind === "revenge" || s.kind === "tilt")) {
    focus = copy.focusTemplates.cooldown(rules.cooldownAfterLossRule.minutes);
  } else if (rules.maxTradesRule?.enabled && signals.some((s) => s.kind === "overtrading")) {
    focus = copy.focusTemplates.maxTrades(rules.maxTradesRule.maxTrades);
  } else if (signals.some((s) => s.kind === "sizeUp")) {
    focus = copy.focusTemplates.sizeLock;
  } else {
    focus = "Focus: voer je plan rustig en consistent uit (geen extra regels nodig vandaag).";
  }

  const ifThen: string[] = [];
  if (rules.dailyStopRule?.enabled) {
    if (rules.dailyStopRule.maxLossR != null) ifThen.push(`Als je ${rules.dailyStopRule.maxLossR}R verlies bereikt → stop voor vandaag.`);
    else if (rules.dailyStopRule.maxLossPct != null) ifThen.push(`Als je ${rules.dailyStopRule.maxLossPct}% verlies bereikt → stop voor vandaag.`);
  }
  if (rules.cooldownAfterLossRule?.enabled && (signals.some((s) => s.kind === "revenge") || signals.some((s) => s.kind === "tilt"))) {
    ifThen.push(`Na een verlies → ${rules.cooldownAfterLossRule.minutes} min weg van het scherm.`);
  }

  return {
    tone,
    periodLabel: input.period.label,
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

// -------------------- Components --------------------

function ToneToggle({ tone, setTone }: { tone: CoachTone; setTone: (t: CoachTone) => void }) {
  const wrap: React.CSSProperties = {
    display: "inline-flex",
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 999,
    overflow: "hidden",
    background: "rgba(255,255,255,0.8)",
  };
  const btn = (active: boolean): React.CSSProperties => ({
    padding: "8px 10px",
    fontSize: 12,
    cursor: "pointer",
    border: "none",
    background: active ? "rgba(0,0,0,0.06)" : "transparent",
  });

  return (
    <div style={wrap} aria-label="Coach tone">
      <button style={btn(tone === "mild")} onClick={() => setTone("mild")}>Mild</button>
      <button style={btn(tone === "neutral")} onClick={() => setTone("neutral")}>Neutraal</button>
      <button style={btn(tone === "confronting")} onClick={() => setTone("confronting")}>Confronterend</button>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  const card: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.10)",
    borderRadius: 16,
    padding: 14,
    background: "rgba(255,255,255,0.85)",
    backdropFilter: "blur(8px)",
  };
  const h: React.CSSProperties = { fontSize: 13, opacity: 0.75, marginBottom: 10 };
  return (
    <div style={card}>
      <div style={h}>{title}</div>
      {children}
    </div>
  );
}

function BulletList({ items, emptyText }: { items: string[]; emptyText?: string }) {
  const ul: React.CSSProperties = { margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 };
  const li: React.CSSProperties = { fontSize: 14, lineHeight: 1.35 };
  if (!items || items.length === 0) return <div style={{ fontSize: 14, opacity: 0.7 }}>{emptyText ?? "—"}</div>;
  return (
    <ul style={ul}>
      {items.map((x, i) => (
        <li key={i} style={li}>{x}</li>
      ))}
    </ul>
  );
}

function ChipRow({ chips }: { chips: { label: string; value: string }[] }) {
  const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };
  const chip: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.9)",
    borderRadius: 999,
    padding: "8px 10px",
    fontSize: 13,
    display: "inline-flex",
    gap: 6,
    alignItems: "baseline",
  };
  const label: React.CSSProperties = { opacity: 0.65, fontSize: 12 };
  const value: React.CSSProperties = { fontWeight: 600 };
  return (
    <div style={row}>
      {chips.map((c, i) => (
        <div key={i} style={chip}>
          <span style={label}>{c.label}:</span> <span style={value}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

export function CoachTeaserComplete({
  input,
  tone = "neutral",
  onOpenCoach,
}: {
  input: CoachInput;
  tone?: CoachTone;
  onOpenCoach?: () => void;
}) {
  const vm = buildCoachViewModel(input, tone);

  const container: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.10)",
    borderRadius: 12,
    padding: "10px 12px",
    background: "rgba(255,255,255,0.75)",
    backdropFilter: "blur(6px)",
    display: "flex",
    gap: 10,
    alignItems: "center",
    justifyContent: "space-between",
  };

  const left: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
  const title: React.CSSProperties = { fontSize: 12, opacity: 0.7 };
  const summary: React.CSSProperties = { fontSize: 13, lineHeight: 1.25 };

  const pill: React.CSSProperties = {
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.9)",
    whiteSpace: "nowrap",
  };

  return (
    <div style={container} onClick={onOpenCoach} role={onOpenCoach ? "button" : undefined}>
      <div style={left}>
        <div style={title}>Coach • {vm.periodLabel}</div>
        <div style={summary}>{vm.summary}</div>
      </div>
      <div style={pill}>{vm.disciplineStatus.label}</div>
    </div>
  );
}

export function CoachTabComplete({ input, defaultTone = "neutral" }: { input: CoachInput; defaultTone?: CoachTone }) {
  const [tone, setTone] = useState<CoachTone>(defaultTone);
  const vm = useMemo(() => buildCoachViewModel(input, tone), [input, tone]);

  const page: React.CSSProperties = {
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxWidth: 980,
    margin: "0 auto",
  };

  const header: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  };

  const title: React.CSSProperties = { fontSize: 18, fontWeight: 700, margin: 0 };
  const sub: React.CSSProperties = { fontSize: 13, opacity: 0.7, marginTop: 4 };

  // Avoid window usage during SSR:
  const isWide = typeof window !== "undefined" ? window.innerWidth >= 880 : true;

  const twoCol: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: isWide ? "1fr 1fr" : "1fr",
    gap: 12,
  };

  const threeCol: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: isWide ? "1fr 1fr 1fr" : "1fr",
    gap: 12,
  };

  return (
    <div style={page}>
      <div style={header}>
        <div>
          <h2 style={title}>Coach</h2>
          <div style={sub}>Rust • Overzicht • Coaching • {vm.periodLabel}</div>
        </div>
        <ToneToggle tone={tone} setTone={setTone} />
      </div>

      <Card title="Coach samenvatting">
        <div style={{ fontSize: 15, lineHeight: 1.4 }}>{vm.summary}</div>
      </Card>

      <Card title="Gedragsstatus">
        <ChipRow chips={vm.behaviorChips} />
      </Card>

      <div style={twoCol}>
        <Card title="Wat hielp">
          <BulletList items={vm.helped} emptyText="Geen duidelijke positieve drivers gevonden (nog)." />
        </Card>
        <Card title="Wat schaadde">
          <BulletList items={vm.hurt} emptyText="Geen duidelijke negatieve drivers gevonden." />
        </Card>
      </div>

      {vm.patterns.length > 0 && (
        <Card title="Patronen">
          <BulletList items={vm.patterns} />
        </Card>
      )}

      <div style={threeCol}>
        <Card title="Discipline">
          <div style={{ fontSize: 15, fontWeight: 700 }}>{vm.disciplineStatus.label}</div>
          <div style={{ height: 8 }} />
          <BulletList items={vm.disciplineStatus.reasons} emptyText="Geen overtredingen gedetecteerd." />
        </Card>

        <Card title="Focus (volgende sessie)">
          <div style={{ fontSize: 15, lineHeight: 1.4 }}>{vm.focus}</div>
        </Card>

        <Card title="Als–dan plan">
          {vm.ifThen.length > 0 ? (
            <BulletList items={vm.ifThen} />
          ) : (
            <div style={{ fontSize: 14, opacity: 0.7 }}>Geen extra regels nodig vandaag.</div>
          )}
        </Card>
      </div>

      <Card title="Debug (signals)">
        <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 8 }}>
          Alleen voor bouwen. Later uitzetten.
        </div>
        <BulletList items={vm.signals.map((s) => `${s.severity.toUpperCase()} • ${s.kind} — ${s.reason}`)} />
      </Card>
    </div>
  );
}
