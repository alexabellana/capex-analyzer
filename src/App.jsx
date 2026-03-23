import { useState, useMemo, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart, Bar, Cell, ReferenceArea } from "recharts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v, decimals = 2, prefix = "$") => {
  if (v === null || v === undefined || isNaN(v)) return "N/A";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(decimals)}K`;
  return `${sign}${prefix}${abs.toFixed(decimals)}`;
};

const fmtPct = (v, d = 2) => (v === null || isNaN(v) ? "N/A" : `${(v * 100).toFixed(d)}%`);
const fmtPayback = (v) => {
  if (v === null || v === undefined) return "N/A";
  if (v >= 1) return `${v.toFixed(2)} yrs`;
  const months = v * 12;
  if (months >= 1) return `${months.toFixed(1)} mos`;
  return `${Math.round(v * 365)} days`;
};

function calcNPV(rate, cashflows) {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}

function calcIRR(cashflows, guess = 0.1) {
  let r = guess;
  for (let i = 0; i < 1000; i++) {
    const npv = calcNPV(r, cashflows);
    const dnpv = cashflows.reduce((acc, cf, t) => acc - (t * cf) / Math.pow(1 + r, t + 1), 0);
    if (Math.abs(dnpv) < 1e-12) break;
    const rNew = r - npv / dnpv;
    if (Math.abs(rNew - r) < 1e-10) return rNew;
    r = rNew;
  }
  return isFinite(r) ? r : null;
}

function calcPayback(cashflows) {
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const prev = cum;
    cum += cashflows[t];
    if (cum >= 0 && t > 0) return t - 1 + Math.abs(prev) / cashflows[t];
  }
  // Extrapolate beyond horizon using last year's entitlement
  const lastCF = cashflows[cashflows.length - 1];
  if (lastCF > 0 && cum < 0) {
    return cashflows.length - 1 + Math.abs(cum) / lastCF;
  }
  return null;
}

function calcDiscountedPayback(cashflows, rate) {
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const prev = cum;
    const dcf = cashflows[t] / Math.pow(1 + rate, t);
    cum += dcf;
    if (cum >= 0 && t > 0) return t - 1 + Math.abs(prev) / dcf;
  }
  // Extrapolate beyond horizon using last year's discounted entitlement
  const lastDCF = cashflows[cashflows.length - 1] / Math.pow(1 + rate, cashflows.length - 1);
  if (lastDCF > 0 && cum < 0) {
    return cashflows.length - 1 + Math.abs(cum) / lastDCF;
  }
  return null;
}

// ─── Verdict (3-tier) ─────────────────────────────────────────────────────────
// NOTE: AMBER_CONFIDENCE (Disc.PB < 2.5 AND Confidence NPV < 0) is mathematically
// impossible: if Disc.PB < 2.5 then NPV > 0, therefore Confidence NPV = NPV*factor > 0.
// The only meaningful verdicts are GO, AMBER_PAYBACK, and NO-GO.

function calcVerdict(dPayback) {
  if (dPayback === null) return "NO-GO";
  if (dPayback > 3) return "NO-GO";
  if (dPayback >= 2.5) return "AMBER_PAYBACK";
  return "GO";
}

const VERDICT_CONFIG = {
  "GO":            { color: "#00e5a0", bg: "rgba(0,229,160,0.08)",   border: "#00e5a060", label: "GO",      icon: "▲", desc: "Project meets financial criteria" },
  "AMBER_PAYBACK": { color: "#ffd166", bg: "rgba(255,209,102,0.08)", border: "#ffd16660", label: "REQUIRES FINANCIAL STRATEGIC ALIGNMENT", icon: "◆", desc: "Discounted Payback is between 2.5 and 3 years" },
  "NO-GO":         { color: "#ff4d6d", bg: "rgba(255,77,109,0.08)",  border: "#ff4d6d60", label: "NO-GO",   icon: "▼", desc: "Discounted Payback exceeds 3 years" },
};

// ─── Default State ─────────────────────────────────────────────────────────────

const DEFAULT = {
  initialInvestment: 1000000,
  wacc: 0.10,
  confidenceFactor: 0.85,
  cashflows: [420000, 420000, 420000],
  startMonth: 1,
};

const WACC_RANGE = Array.from({ length: 21 }, (_, i) => i * 0.01 + 0.02);

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

// ─── Descriptions ─────────────────────────────────────────────────────────────

const METRIC_DESCRIPTIONS = {
  "NPV": "How much real value the project creates today, after discounting future entitlement at the WACC. A positive NPV means the project generates net value on top of repaying all capital costs. This is the single most important metric.",
  "Discounted Payback": "How many years to recover your investment using the real value of money (discounted at WACC).\n• GO: < 2.5 years\n• Requires Financial Strategic Alignment: 2.5–3 years\n• NO-GO: > 3 years",
  "ROI": "Total return on the investment without adjusting for time. An ROI of 50% means you recover the investment and earn an additional 50%. Easy to communicate to any stakeholder.",
  "Confidence NPV": "The NPV scaled by your confidence level. If negative, the project may not be investment-ready even under optimistic assumptions — triggers a Requires Financial Strategic Alignment verdict.",
  "IRR": "The project's intrinsic annual return rate. If it exceeds your WACC, the project earns more than it costs to fund.",
  "Simple Payback": "How many years to recover the investment using undiscounted entitlement. Easier to communicate but less rigorous than Discounted Payback.",
};

const INPUT_DESCRIPTIONS = {
  "Initial Investment": "Total project cost: equipment, facilities, software, implementation. This is the cash that leaves before the project generates any income. Enter the exact dollar amount — it is the foundation of every calculation.",
  "WACC": "Your cost of capital. The minimum return the project must generate to make financial sense. At Amazon this typically sits between 8% and 12%. If unsure, 10% is a solid default.",
  "Confidence Factor": "Reflects how certain you are that the projected entitlement will be fully realised. In professional investment appraisal, anything below 70% is considered speculative and rarely approved.\n• Very High (90–100%): Entitlement is contractually committed, backed by historical precedent, or based on audited baselines. Board-level approval standard.\n• High (80–89%): Entitlement grounded in robust assumptions with minor execution risk. Acceptable for most internal CapEx approvals.\n• Medium (70–79%): Reasonable forecast with identifiable risks. Requires sensitivity analysis and mitigation plan before approval.\n• Low (< 70%): Speculative. Entitlement depends on uncertain variables. Business case should not proceed without significant de-risking or a revised scope.",
};

// ─── MetricCard ───────────────────────────────────────────────────────────────

const MetricCard = ({ label, value, sub, highlight, verdictKey }) => {
  const [open, setOpen] = useState(false);
  const desc = METRIC_DESCRIPTIONS[label];
  const cfg = verdictKey ? VERDICT_CONFIG[verdictKey] : null;
  const statusColor = cfg ? cfg.color : highlight ? "#00e5a0" : null;
  return (
    <div style={{
      background: highlight ? "linear-gradient(135deg,rgba(0,229,160,0.08),rgba(0,150,255,0.06))" : "rgba(255,255,255,0.03)",
      border: `1px solid ${statusColor ? statusColor + "40" : "rgba(255,255,255,0.07)"}`,
      borderRadius: 12,
      padding: 22,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      position: "relative",
      overflow: "hidden",
    }}>
      {statusColor && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,transparent,${statusColor},transparent)` }} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "rgba(255,255,255,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>
        {desc && (
          <button onClick={() => setOpen(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: open ? "#00e5a0" : "rgba(255,255,255,0.3)", fontSize: 12, fontFamily: "'Space Mono',monospace" }}>
            {open ? "▲" : "▼"}
          </button>
        )}
      </div>
      <span style={{ fontSize: 28, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: statusColor || "#e8eaf6", letterSpacing: "-0.02em", lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "'Space Mono',monospace" }}>{sub}</span>}
      {open && desc && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)", fontSize: 11, color: "rgba(255,255,255,0.55)", fontFamily: "'Space Mono',monospace", lineHeight: 1.7, whiteSpace: "pre-line" }}>{desc}</div>
      )}
    </div>
  );
};

