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
  riskCategory: "low",
  cashflows: [420000, 420000, 420000],
  startMonth: 1,
};

const RISK_PREMIUMS = { low: 0, medium: 0.025, high: 0.05 };
const RISK_CONFIG = {
  low:    { label: "Low",    color: "#1D9E75", bg: "rgba(29,158,117,0.08)",  border: "rgba(29,158,117,0.3)",  premium: "+0%",   desc: "Committed baseline. Proven technology. Low execution variance." },
  medium: { label: "Medium", color: "#BA7517", bg: "rgba(186,117,23,0.08)",  border: "rgba(186,117,23,0.3)",  premium: "+2.5%", desc: "Reasonable assumptions. Some execution risk or dependencies." },
  high:   { label: "High",   color: "#A32D2D", bg: "rgba(163,45,45,0.08)",   border: "rgba(163,45,45,0.3)",   premium: "+5%",   desc: "Uncertain forecast. New technology or significant dependencies." },
};

const WACC_RANGE = Array.from({ length: 21 }, (_, i) => i * 0.01 + 0.02);

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];
// startMonth=0 is the special "January Y+1" case — no Y0 entitlement, full Y1/Y2/Y3

// ─── Descriptions ─────────────────────────────────────────────────────────────

const METRIC_DESCRIPTIONS = {
  "NPV": "How much real value the project creates today, after discounting future entitlement at the effective WACC (base WACC + risk premium). A positive NPV means the project generates net value on top of repaying all capital costs. This is the single most important metric.",
  "Discounted Payback": "How many years to recover your investment using the real value of money (discounted at the effective WACC).\n• GO: < 2.5 years\n• Requires Financial Strategic Alignment: 2.5–3 years\n• NO-GO: > 3 years",
  "ROI": "Total return on the investment without adjusting for time. An ROI of 50% means you recover the investment and earn an additional 50%. Easy to communicate to any stakeholder.",
  "IRR": "The project's intrinsic annual return rate. If it exceeds the effective WACC, the project earns more than it costs to fund.",
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

const GoNoGoBanner = ({ verdictKey, dPayback, npv }) => {
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
          { label: "NPV > 0", ok: npv !== null && npv > 0 },
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

  const effectiveWACC = useMemo(() => state.wacc + RISK_PREMIUMS[state.riskCategory], [state.wacc, state.riskCategory]);

  const parsedCashflows = useMemo(() => (
    [yearCFs.y1, yearCFs.y2, yearCFs.y3].map(v => Math.round(Number(v))).filter(v => !isNaN(v) && v !== 0)
  ), [yearCFs]);

  const adjustedCashflows = useMemo(() => {
    const m = state.startMonth;
    // startMonth=0 → January Y+1: no Y0 entitlement, full Y1/Y2/Y3
    if (m === 0) {
      if (parsedCashflows.length === 0) return { y0Ent: 0, y1: 0, y2: 0, y3: 0, y0Months: 0, y3Months: 12 };
      const annual = parsedCashflows[0];
      return {
        y0Ent: 0,
        y1: annual,
        y2: parsedCashflows[1] || annual,
        y3: parsedCashflows[2] || parsedCashflows[1] || annual,
        y0Months: 0,
        y3Months: 12,
      };
    }
    const y0Months = 12 - m + 1;
    const y3Months = m - 1;
    if (parsedCashflows.length === 0) return { y0Ent: 0, y1: 0, y2: 0, y3: 0, y0Months, y3Months };
    const annual = parsedCashflows[0];
    const y0Ent = Math.round(annual * y0Months / 12);
    const y1    = annual;
    const y2    = parsedCashflows[1] || annual;
    const y3    = Math.round((parsedCashflows[2] || parsedCashflows[1] || annual) * y3Months / 12);
    return { y0Ent, y1, y2, y3, y0Months, y3Months };
  }, [parsedCashflows, state.startMonth]);

  const allCashflows = useMemo(() => {
    if (parsedCashflows.length === 0) return [-state.initialInvestment];
    const { y0Ent, y1, y2, y3 } = adjustedCashflows;
    const m = state.startMonth;
    // January Y+1: no Y0 entitlement, full Y1/Y2/Y3
    if (m === 0) return [-state.initialInvestment, y1, y2, y3];
    // January Y0: full Y0 entitlement, no Y3
    const flows = [-state.initialInvestment + y0Ent, y1, y2];
    if (m > 1 && y3 > 0) flows.push(y3);
    return flows;
  }, [state.initialInvestment, parsedCashflows, adjustedCashflows, state.startMonth]);

  const metrics = useMemo(() => {
    if (parsedCashflows.length === 0) return null;
    const npv      = calcNPV(effectiveWACC, allCashflows);
    const irr      = calcIRR(allCashflows);
    const payback  = calcPayback(allCashflows);
    const dPayback = calcDiscountedPayback(allCashflows, effectiveWACC);
    const { y0Ent, y1, y2, y3 } = adjustedCashflows;
    const totalInflows = y0Ent + y1 + y2 + (state.startMonth !== 1 ? y3 : 0);
    const roi = (totalInflows - state.initialInvestment) / state.initialInvestment;
    return { npv, irr, payback, dPayback, roi };
  }, [allCashflows, effectiveWACC, state, parsedCashflows, adjustedCashflows]);

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
    const { y0Months, y3Months, y0Ent } = adjustedCashflows;
    let cum = 0, cumDisc = 0;
    return allCashflows.map((cf, t) => {
      cum += cf;
      cumDisc += cf / Math.pow(1 + effectiveWACC, t);
      const isY0 = t === 0;
      const isY3 = t === allCashflows.length - 1 && (m > 1 || m === 0) && t >= 3;
      const label = isY0
        ? (m === 0 ? "Y0 (0m)" : `Y0 (${y0Months}m)`)
        : isY3 && m > 1 ? `Y3 (${y3Months}m)`
        : `Y${t}`;
      return {
        year: label,
        investment: isY0 ? -state.initialInvestment : null,
        partial: isY0 && y0Ent > 0 ? y0Ent : null,
        entitlement: !isY0 ? Math.round(cf) : null,
        cumulative: Math.round(cum),
        discounted: Math.round(cumDisc),
        isPartialYear: (isY0 && m !== 0) || (isY3 && m > 1),
      };
    });
  }, [allCashflows, effectiveWACC, state.startMonth, state.initialInvestment, adjustedCashflows]);

  const sensitivityData = useMemo(() => (
    WACC_RANGE.map(r => ({ wacc: `${(r * 100).toFixed(0)}%`, npv: Math.round(calcNPV(r, allCashflows)) }))
  ), [allCashflows]);

  const generatePDF = () => {
    if (!m) return;
    const rc = RISK_CONFIG[state.riskCategory];
    const effW = (effectiveWACC * 100).toFixed(1);
    const monthLabel = state.startMonth === 0 ? "January (Y+1)" : MONTHS[state.startMonth - 1] + " (Y0)";
    const vCfg = VERDICT_CONFIG[verdictKey];
    const vColor = verdictKey === "GO" ? "#1a7a4a" : verdictKey === "AMBER_PAYBACK" ? "#a06000" : "#8b1a1a";
    const vBg    = verdictKey === "GO" ? "#e6f9f0" : verdictKey === "AMBER_PAYBACK" ? "#fff8e6" : "#fde8e8";
    const date   = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    const row = (label, value, sub) => [
      "<tr>",
      "<td style='padding:10px 14px;font-size:13px;color:#555;border-bottom:1px solid #f0f0f0;'>" + label + "</td>",
      "<td style='padding:10px 14px;font-size:14px;font-weight:700;color:#111;text-align:right;border-bottom:1px solid #f0f0f0;'>" + value + (sub ? "<div style='font-size:10px;font-weight:400;color:#888;margin-top:2px'>" + sub + "</div>" : "") + "</td>",
      "</tr>"
    ].join("");

    const irow = (label, value) =>
      "<div style='display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:13px;'><span style='color:#555'>" + label + "</span><span style='font-weight:700;color:#111'>" + value + "</span></div>";

    const dpbSub = m.dPayback < 2.5 ? "Within GO threshold" : m.dPayback <= 3 ? "Requires alignment" : "Exceeds 3yr threshold";
    const y3Label = "Y3 (" + adjustedCashflows.y3Months + "m)";
    const y0Label = "Y0 (" + adjustedCashflows.y0Months + "m)";

    const html = [
      "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>CapEx Analysis</title>",
      "<style>body{font-family:Arial,sans-serif;margin:0;padding:40px;color:#111;background:#fff}",
      "@media print{body{padding:20px}}",
      "h1{font-size:22px;margin:0 0 4px;color:#111}.subtitle{font-size:11px;color:#888;letter-spacing:.1em;text-transform:uppercase;margin-bottom:24px}",
      ".verdict{display:inline-block;padding:8px 20px;border-radius:6px;font-size:14px;font-weight:700;letter-spacing:.06em;margin-bottom:8px}",
      ".st{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin:20px 0 8px;font-weight:700}",
      "table{width:100%;border-collapse:collapse;background:#fafafa;border-radius:8px;overflow:hidden;margin-bottom:16px}",
      ".grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}",
      ".box{background:#fafafa;border-radius:8px;padding:12px 14px}",
      ".footer{margin-top:40px;font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:12px;display:flex;justify-content:space-between}",
      "</style></head><body>",
      "<div style='display:flex;align-items:center;gap:12px;margin-bottom:6px'>",
      "<img src='https://i.imgur.com/vS9wbFB.png' width='36' height='36' style='border-radius:6px'>",
      "<div><h1>CapEx Financial Analyzer</h1><div class='subtitle'>Investment Decision Framework · Amazon Internal</div></div></div>",
      "<div class='verdict' style='background:" + vBg + ";color:" + vColor + ";border:1.5px solid " + vColor + "40'>" + vCfg.label + "</div>",
      "<div style='font-size:12px;color:#555;margin-bottom:24px'>" + vCfg.desc + "</div>",
      "<div class='grid'>",
      "<div><div class='st'>Project Parameters</div><div class='box'>",
      irow("Initial Investment", fmt(state.initialInvestment)),
      irow("Base WACC", (state.wacc * 100).toFixed(1) + "%"),
      irow("Risk Category", rc.label + " (" + rc.premium + ")"),
      irow("Effective WACC", effW + "%"),
      irow("Start Month", monthLabel),
      irow("Y1 Entitlement", fmt(yearCFs.y1) + "/yr"),
      irow("Y2 Entitlement", fmt(yearCFs.y2) + "/yr"),
      irow("Y3 Entitlement", fmt(yearCFs.y3) + "/yr"),
      "</div></div>",
      "<div><div class='st'>Adjusted 3YF Window</div><div class='box'>",
      irow(y0Label, adjustedCashflows.y0Ent > 0 ? fmt(adjustedCashflows.y0Ent) : "—"),
      irow("Y1 (12m)", fmt(adjustedCashflows.y1)),
      irow("Y2 (12m)", fmt(adjustedCashflows.y2)),
      irow(y3Label, adjustedCashflows.y3 > 0 ? fmt(adjustedCashflows.y3) : "—"),
      "</div></div></div>",
      "<div class='st'>Core Metrics</div><table>",
      row("NPV", fmt(m.npv), m.npv > 0 ? "Positive — value created" : "Negative — destroys value"),
      row("Discounted Payback", fmtPayback(m.dPayback), dpbSub),
      row("ROI", (m.roi * 100).toFixed(1) + "%", "Total return on investment"),
      "</table>",
      "<div class='st'>Secondary Metrics</div><table>",
      row("IRR", m.irr !== null ? fmtPct(m.irr) : "N/A", "vs effective WACC " + effW + "%"),
      row("Simple Payback", fmtPayback(m.payback), "Undiscounted recovery"),
      "</table>",
      "<div class='footer'><span>Amazon AMET · CapEx Financial Analyzer</span><span>Generated " + date + "</span></div>",
      "<script>window.onload=function(){window.print();}<\/script>",
      "</body></html>"
    ].join("");

    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
  };

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
            <button onClick={generatePDF}
              style={{ padding: "6px 16px", borderRadius: 4, background: "rgba(0,150,255,0.08)", border: "1px solid rgba(0,150,255,0.25)", color: "#0096ff", fontSize: 11, cursor: "pointer", fontFamily: "'Space Mono',monospace", letterSpacing: "0.06em", fontWeight: 700 }}
              onMouseEnter={e => { e.target.style.background = "rgba(0,150,255,0.15)"; }}
              onMouseLeave={e => { e.target.style.background = "rgba(0,150,255,0.08)"; }}>
              ↓ PDF
            </button>
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
          <GoNoGoBanner verdictKey={verdictKey} dPayback={m?.dPayback ?? null} npv={m?.npv ?? null} />

          {/* Main grid */}
          <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 20 }}>

            {/* Input Panel */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 11, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em", textTransform: "uppercase", paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>Project Parameters</div>

              <InputField label="Initial Investment" value={state.initialInvestment} onChange={update("initialInvestment")} />
              <InputField label="WACC" value={state.wacc} onChange={update("wacc")} isRate integerRate />

              {/* Risk Category Selector */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "'Space Mono',monospace" }}>Project Risk Category</label>
                  <span style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", color: RISK_CONFIG[state.riskCategory].color, fontWeight: 700 }}>
                    Effective WACC: {((state.wacc + RISK_PREMIUMS[state.riskCategory]) * 100).toFixed(1)}%
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {["low", "medium", "high"].map(cat => {
                    const cfg = RISK_CONFIG[cat];
                    const isSelected = state.riskCategory === cat;
                    return (
                      <div key={cat} onClick={() => setState(s => ({ ...s, riskCategory: cat }))}
                        style={{ cursor: "pointer", borderRadius: 10, padding: "10px 10px", border: `1.5px solid ${isSelected ? cfg.color : "rgba(255,255,255,0.08)"}`, background: isSelected ? cfg.bg : "rgba(255,255,255,0.02)", transition: "all 0.15s" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                          <div style={{ width: 7, height: 7, borderRadius: "50%", background: cfg.color, flexShrink: 0 }} />
                          <span style={{ fontSize: 11, fontWeight: 700, color: isSelected ? cfg.color : "rgba(255,255,255,0.6)", fontFamily: "'Space Mono',monospace" }}>{cfg.label}</span>
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: cfg.color, fontFamily: "'Plus Jakarta Sans',sans-serif", marginBottom: 4 }}>{cfg.premium}</div>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", lineHeight: 1.4 }}>{cfg.desc}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: `${RISK_CONFIG[state.riskCategory].color}10`, border: `1px solid ${RISK_CONFIG[state.riskCategory].color}30`, borderRadius: 8 }}>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "'Space Mono',monospace" }}>
                    {((state.wacc) * 100).toFixed(1)}% base WACC
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>+</span>
                  <span style={{ fontSize: 10, color: RISK_CONFIG[state.riskCategory].color, fontFamily: "'Space Mono',monospace" }}>
                    {(RISK_PREMIUMS[state.riskCategory] * 100).toFixed(1)}% risk premium
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>=</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: RISK_CONFIG[state.riskCategory].color, fontFamily: "'Space Mono',monospace" }}>
                    {((state.wacc + RISK_PREMIUMS[state.riskCategory]) * 100).toFixed(1)}% effective WACC
                  </span>
                </div>
              </div>

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
                <div style={{ display: "flex", flexDirection: "column", gap: 8, background: "rgba(255,153,0,0.05)", border: "1px solid rgba(255,153,0,0.2)", borderRadius: 8, padding: "10px 12px" }}>
                  <label style={{ fontSize: 10, color: "#FF9900", letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>Entitlement Start Month</label>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5 }}>
                    {[
                      ...["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((mo, i) => ({ label: mo, tag: "Y0", val: i + 1 })),
                      { label: "Jan", tag: "Y+1", val: 0 },
                    ].map(({ label, tag, val }) => {
                      const isSelected = state.startMonth === val;
                      const isY1 = val === 0;
                      const selColor = isY1 ? "#ff4d6d" : "#FF9900";
                      const selBg    = isY1 ? "rgba(255,77,109,0.12)" : "rgba(255,153,0,0.12)";
                      const selBorder= isY1 ? "rgba(255,77,109,0.6)" : "rgba(255,153,0,0.6)";
                      return (
                        <div key={val} onClick={() => setState(s => ({ ...s, startMonth: val }))}
                          style={{ cursor: "pointer", borderRadius: 7, padding: "6px 4px", textAlign: "center", border: `1px solid ${isSelected ? selBorder : "rgba(255,255,255,0.08)"}`, background: isSelected ? selBg : "rgba(255,255,255,0.02)", transition: "all 0.12s" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: isSelected ? selColor : "rgba(255,255,255,0.6)", fontFamily: "'Space Mono',monospace" }}>{label}</div>
                          <div style={{ fontSize: 9, color: isSelected ? selColor : "rgba(255,255,255,0.3)", fontFamily: "'Space Mono',monospace", opacity: isSelected ? 0.8 : 1 }}>{tag}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ padding: "6px 10px", borderRadius: 6, background: state.startMonth === 0 ? "rgba(255,77,109,0.06)" : "rgba(255,153,0,0.06)", border: `1px solid ${state.startMonth === 0 ? "rgba(255,77,109,0.2)" : "rgba(255,153,0,0.2)"}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono',monospace" }}>
                      {state.startMonth === 0
                        ? "No Y0 entitlement — full 3YF runs Y1 → Y3"
                        : state.startMonth === 1
                        ? "Full Y0 entitlement — 3YF ends Dec Y2"
                        : `Y0: ${12 - state.startMonth + 1}m · Y1: 12m · Y2: 12m · Y3: ${state.startMonth - 1}m = 36m`}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: state.startMonth === 0 ? "#ff4d6d" : "#FF9900", fontFamily: "'Space Mono',monospace", flexShrink: 0, marginLeft: 8 }}>
                      {state.startMonth === 0 ? "0m in Y0" : `${12 - state.startMonth + 1}m in Y0`}
                    </span>
                  </div>
                  {parsedCashflows.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: state.startMonth === 0 ? "1fr 1fr 1fr 1fr" : state.startMonth === 1 ? "1fr 1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 6, marginTop: 2 }}>
                      {(state.startMonth === 0 ? [
                        { label: "Y0 (0m)",  value: "—",                                              color: "rgba(255,255,255,0.25)" },
                        { label: "Y1 (12m)", value: fmt(adjustedCashflows.y1 || 0, 0),                color: "#e8eaf6" },
                        { label: "Y2 (12m)", value: fmt(adjustedCashflows.y2 || 0, 0),                color: "#e8eaf6" },
                        { label: "Y3 (12m)", value: fmt(adjustedCashflows.y3 || 0, 0),                color: "#e8eaf6" },
                      ] : state.startMonth === 1 ? [
                        { label: "Y0 (12m)", value: fmt(adjustedCashflows.y0Ent || 0, 0),             color: "rgba(0,229,160,0.7)" },
                        { label: "Y1 (12m)", value: fmt(adjustedCashflows.y1 || 0, 0),                color: "#e8eaf6" },
                        { label: "Y2 (12m)", value: fmt(adjustedCashflows.y2 || 0, 0),                color: "#e8eaf6" },
                      ] : [
                        { label: `Y0 (${adjustedCashflows.y0Months}m)`, value: fmt(adjustedCashflows.y0Ent || 0, 0), color: "rgba(0,229,160,0.7)" },
                        { label: "Y1 (12m)", value: fmt(adjustedCashflows.y1 || 0, 0),                color: "#e8eaf6" },
                        { label: "Y2 (12m)", value: fmt(adjustedCashflows.y2 || 0, 0),                color: "#e8eaf6" },
                        { label: `Y3 (${adjustedCashflows.y3Months}m)`, value: fmt(adjustedCashflows.y3 || 0, 0), color: "rgba(0,229,160,0.7)" },
                      ]).map(({ label, value, color }) => (
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
                    <MetricCard label="IRR" value={m.irr !== null ? fmtPct(m.irr) : "N/A"} sub={`vs effective WACC ${fmtPct(effectiveWACC)}`} verdictKey={m.irr !== null && m.irr > effectiveWACC ? "GO" : "NO-GO"} />
                    <MetricCard label="Simple Payback" value={fmtPayback(m.payback)} sub={m.payback === null ? "Not recovered within 3 yrs" : "Undiscounted recovery"} verdictKey={m.payback !== null && m.payback < 2.5 ? "GO" : m.payback !== null && m.payback <= 3 ? "AMBER_PAYBACK" : "NO-GO"} />
                  </div>

                  {/* Dashboard — charts inline */}
                  <div style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", fontWeight: 700, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", textTransform: "uppercase", paddingLeft: 2, marginTop: 4 }}>▶ Dashboard</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>

                    {/* Chart 1 */}
                    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "16px 16px 10px" }}>
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>Annual Entitlement + Cumulative</div>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>Y0 = CapEx · Y1–Y3 = entitlement · Line = cumulative</div>
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={entitlementChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                          <XAxis dataKey="year" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 9, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 8, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 0, "")} width={54} />
                          <Tooltip contentStyle={{ background: "#0d1520", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontFamily: "'Space Mono'", fontSize: 10 }} labelStyle={{ color: "rgba(255,255,255,0.7)", marginBottom: 4, fontWeight: 700 }} itemStyle={{ color: "rgba(255,255,255,0.55)" }}
                            formatter={(v, n) => {
                              if (n === "investment") return [<span style={{ color: "#ff4d6d" }}>{fmt(v)}</span>, "CapEx (Y0)"];
                              if (n === "entitlement") return [<span style={{ color: "#00e5a0" }}>{fmt(v)}</span>, "Annual Entitlement"];
                              if (n === "cumulative") return [<span style={{ color: "#00e5a0" }}>{fmt(v)}</span>, "Cumulative"];
                              if (n === "discounted") return [<span style={{ color: "#0096ff" }}>{fmt(v)}</span>, "Disc. Cumulative"];
                              return [fmt(v), n];
                            }} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} />
                          <Bar dataKey="investment" stackId="main" fill="rgba(255,77,109,0.6)" radius={[0,0,4,4]} />
                          <Bar dataKey="partial" stackId="main" fill="rgba(0,229,160,0.35)" radius={[4,4,0,0]} />
                          <Bar dataKey="entitlement" stackId="main" radius={[4,4,0,0]}>
                            {entitlementChartData.map((entry, i) => (
                              <Cell key={i} fill={entry.isPartialYear ? "rgba(0,229,160,0.35)" : "rgba(0,229,160,0.6)"} />
                            ))}
                          </Bar>
                          <Line type="monotone" dataKey="cumulative" stroke="#00e5a0" strokeWidth={2} dot={{ fill: "#00e5a0", r: 3, strokeWidth: 0 }} activeDot={{ r: 5 }} />
                          <Line type="monotone" dataKey="discounted" stroke="#0096ff" strokeWidth={1.5} strokeDasharray="5 4" dot={{ fill: "#0096ff", r: 2, strokeWidth: 0 }} />
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div style={{ display: "flex", gap: 10, marginTop: 6, justifyContent: "center", flexWrap: "wrap" }}>
                        {[
                          { color: "rgba(255,77,109,0.6)", label: "CapEx (Y0)", box: true },
                          { color: "rgba(0,229,160,0.6)", label: "Full year", box: true },
                          { color: "rgba(0,229,160,0.35)", label: "Partial year", box: true },
                          { color: "#00e5a0", label: "Cumulative" },
                          { color: "#0096ff", label: "Disc. Cumulative", dashed: true },
                        ].map(({ color, label, dashed, box }) => (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            {box ? <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} /> : <div style={{ width: 14, height: 2, ...(dashed ? { backgroundImage: `repeating-linear-gradient(90deg,${color} 0,${color} 4px,transparent 4px,transparent 8px)` } : { background: color }) }} />}
                            <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono'" }}>{label}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Chart 2 */}
                    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "16px 16px 10px" }}>
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>NPV Sensitivity vs WACC</div>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                          Green = profitable · Red = value destroying · Yellow = your WACC
                          {m?.irr != null && <span style={{ color: m.irr > effectiveWACC ? "#00e5a0" : "#ff4d6d", marginLeft: 4, fontWeight: 700 }}>· IRR = {fmtPct(m.irr)}</span>}
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={sensitivityData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                          <ReferenceArea y1={0} y2={Math.max(...sensitivityData.map(d => d.npv))} fill="rgba(0,229,160,0.05)" />
                          <ReferenceArea y1={Math.min(...sensitivityData.map(d => d.npv))} y2={0} fill="rgba(255,77,109,0.05)" />
                          <XAxis dataKey="wacc" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 9, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} interval={1} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 8, fontFamily: "'Space Mono'" }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 0, "")} width={54} />
                          <Tooltip contentStyle={{ background: "#0d1520", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontFamily: "'Space Mono'", fontSize: 10 }} formatter={v => [<span style={{ color: v >= 0 ? "#00e5a0" : "#ff4d6d" }}>{fmt(v)}</span>, v >= 0 ? "NPV ✓" : "NPV ✗"]} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} label={{ value: "NPV=0", fill: "rgba(255,255,255,0.3)", fontSize: 8, position: "insideTopRight" }} />
                          <ReferenceLine x={`${(effectiveWACC * 100).toFixed(0)}%`} stroke="#ffd166" strokeDasharray="5 4" strokeWidth={2} label={{ value: `Eff. WACC ${fmtPct(effectiveWACC)}`, fill: "#ffd166", fontSize: 8, position: "insideTopLeft" }} />
                          <Line type="monotone" dataKey="npv" strokeWidth={2.5} dot={false} activeDot={{ r: 4, fill: "#00e5a0" }} stroke="#00e5a0" />
                        </LineChart>
                      </ResponsiveContainer>
                      <div style={{ display: "flex", gap: 10, marginTop: 6, justifyContent: "center" }}>
                        {[
                          { color: "rgba(0,229,160,0.4)", label: "Profitable zone", box: true },
                          { color: "rgba(255,77,109,0.4)", label: "Unprofitable zone", box: true },
                          { color: "#ffd166", label: "Current WACC", dashed: true },
                        ].map(({ color, label, dashed, box }) => (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            {box ? <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} /> : <div style={{ width: 14, height: 2, backgroundImage: `repeating-linear-gradient(90deg,${color} 0,${color} 4px,transparent 4px,transparent 8px)` }} />}
                            <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono'" }}>{label}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                  </div>
                </>
              ) : (
                <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", padding: 60, fontSize: 13 }}>Enter valid entitlement values to compute metrics</div>
              )}
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