// ─── InputField ───────────────────────────────────────────────────────────────

const InputField = ({ label, value, onChange, isRate = false, integerRate = false }) => {
  const [open, setOpen] = useState(false);
  const desc = INPUT_DESCRIPTIONS[label];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <label style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</label>
        {desc && (
          <button onClick={() => setOpen(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: open ? "#00e5a0" : "rgba(255,255,255,0.25)", fontSize: 11, fontFamily: "'Space Mono',monospace" }}>
            {open ? "▲" : "▼"}
          </button>
        )}
      </div>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        {!isRate && <span style={{ position: "absolute", left: 10, color: "rgba(255,255,255,0.35)", fontSize: 13, fontFamily: "'Space Mono',monospace", pointerEvents: "none" }}>$</span>}
        <input
          type="number"
          value={isRate ? (integerRate ? Math.round(value * 100) : (value * 100).toFixed(2)) : value}
          onChange={(e) => { const v = parseFloat(e.target.value); if (integerRate) onChange(Math.round(v) / 100); else onChange(isRate ? v / 100 : v); }}
          step={integerRate ? 1 : isRate ? 0.01 : 1000}
          style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: isRate ? "8px 28px 8px 10px" : "8px 10px 8px 22px", color: "#e8eaf6", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none" }}
          onFocus={(e) => (e.target.style.borderColor = "rgba(0,229,160,0.4)")}
          onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
        />
        {isRate && <span style={{ position: "absolute", right: 10, color: "rgba(255,255,255,0.35)", fontSize: 12, fontFamily: "'Space Mono',monospace", pointerEvents: "none" }}>%</span>}
      </div>
      {open && desc && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "'Space Mono',monospace", lineHeight: 1.7, background: "rgba(0,229,160,0.04)", border: "1px solid rgba(0,229,160,0.12)", borderRadius: 6, padding: "10px 12px", whiteSpace: "pre-line" }}>{desc}</div>
      )}
    </div>
  );
};

// ─── GoNoGo Banner ────────────────────────────────────────────────────────────

const GoNoGoBanner = ({ verdictKey, dPayback, confidenceNPV }) => {
  const cfg = VERDICT_CONFIG[verdictKey] || VERDICT_CONFIG["NO-GO"];
  return (
    <div style={{ background: cfg.bg, border: `2px solid ${cfg.border}`, borderRadius: 16, padding: "24px 32px", display: "flex", alignItems: "center", gap: 24, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 0% 50%,${cfg.color}08,transparent 60%)`, pointerEvents: "none" }} />
      <div style={{ width: 72, height: 72, borderRadius: "50%", border: `3px solid ${cfg.color}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 0 28px ${cfg.color}30`, background: `${cfg.color}10` }}>
        <span style={{ fontSize: 28, color: cfg.color }}>{cfg.icon}</span>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 24, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 800, color: cfg.color, letterSpacing: "0.04em", lineHeight: 1.15 }}>{cfg.label}</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontFamily: "'Space Mono',monospace", marginTop: 5 }}>{cfg.desc}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0, minWidth: 280 }}>
        {[
          { label: "Discounted Payback < 2.5 years", ok: dPayback !== null && dPayback < 2.5 },
          { label: "NPV > 0", ok: confidenceNPV !== null && confidenceNPV > 0 },
        ].map(({ label, ok }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, background: ok ? "rgba(0,229,160,0.06)" : "rgba(255,77,109,0.06)", border: `1px solid ${ok ? "rgba(0,229,160,0.2)" : "rgba(255,77,109,0.2)"}`, borderRadius: 8, padding: "8px 14px" }}>
            <span style={{ fontSize: 16, color: ok ? "#00e5a0" : "#ff4d6d", flexShrink: 0 }}>{ok ? "✓" : "✗"}</span>
            <span style={{ fontSize: 11, color: ok ? "#00e5a0" : "#ff4d6d", fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function CapExAnalyzer() {
  const [state, setState] = useState(DEFAULT);
  const [yearCFs, setYearCFs] = useState({ y1: DEFAULT.cashflows[0], y2: DEFAULT.cashflows[1], y3: DEFAULT.cashflows[2] });

  const parsedCashflows = useMemo(() => (
    [yearCFs.y1, yearCFs.y2, yearCFs.y3].map(v => Math.round(Number(v))).filter(v => !isNaN(v) && v !== 0)
  ), [yearCFs]);

  // Fractional months based on start month
  // Y0: months from startMonth to December = (12 - startMonth + 1)
  // Y1, Y2: always 12 months
  // Y3: months from January to startMonth-1 = (startMonth - 1)
  const adjustedCashflows = useMemo(() => {
    if (parsedCashflows.length === 0) return [];
    const m = state.startMonth;
    if (m === 1) return parsedCashflows; // January = no adjustment needed
    const y0Months = 12 - m + 1;
    const y3Months = m - 1;
    return [
      Math.round(parsedCashflows[0] * y0Months / 12),   // Y0 partial
      parsedCashflows[0],                                 // Y1 full
      parsedCashflows[1] || 0,                           // Y2 full
      Math.round((parsedCashflows[2] || parsedCashflows[1] || parsedCashflows[0]) * y3Months / 12), // Y3 partial
    ];
  }, [parsedCashflows, state.startMonth]);

  // allCashflows: [Y0_investment+partial, Y1, Y2, Y3_partial]
  // If January: Y0 = just investment, Y1/Y2/Y3 full
  // If other month: Y0 = investment + partial entitlement (t=0, no discount), Y1/Y2 full, Y3 partial
  const allCashflows = useMemo(() => {
    if (parsedCashflows.length === 0) return [-state.initialInvestment];
    const m = state.startMonth;
    if (m === 1) {
      return [-state.initialInvestment, ...parsedCashflows];
    }
    const [y0Ent, y1, y2, y3] = adjustedCashflows;
    return [-state.initialInvestment + y0Ent, y1, y2, y3];
  }, [state.initialInvestment, parsedCashflows, adjustedCashflows, state.startMonth]);

  const metrics = useMemo(() => {
    if (parsedCashflows.length === 0) return null;
    const npv = calcNPV(state.wacc, allCashflows);
    const irr = calcIRR(allCashflows);
    const payback = calcPayback(allCashflows);
    const dPayback = calcDiscountedPayback(allCashflows, state.wacc);
    // Total actual inflows = all cashflows except Y0 investment
    const totalInflows = allCashflows.slice(1).reduce((a, b) => a + b, 0)
      + (state.startMonth > 1 && adjustedCashflows.length > 0 ? adjustedCashflows[0] : 0);
    const roi = (totalInflows - state.initialInvestment) / state.initialInvestment;
    const confidenceNPV = npv * state.confidenceFactor;
    return { npv, irr, payback, dPayback, roi, confidenceNPV };
  }, [allCashflows, state, parsedCashflows, adjustedCashflows]);

  const verdictKey = useMemo(() => calcVerdict(metrics?.dPayback ?? null), [metrics]);

  const cfSummary = useMemo(() => {
    if (!parsedCashflows.length) return null;
    const vals = parsedCashflows;
    const total = vals.reduce((a, b) => a + b, 0);
    const avg = total / vals.length;
    const growth = vals.length >= 2 ? (vals[vals.length - 1] - vals[0]) / Math.abs(vals[0]) : null;
    const maxVal = Math.max(...vals);
    const trend = vals.every((v, i) => i === 0 || v > vals[i - 1]) ? "↑ Growing"
      : vals.every((v, i) => i === 0 || v < vals[i - 1]) ? "↓ Declining"
      : vals.every((v, i) => i === 0 || v === vals[i - 1]) ? "→ Stable"
      : "~ Irregular";
    const trendColor = trend.startsWith("↑") ? "#00e5a0" : trend.startsWith("↓") ? "#ff4d6d" : trend.startsWith("→") ? "#0096ff" : "#ffd166";
    return { vals, total, avg, growth, maxVal, trend, trendColor };
  }, [parsedCashflows]);

  const entitlementChartData = useMemo(() => {
    const m = state.startMonth;
    const y0Months = m === 1 ? 0 : (12 - m + 1);
    const y3Months = m === 1 ? 12 : (m - 1);
    let cum = 0, cumDisc = 0;
    return allCashflows.map((cf, t) => {
      cum += cf;
      cumDisc += cf / Math.pow(1 + state.wacc, t);
      const isY0 = t === 0;
      const isY3 = t === allCashflows.length - 1 && m > 1;
      const months = isY0 ? y0Months : isY3 ? y3Months : 12;
      const label = isY0
        ? (m === 1 ? "Y0" : `Y0 (${y0Months}m)`)
        : isY3
        ? `Y3 (${y3Months}m)`
        : `Y${t}`;
      return {
        year: label,
        investment: isY0 ? -state.initialInvestment : null,
        partial: isY0 && m > 1 ? Math.round(adjustedCashflows[0]) : null,
        entitlement: !isY0 ? Math.round(cf) : null,
        cumulative: Math.round(cum),
        discounted: Math.round(cumDisc),
        isPartialYear: (isY0 && m > 1) || isY3,
        months,
      };
    });
  }, [allCashflows, state.wacc, state.startMonth, state.initialInvestment, adjustedCashflows]);

  const sensitivityData = useMemo(() => (
    WACC_RANGE.map(r => ({ wacc: `${(r * 100).toFixed(0)}%`, npv: Math.round(calcNPV(r, allCashflows)) }))
  ), [allCashflows]);

  const reset = () => { setState(DEFAULT); setYearCFs({ y1: DEFAULT.cashflows[0], y2: DEFAULT.cashflows[1], y3: DEFAULT.cashflows[2] }); };
  const update = useCallback((key) => (val) => setState(s => ({ ...s, [key]: val })), []);
  const m = metrics;
  const cfg = VERDICT_CONFIG[verdictKey] || VERDICT_CONFIG["NO-GO"];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080c14; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>

      <div style={{ minHeight: "100vh", background: "#080c14", color: "#e8eaf6", fontFamily: "'Space Mono',monospace", paddingBottom: 60 }}>

        {/* Header */}
        <div style={{ borderBottom: "1px solid rgba(255,153,0,0.15)", padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0a0d14", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* Amazon-style logo mark */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {/* Amazon logo */}
                <img src="https://i.imgur.com/vS9wbFB.png" width="36" height="36" style={{ borderRadius: 6, objectFit: "cover" }} />
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 20, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "#ffffff", letterSpacing: "-0.02em" }}>CapEx Financial Analyzer</span>
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.14em", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>INVESTMENT DECISION FRAMEWORK · AMAZON INTERNAL</div>
                </div>
              </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ padding: "6px 16px", borderRadius: 4, background: cfg.bg, border: `1px solid ${cfg.border}`, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: cfg.color, maxWidth: 320, textAlign: "center", fontFamily: "'Space Mono',monospace" }}>{cfg.label}</div>
            <button onClick={reset}
              style={{ padding: "6px 16px", borderRadius: 4, background: "rgba(255,153,0,0.08)", border: "1px solid rgba(255,153,0,0.25)", color: "#FF9900", fontSize: 11, cursor: "pointer", fontFamily: "'Space Mono',monospace", letterSpacing: "0.06em", fontWeight: 700 }}
              onMouseEnter={e => { e.target.style.background = "rgba(255,153,0,0.15)"; }}
              onMouseLeave={e => { e.target.style.background = "rgba(255,153,0,0.08)"; }}>
              ↺ RESET
            </button>
          </div>
        </div>

        <div style={{ maxWidth: 1400, margin: "0 auto", padding: "28px 32px", display: "flex", flexDirection: "column", gap: 24 }}>

          {/* Banner */}
          <GoNoGoBanner verdictKey={verdictKey} dPayback={m?.dPayback ?? null} confidenceNPV={m?.confidenceNPV ?? null} />

          {/* Main grid */}
          <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 20 }}>

            {/* Input Panel */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 11, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em", textTransform: "uppercase", paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>Project Parameters</div>

              <InputField label="Initial Investment" value={state.initialInvestment} onChange={update("initialInvestment")} />
              <InputField label="WACC" value={state.wacc} onChange={update("wacc")} isRate integerRate />
              <InputField label="Confidence Factor" value={state.confidenceFactor} onChange={v => setState(s => ({ ...s, confidenceFactor: Math.min(1, Math.max(0, v)) }))} isRate integerRate />
              {/* Confidence Level Indicator */}
              {(() => {
                const pct = Math.round(state.confidenceFactor * 100);
                const level = pct >= 90 ? { label: "VERY HIGH", color: "#00e5a0", desc: "Board-level standard · Contractually committed" }
                  : pct >= 80 ? { label: "HIGH", color: "#00e5a0", desc: "Acceptable for internal CapEx approval" }
                  : pct >= 70 ? { label: "MEDIUM", color: "#ffd166", desc: "Requires sensitivity analysis & mitigation plan" }
                  : { label: "LOW — SPECULATIVE", color: "#ff4d6d", desc: "Business case should not proceed without de-risking" };
                const filled = Math.round(pct / 10);
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: -6, padding: "10px 12px", background: `${level.color}08`, border: `1px solid ${level.color}25`, borderRadius: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: level.color, fontFamily: "'Space Mono',monospace", letterSpacing: "0.06em" }}>{level.label}</span>
                      <span style={{ fontSize: 11, color: level.color, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{pct}%</span>
                    </div>
                    <div style={{ display: "flex", gap: 3 }}>
                      {Array.from({ length: 10 }).map((_, i) => (
                        <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i < filled ? level.color : "rgba(255,255,255,0.08)", transition: "background 0.2s" }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "'Space Mono',monospace", lineHeight: 1.4 }}>{level.desc}</span>
                  </div>
                );
              })()}

              {/* 3YF Entitlement */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" }}>3YF Entitlement</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {["y1","y2","y3"].map((key, i) => (
                    <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", textAlign: "center" }}>YEAR {i + 1}</span>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)", fontSize: 11, pointerEvents: "none" }}>$</span>
                        <input type="number" value={yearCFs[key]}
                          onChange={e => setYearCFs(p => ({ ...p, [key]: e.target.value }))}
                          placeholder="0"
                          style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "8px 8px 8px 20px", color: "#e8eaf6", fontSize: 12, fontFamily: "'Space Mono',monospace", outline: "none", textAlign: "right" }}
                          onFocus={e => (e.target.style.borderColor = "rgba(0,229,160,0.4)")}
                          onBlur={e => (e.target.style.borderColor = "rgba(255,255,255,0.1)")} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Start Month Selector */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "rgba(255,153,0,0.05)", border: "1px solid rgba(255,153,0,0.2)", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label style={{ fontSize: 10, color: "#FF9900", letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>Entitlement Start Month (Y0)</label>
                  </div>
                  <select value={state.startMonth}
                    onChange={e => setState(s => ({ ...s, startMonth: parseInt(e.target.value) }))}
                    style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 7, padding: "8px 10px", color: "#e8eaf6", fontSize: 12, fontFamily: "'Space Mono',monospace", outline: "none", cursor: "pointer" }}>
                    {MONTHS.map((mo, i) => <option key={i} value={i + 1} style={{ background: "#0d1520" }}>{mo}</option>)}
                  </select>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", lineHeight: 1.5 }}>
                    Entitlement starts materialising in Y0. The 3YF window ends on the same month in Y3.
                  </span>
                  {state.startMonth > 1 && parsedCashflows.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginTop: 2 }}>
                      {[
                        { label: `Y0 (${12 - state.startMonth + 1}m)`, value: fmt(adjustedCashflows[0] || 0, 0), color: "rgba(0,229,160,0.7)" },
                        { label: "Y1 (12m)", value: fmt(adjustedCashflows[1] || 0, 0), color: "#e8eaf6" },
                        { label: "Y2 (12m)", value: fmt(adjustedCashflows[2] || 0, 0), color: "#e8eaf6" },
                        { label: `Y3 (${state.startMonth - 1}m)`, value: fmt(adjustedCashflows[3] || 0, 0), color: "rgba(0,229,160,0.7)" },
                      ].map(({ label, value, color }) => (
                        <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2, textAlign: "center" }}>
                          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", textTransform: "uppercase" }}>{label}</span>
                          <span style={{ fontSize: 10, color, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>
                </span>

                {/* Mini summary */}
                {cfSummary && (
                  <div style={{ background: "rgba(0,229,160,0.04)", border: "1px solid rgba(0,229,160,0.1)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      {[
                        { label: "3YF Total", value: fmt(cfSummary.total) },
                        { label: "Avg / Year", value: fmt(cfSummary.avg) },
                        { label: "Trend", value: cfSummary.trend, color: cfSummary.trendColor },
                      ].map(({ label, value, color }) => (
                        <div key={label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", textTransform: "uppercase" }}>{label}</span>
                          <span style={{ fontSize: 12, color: color || "#e8eaf6", fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700 }}>{value}</span>
                        </div>
                      ))}
                    </div>
                    {cfSummary.growth !== null && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", textTransform: "uppercase" }}>Growth Y1→Y{cfSummary.vals.length}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: cfSummary.growth >= 0 ? "#00e5a0" : "#ff4d6d", background: cfSummary.growth >= 0 ? "rgba(0,229,160,0.1)" : "rgba(255,77,109,0.1)", border: `1px solid ${cfSummary.growth >= 0 ? "rgba(0,229,160,0.2)" : "rgba(255,77,109,0.2)"}`, borderRadius: 4, padding: "2px 6px" }}>
                          {cfSummary.growth >= 0 ? "+" : ""}{(cfSummary.growth * 100).toFixed(1)}%
                        </span>
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", textTransform: "uppercase" }}>Entitlement Profile</span>
                      <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 36 }}>
                        {cfSummary.vals.map((v, i) => {
                          const pct = cfSummary.maxVal > 0 ? (v / cfSummary.maxVal) * 100 : 0;
                          return (
                            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
                              <span style={{ fontSize: 8, color: "rgba(255,255,255,0.5)", fontFamily: "'Space Mono',monospace", marginBottom: 2, whiteSpace: "nowrap" }}>{fmt(v, 0)}</span>
                              <div style={{ width: "100%", height: `${Math.max(pct, 8)}%`, background: v >= 0 ? "rgba(0,229,160,0.5)" : "rgba(255,77,109,0.5)", borderRadius: "3px 3px 0 0", transition: "height 0.3s ease" }} />
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {cfSummary.vals.map((_, i) => <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 8, color: "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace" }}>Y{i + 1}</div>)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Metrics Panel */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {m ? (
                <>
                  <div style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "#00e5a0", letterSpacing: "0.12em", textTransform: "uppercase", paddingLeft: 2 }}>▶ Core Metrics</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }}>
                    <MetricCard label="NPV" value={fmt(m.npv)} sub={m.npv > 0 ? "Positive — value created" : "Negative — destroys value"} highlight={m.npv > 0} verdictKey={m.npv > 0 ? "GO" : "NO-GO"} />
                    <MetricCard label="Discounted Payback" value={fmtPayback(m.dPayback)} sub={m.dPayback !== null && m.dPayback < 2.5 ? "Within GO threshold" : m.dPayback !== null && m.dPayback <= 3 ? "Requires alignment" : "Not recovered within 3 yrs"} verdictKey={m.dPayback !== null && m.dPayback < 2.5 ? "GO" : m.dPayback !== null && m.dPayback <= 3 ? "AMBER_PAYBACK" : "NO-GO"} />
                    <MetricCard label="ROI" value={m.roi !== null ? `${(m.roi * 100).toFixed(1)}%` : "N/A"} sub="Total return on investment" verdictKey={m.roi > 0 ? "GO" : "NO-GO"} />
                  </div>

                  <div style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", textTransform: "uppercase", paddingLeft: 2, marginTop: 4 }}>▶ Secondary Metrics</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }}>
                    <MetricCard label="IRR" value={fmtPct(m.irr)} sub={`vs WACC ${fmtPct(state.wacc)}`} verdictKey={m.irr !== null && m.irr > state.wacc ? "GO" : "NO-GO"} />
                    <MetricCard label="Simple Payback" value={fmtPayback(m.payback)} sub={m.payback === null ? "Not recovered within 3 yrs" : "Undiscounted recovery"} verdictKey={m.payback !== null && m.payback < 2.5 ? "GO" : m.payback !== null && m.payback <= 3 ? "AMBER_PAYBACK" : "NO-GO"} />
                  </div>

                  <div style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", textTransform: "uppercase", paddingLeft: 2, marginTop: 4 }}>▶ Risk Metrics</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }}>
                    <MetricCard label="Confidence NPV" value={fmt(m.confidenceNPV)} sub={`@ ${fmtPct(state.confidenceFactor)} confidence`} verdictKey={m.confidenceNPV > 0 ? "GO" : "NO-GO"} />
                  </div>
                </>
              ) : (
                <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", padding: 60, fontSize: 13 }}>Enter valid entitlement values to compute metrics</div>
              )}
            </div>
          </div>

          {/* Charts */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

            {/* Chart 1 */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "22px 22px 12px" }}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>Annual Entitlement + Cumulative</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                  Y0 = CapEx investment · Y1–Y3 = annual entitlement · Line = cumulative
                </div>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={entitlementChartData} margin={{ top: 16, right: 16, left: 10, bottom: 0 }} barCategoryGap="20%" barGap={0}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="year" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 9, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 0, "")} width={64} />
                  <Tooltip
                    contentStyle={{ background: "#0d1520", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontFamily: "'Space Mono'", fontSize: 11 }}
                    labelStyle={{ color: "rgba(255,255,255,0.7)", marginBottom: 4, fontWeight: 700 }}
                    itemStyle={{ color: "rgba(255,255,255,0.55)" }}
                    formatter={(v, n) => {
                      if (n === "investment") return [<span style={{ color: "#ff4d6d" }}>{fmt(v)}</span>, "CapEx (Y0)"];
                      if (n === "entitlement") return [<span style={{ color: "#00e5a0" }}>{fmt(v)}</span>, "Annual Entitlement"];
                      if (n === "cumulative") return [<span style={{ color: "#00e5a0" }}>{fmt(v)}</span>, "Cumulative"];
                      if (n === "discounted") return [<span style={{ color: "#0096ff" }}>{fmt(v)}</span>, "Disc. Cumulative"];
                      return [fmt(v), n];
                    }}
                  />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} />
                  <Bar dataKey="investment" stackId="main" fill="rgba(255,77,109,0.6)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="partial" stackId="main" fill="rgba(0,229,160,0.35)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="entitlement" stackId="main" radius={[4, 4, 0, 0]}>
                    {entitlementChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.isPartialYear ? "rgba(0,229,160,0.35)" : "rgba(0,229,160,0.6)"} />
                    ))}
                  </Bar>
                  <Line type="monotone" dataKey="cumulative" stroke="#00e5a0" strokeWidth={2.5} dot={{ fill: "#00e5a0", r: 4, strokeWidth: 0 }} activeDot={{ r: 6 }} />
                  <Line type="monotone" dataKey="discounted" stroke="#0096ff" strokeWidth={2} strokeDasharray="5 4" dot={{ fill: "#0096ff", r: 3, strokeWidth: 0 }} />
                </ComposedChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 14, marginTop: 8, justifyContent: "center", flexWrap: "wrap" }}>
                {[
                  { color: "rgba(255,77,109,0.6)", label: "CapEx (Y0)", box: true },
                  { color: "rgba(0,229,160,0.6)", label: "Full year entitlement", box: true },
                  { color: "rgba(0,229,160,0.35)", label: "Partial year", box: true },
                  { color: "#00e5a0", label: "Cumulative" },
                  { color: "#0096ff", label: "Disc. Cumulative", dashed: true },
                ].map(({ color, label, dashed, box }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    {box
                      ? <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                      : <div style={{ width: 18, height: 2, ...(dashed ? { backgroundImage: `repeating-linear-gradient(90deg,${color} 0,${color} 4px,transparent 4px,transparent 8px)` } : { background: color }) }} />
                    }
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono'" }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Chart 2 */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "22px 22px 12px" }}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>NPV Sensitivity vs WACC</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                  Green = profitable · Red = value destroying · Yellow = your WACC
                  {m?.irr != null && <span style={{ color: m.irr > state.wacc ? "#00e5a0" : "#ff4d6d", marginLeft: 6, fontWeight: 700 }}>· IRR = {fmtPct(m.irr)}{m.irr < state.wacc ? " ✗ Below WACC" : ""}</span>}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={sensitivityData} margin={{ top: 16, right: 16, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <ReferenceArea y1={0} y2={Math.max(...sensitivityData.map(d => d.npv))} fill="rgba(0,229,160,0.05)" />
                  <ReferenceArea y1={Math.min(...sensitivityData.map(d => d.npv))} y2={0} fill="rgba(255,77,109,0.05)" />
                  <XAxis dataKey="wacc" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} interval={1} />
                  <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 9, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 0, "")} width={64} />
                  <Tooltip
                    contentStyle={{ background: "#0d1520", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontFamily: "'Space Mono'", fontSize: 11 }}
                    formatter={v => [<span style={{ color: v >= 0 ? "#00e5a0" : "#ff4d6d" }}>{fmt(v)}</span>, v >= 0 ? "NPV ✓ Profitable" : "NPV ✗ Unprofitable"]}
                  />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} label={{ value: "NPV=0", fill: "rgba(255,255,255,0.3)", fontSize: 9, position: "insideTopRight" }} />
                  <ReferenceLine x={`${(state.wacc * 100).toFixed(0)}%`} stroke="#ffd166" strokeDasharray="5 4" strokeWidth={2} label={{ value: `Your WACC ${fmtPct(state.wacc)}`, fill: "#ffd166", fontSize: 9, position: "insideTopLeft" }} />
                  <Line type="monotone" dataKey="npv" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: "#00e5a0" }} stroke="#00e5a0" />
                </LineChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 14, marginTop: 8, justifyContent: "center" }}>
                {[
                  { color: "rgba(0,229,160,0.4)", label: "Profitable zone", box: true },
                  { color: "rgba(255,77,109,0.4)", label: "Unprofitable zone", box: true },
                  { color: "#ffd166", label: "Current WACC", dashed: true },
                ].map(({ color, label, dashed, box }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    {box
                      ? <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                      : <div style={{ width: 18, height: 2, backgroundImage: `repeating-linear-gradient(90deg,${color} 0,${color} 4px,transparent 4px,transparent 8px)` }} />
                    }
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono'" }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{ textAlign: "center", color: "rgba(255,255,255,0.18)", fontSize: 10, letterSpacing: "0.06em", marginTop: 4 }}>
            CAPEX ANALYZER · ALL FIGURES IN USD · NPV / IRR / ROI / PAYBACK / CONFIDENCE NPV · FOR DECISION SUPPORT ONLY
          </div>

        </div>
      </div>
    </>
  );
}
