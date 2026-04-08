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
  return `${v.toFixed(2)} yrs`;
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

function calcPayback(cashflows, investment, startMonth) {
  const y0Months = startMonth === 0 ? 0 : (startMonth === 1 ? 12 : 13 - startMonth);
  const y0Years  = y0Months / 12;
  if (cashflows[0] >= 0) {
    const y0Ent = cashflows[0] + investment;
    return (investment / y0Ent) * y0Years;
  }
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const prev = cum;
    cum += cashflows[t];
    if (cum >= 0 && t > 0) return y0Years + (t - 1) + Math.abs(prev) / cashflows[t];
  }
  const lastCF = cashflows[cashflows.length - 1];
  if (lastCF > 0 && cum < 0) return y0Years + cashflows.length - 1 + Math.abs(cum) / lastCF;
  return null;
}

function calcDiscountedPayback(cashflows, rate, investment, startMonth) {
  const y0Months = startMonth === 0 ? 0 : (startMonth === 1 ? 12 : 13 - startMonth);
  const y0Years  = y0Months / 12;
  if (cashflows[0] >= 0) {
    const y0Ent = cashflows[0] + investment;
    return (investment / y0Ent) * y0Years;
  }
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const prev = cum;
    const dcf = cashflows[t] / Math.pow(1 + rate, t);
    cum += dcf;
    if (cum >= 0 && t > 0) return y0Years + (t - 1) + Math.abs(prev) / dcf;
  }
  const lastDCF = cashflows[cashflows.length - 1] / Math.pow(1 + rate, cashflows.length - 1);
  if (lastDCF > 0 && cum < 0) return y0Years + cashflows.length - 1 + Math.abs(cum) / lastDCF;
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

// ─── Country WACC Data (Amazon Internal — 30-APR-2025) ────────────────────────
// Tiers: Lowest=12%, Low=13%, Medium=15%, High=21%, Highest=calculated
const WACC_TIERS = {
  lowest: { label: "Lowest Risk", wacc: 12, color: "#0F6E56", bg: "rgba(29,158,117,0.12)" },
  low:    { label: "Low Risk",    wacc: 13, color: "#185FA5", bg: "rgba(55,138,221,0.10)" },
  medium: { label: "Medium Risk", wacc: 15, color: "#854F0B", bg: "rgba(186,117,23,0.10)" },
  high:   { label: "High Risk",   wacc: 21, color: "#A32D2D", bg: "rgba(163,45,45,0.10)" },
  highest:{ label: "Highest Risk",wacc: null, color: "#6B21A8", bg: "rgba(107,33,168,0.10)" },
};

const COUNTRY_WACC = [
  { name: "Australia",                 tier: "lowest",    wacc: 12 },
  { name: "Austria",                   tier: "lowest",    wacc: 12 },
  { name: "Belgium",                   tier: "lowest",    wacc: 12 },
  { name: "Canada",                    tier: "lowest",    wacc: 12 },
  { name: "Croatia",                   tier: "lowest",    wacc: 12 },
  { name: "Cyprus",                    tier: "lowest",    wacc: 12 },
  { name: "Czech Republic",            tier: "lowest",    wacc: 12 },
  { name: "Denmark",                   tier: "lowest",    wacc: 12 },
  { name: "Estonia",                   tier: "lowest",    wacc: 12 },
  { name: "Finland",                   tier: "lowest",    wacc: 12 },
  { name: "France",                    tier: "lowest",    wacc: 12 },
  { name: "Germany",                   tier: "lowest",    wacc: 12 },
  { name: "Greece",                    tier: "lowest",    wacc: 12 },
  { name: "Hong Kong",                 tier: "lowest",    wacc: 12 },
  { name: "Iceland",                   tier: "lowest",    wacc: 12 },
  { name: "Ireland",                   tier: "lowest",    wacc: 12 },
  { name: "Italy",                     tier: "lowest",    wacc: 12 },
  { name: "Japan",                     tier: "lowest",    wacc: 12 },
  { name: "Kuwait",                    tier: "lowest",    wacc: 12 },
  { name: "Latvia",                    tier: "lowest",    wacc: 12 },
  { name: "Luxembourg",                tier: "lowest",    wacc: 12 },
  { name: "Netherlands",               tier: "lowest",    wacc: 12 },
  { name: "New Zealand",               tier: "lowest",    wacc: 12 },
  { name: "Norway",                    tier: "lowest",    wacc: 12 },
  { name: "Portugal",                  tier: "lowest",    wacc: 12 },
  { name: "Qatar",                     tier: "lowest",    wacc: 12 },
  { name: "Singapore",                 tier: "lowest",    wacc: 12 },
  { name: "Slovakia",                  tier: "lowest",    wacc: 12 },
  { name: "Slovenia",                  tier: "lowest",    wacc: 12 },
  { name: "South Korea",               tier: "lowest",    wacc: 12 },
  { name: "Spain",                     tier: "lowest",    wacc: 12 },
  { name: "Sweden",                    tier: "lowest",    wacc: 12 },
  { name: "Switzerland",               tier: "lowest",    wacc: 12 },
  { name: "Taiwan",                    tier: "lowest",    wacc: 12 },
  { name: "UAE",                       tier: "lowest",    wacc: 12 },
  { name: "United Kingdom",            tier: "lowest",    wacc: 12 },
  { name: "United States",             tier: "lowest",    wacc: 12 },
  { name: "Bulgaria",                  tier: "low",       wacc: 13 },
  { name: "Chile",                     tier: "low",       wacc: 13 },
  { name: "China",                     tier: "low",       wacc: 13 },
  { name: "Indonesia",                 tier: "low",       wacc: 13 },
  { name: "Israel",                    tier: "low",       wacc: 13 },
  { name: "Malaysia",                  tier: "low",       wacc: 13 },
  { name: "Mauritius",                 tier: "low",       wacc: 13 },
  { name: "Oman",                      tier: "low",       wacc: 13 },
  { name: "Peru",                      tier: "low",       wacc: 13 },
  { name: "Philippines",               tier: "low",       wacc: 13 },
  { name: "Poland",                    tier: "low",       wacc: 13 },
  { name: "Saudi Arabia",              tier: "low",       wacc: 13 },
  { name: "Thailand",                  tier: "low",       wacc: 13 },
  { name: "Bahrain",                   tier: "medium",    wacc: 15 },
  { name: "Costa Rica",                tier: "medium",    wacc: 15 },
  { name: "Georgia",                   tier: "medium",    wacc: 15 },
  { name: "Guatemala",                 tier: "medium",    wacc: 15 },
  { name: "Hungary",                   tier: "medium",    wacc: 15 },
  { name: "India",                     tier: "medium",    wacc: 15 },
  { name: "Mexico",                    tier: "medium",    wacc: 15 },
  { name: "Morocco",                   tier: "medium",    wacc: 15 },
  { name: "Panama",                    tier: "medium",    wacc: 15 },
  { name: "Serbia",                    tier: "medium",    wacc: 15 },
  { name: "Trinidad and Tobago",       tier: "medium",    wacc: 15 },
  { name: "Uruguay",                   tier: "medium",    wacc: 15 },
  { name: "Vietnam",                   tier: "medium",    wacc: 15 },
  { name: "Azerbaijan",                tier: "high",      wacc: 21 },
  { name: "Brazil",                    tier: "high",      wacc: 21 },
  { name: "Cambodia",                  tier: "high",      wacc: 21 },
  { name: "Colombia",                  tier: "high",      wacc: 21 },
  { name: "Dominican Republic",        tier: "high",      wacc: 21 },
  { name: "Jordan",                    tier: "high",      wacc: 21 },
  { name: "Kazakhstan",                tier: "high",      wacc: 21 },
  { name: "Kenya",                     tier: "high",      wacc: 21 },
  { name: "Romania",                   tier: "high",      wacc: 21 },
  { name: "Rwanda",                    tier: "high",      wacc: 21 },
  { name: "Senegal",                   tier: "high",      wacc: 21 },
  { name: "South Africa",              tier: "high",      wacc: 21 },
  { name: "Turkey",                    tier: "highest",   wacc: 17.68 },
  { name: "Bangladesh",                tier: "highest",   wacc: 18.95 },
  { name: "Nigeria",                   tier: "highest",   wacc: 21.85 },
  { name: "Egypt",                     tier: "highest",   wacc: 22.77 },
  { name: "Tunisia",                   tier: "highest",   wacc: 23.09 },
  { name: "Argentina",                 tier: "highest",   wacc: 23.91 },
  { name: "Angola",                    tier: "highest",   wacc: 25.65 },
  { name: "Pakistan",                  tier: "highest",   wacc: 25.65 },
  { name: "Sri Lanka",                 tier: "highest",   wacc: 29.03 },
  { name: "Ukraine",                   tier: "highest",   wacc: 29.03 },
  { name: "Ecuador",                   tier: "highest",   wacc: 31.64 },
  { name: "Ghana",                     tier: "highest",   wacc: 37.13 },
  { name: "Lebanon",                   tier: "highest",   wacc: 37.52 },
];

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

  const [waccInput, setWaccInput] = useState(String(Math.round(state.wacc * 100)));
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState(null);
  const effectiveWACC = useMemo(() => state.wacc + RISK_PREMIUMS[state.riskCategory], [state.wacc, state.riskCategory]);

  // Keep all 3 values including zeros — zeros are valid (no entitlement that year)
  // Only filter if the field is empty/NaN
  const parsedCashflows = useMemo(() => {
    const vals = [yearCFs.y1, yearCFs.y2, yearCFs.y3].map(v => {
      const n = Math.round(Number(v));
      return isNaN(n) ? null : n;
    });
    // Must have at least Y1 to compute anything
    if (vals[0] === null || vals[0] === 0) return [];
    return [
      vals[0],
      vals[1] !== null ? vals[1] : 0,
      vals[2] !== null ? vals[2] : 0,
    ];
  }, [yearCFs]);

  const adjustedCashflows = useMemo(() => {
    const m = state.startMonth;
    const empty = { y0Ent: 0, y1: 0, y2: 0, y3: 0, y0Months: m === 0 ? 0 : 12 - m + 1, y3Months: m === 0 ? 12 : m - 1 };
    if (parsedCashflows.length === 0) return empty;

    const [y1raw, y2raw, y3raw] = parsedCashflows;

    if (m === 0) {
      // January Y+1: no Y0 entitlement
      return { y0Ent: 0, y1: y1raw, y2: y2raw, y3: y3raw, y0Months: 0, y3Months: 12 };
    }
    const y0Months = 12 - m + 1;
    const y3Months = m - 1;
    return {
      y0Ent: Math.round(y1raw * y0Months / 12),
      y1:    y1raw,
      y2:    y2raw,
      y3:    Math.round(y3raw * y3Months / 12),
      y0Months, y3Months
    };
  }, [parsedCashflows, state.startMonth]);

  // ── Model 2: project years — Y1/Y2/Y3 = 12-month project years from go-live ──
  const allCashflows = useMemo(() => {
    if (parsedCashflows.length === 0) return [-state.initialInvestment];
    const [y1raw, y2raw, y3raw] = parsedCashflows;
    const m = state.startMonth;

    // Jan Y+1: no Y0 entitlement, project years align with calendar years
    if (m === 0) {
      const flows = [-state.initialInvestment, y1raw];
      if (y2raw > 0) flows.push(y2raw);
      if (y3raw > 0) flows.push(y3raw);
      return flows;
    }

    // Jan Y0: full project year 1 in Y0 (12 months, not discounted)
    if (m === 1) {
      const flows = [-state.initialInvestment + y1raw];
      if (y2raw > 0) flows.push(y2raw);
      if (y3raw > 0) flows.push(y3raw);
      return flows;
    }

    // All other months: model 2 — each discount period t=1,2,3 contains
    // the tail of one project year + head of the next.
    // f = fraction of year captured in Y0 (e.g. Jul → 6/12)
    // r = remaining fraction spilling into next period (e.g. Jul → 6/12)
    const f = (13 - m) / 12;
    const r = (m - 1) / 12;
    const y0Ent = Math.round(y1raw * f);           // t=0 (not discounted)
    const p1    = Math.round(y1raw * r + y2raw * f); // t=1
    const p2    = Math.round(y2raw * r + y3raw * f); // t=2
    const p3    = Math.round(y3raw * r);              // t=3
    const flows = [-state.initialInvestment + y0Ent];
    if (p1 > 0) flows.push(p1);
    if (p2 > 0) flows.push(p2);
    if (p3 > 0) flows.push(p3);
    return flows;
  }, [state.initialInvestment, parsedCashflows, state.startMonth]);

  const metrics = useMemo(() => {
    if (parsedCashflows.length === 0) return null;
    const npv      = calcNPV(effectiveWACC, allCashflows);
    const irr      = calcIRR(allCashflows);
    const payback  = calcPayback(allCashflows, state.initialInvestment, state.startMonth);
    const dPayback = calcDiscountedPayback(allCashflows, effectiveWACC, state.initialInvestment, state.startMonth);
    const [y1raw, y2raw, y3raw] = parsedCashflows;
    // ROI uses total project entitlement (3 full project years), undiscounted
    const totalInflows = y1raw + y2raw + y3raw;
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
    const rc    = RISK_CONFIG[state.riskCategory];
    const effW  = (effectiveWACC * 100).toFixed(1);
    const mL    = state.startMonth === 0 ? "January (Y+1)" : MONTHS[state.startMonth - 1] + " (Y0)";
    const vCfg  = VERDICT_CONFIG[verdictKey];
    const date  = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    const vColor  = verdictKey === "GO" ? "#0f6e56" : verdictKey === "AMBER_PAYBACK" ? "#854f0b" : "#8b1a1a";
    const vBg     = verdictKey === "GO" ? "#e1f5ee" : verdictKey === "AMBER_PAYBACK" ? "#faeeda" : "#fcebeb";
    const vBorder = verdictKey === "GO" ? "#1d9e75" : verdictKey === "AMBER_PAYBACK" ? "#ba7517" : "#e24b4a";
    const rcColor = state.riskCategory === "low" ? "#0f6e56" : state.riskCategory === "medium" ? "#854f0b" : "#8b1a1a";
    const rcBg    = state.riskCategory === "low" ? "#e1f5ee" : state.riskCategory === "medium" ? "#faeeda" : "#fcebeb";

    const dpbOk  = m.dPayback !== null && m.dPayback < 2.5;
    const dpbAmb = m.dPayback !== null && m.dPayback >= 2.5 && m.dPayback <= 3;
    const dpbCol = dpbOk ? "#0f6e56" : dpbAmb ? "#854f0b" : "#8b1a1a";
    const dpbBg  = dpbOk ? "#e1f5ee" : dpbAmb ? "#faeeda" : "#fcebeb";
    const npvCol = m.npv > 0 ? "#0f6e56" : "#8b1a1a";
    const npvBg  = m.npv > 0 ? "#e1f5ee" : "#fcebeb";
    const irrCol = m.irr !== null && m.irr > effectiveWACC ? "#0f6e56" : "#8b1a1a";

    const metricCard = (label, value, sub, col, bg) => [
      "<div style='background:" + (bg||"#f8f8f8") + ";border-radius:10px;padding:16px 18px;border:1px solid " + (col ? col+"30" : "#eee") + ";'>",
      "<div style='font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;font-weight:600'>" + label + "</div>",
      "<div style='font-size:24px;font-weight:700;color:" + (col||"#111") + ";margin-bottom:4px'>" + value + "</div>",
      sub ? "<div style='font-size:11px;color:#888'>" + sub + "</div>" : "",
      "</div>"
    ].join("");

    const irow = (label, value, bold) =>
      "<div style='display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;'>" +
      "<span style='font-size:12px;color:#666'>" + label + "</span>" +
      "<span style='font-size:13px;font-weight:" + (bold?"700":"600") + ";color:#111'>" + value + "</span></div>";

    const windowRow = (label, value, highlight) =>
      "<div style='text-align:center;background:" + (highlight?"#f0faf5":"#f8f8f8") + ";border-radius:8px;padding:10px 6px;border:1px solid " + (highlight?"#1d9e7530":"#eee") + ";'>" +
      "<div style='font-size:10px;color:#888;margin-bottom:4px'>" + label + "</div>" +
      "<div style='font-size:15px;font-weight:700;color:" + (highlight?"#0f6e56":"#111") + "'>" + value + "</div></div>";

    const y0h = adjustedCashflows.y0Ent > 0;
    const y3h = adjustedCashflows.y3 > 0;
    const y0v = y0h ? fmt(adjustedCashflows.y0Ent) : "—";
    const y3v = y3h ? fmt(adjustedCashflows.y3) : "—";
    const y0cols = state.startMonth === 0 ? 4 : state.startMonth === 1 ? 3 : 4;

    const html = [
      "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>CapEx Analysis — Amazon AMET</title>",
      "<style>",
      "*{box-sizing:border-box;margin:0;padding:0}",
      "body{font-family:Arial,sans-serif;background:#fff;color:#111;padding:36px 40px;max-width:900px;margin:0 auto}",
      "@media print{body{padding:20px 24px}@page{margin:1.5cm}}",
      ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}",
      ".grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}",
      ".grid4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px}",
      ".section{margin-top:22px}",
      ".section-title{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#aaa;font-weight:700;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #f0f0f0}",
      ".box{background:#f8f8f8;border-radius:10px;padding:14px 16px;border:1px solid #eee}",
      ".tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:.04em}",
      ".footer{margin-top:32px;padding-top:12px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#bbb}",
      "</style></head><body>",

      // HEADER
      "<div style='display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:2px solid #FF9900;margin-bottom:20px'>",
      "<div style='display:flex;align-items:center;gap:12px'>",
      "<img src='https://i.imgur.com/vS9wbFB.png' width='40' height='40' style='border-radius:8px'>",
      "<div><div style='font-size:20px;font-weight:700;color:#111'>CapEx Financial Analyzer</div>",
      "<div style='font-size:10px;color:#aaa;letter-spacing:.12em;text-transform:uppercase;margin-top:2px'>Investment Decision Framework · Amazon AMET · Internal</div></div></div>",
      "<div style='text-align:right'><div style='font-size:10px;color:#aaa'>Generated</div><div style='font-size:13px;font-weight:700;color:#111'>" + date + "</div></div>",
      "</div>",

      // VERDICT BANNER
      "<div style='background:" + vBg + ";border:2px solid " + vBorder + ";border-radius:12px;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;margin-bottom:20px'>",
      "<div style='display:flex;align-items:center;gap:14px'>",
      "<div style='width:48px;height:48px;border-radius:50%;background:" + vBorder + "20;border:2px solid " + vBorder + ";display:flex;align-items:center;justify-content:center;font-size:20px;color:" + vColor + "'>" + vCfg.icon + "</div>",
      "<div><div style='font-size:20px;font-weight:700;color:" + vColor + ";letter-spacing:.04em'>" + vCfg.label + "</div>",
      "<div style='font-size:12px;color:#666;margin-top:3px'>" + vCfg.desc + "</div></div></div>",
      "<div style='display:flex;flex-direction:column;gap:8px;min-width:220px'>",
      "<div style='display:flex;align-items:center;gap:8px;background:white;border-radius:6px;padding:6px 12px;border:1px solid " + (dpbOk?"#1d9e7540":"#e24b4a40") + "'>",
      "<span style='font-size:14px;color:" + (dpbOk?"#1d9e75":"#e24b4a") + "'>" + (dpbOk?"✓":"✗") + "</span>",
      "<span style='font-size:11px;font-weight:600;color:" + (dpbOk?"#0f6e56":"#8b1a1a") + "'>Discounted Payback &lt; 2.5 yrs</span></div>",
      "<div style='display:flex;align-items:center;gap:8px;background:white;border-radius:6px;padding:6px 12px;border:1px solid " + (m.npv>0?"#1d9e7540":"#e24b4a40") + "'>",
      "<span style='font-size:14px;color:" + (m.npv>0?"#1d9e75":"#e24b4a") + "'>" + (m.npv>0?"✓":"✗") + "</span>",
      "<span style='font-size:11px;font-weight:600;color:" + (m.npv>0?"#0f6e56":"#8b1a1a") + "'>NPV &gt; 0</span></div>",
      "</div></div>",

      // CORE METRICS
      "<div class='section'><div class='section-title'>Core Metrics</div>",
      "<div class='grid3'>",
      metricCard("NPV", fmt(m.npv), m.npv > 0 ? "Positive — value created" : "Negative — destroys value", npvCol, npvBg),
      metricCard("Discounted Payback", fmtPayback(m.dPayback), dpbOk ? "Within GO threshold" : dpbAmb ? "Requires alignment" : "Exceeds 3yr threshold", dpbCol, dpbBg),
      metricCard("ROI", (m.roi*100).toFixed(1)+"%", "Total return on investment", m.roi > 0 ? "#0f6e56" : "#8b1a1a", m.roi > 0 ? "#e1f5ee" : "#fcebeb"),
      "</div></div>",

      // SECONDARY METRICS
      "<div class='section'><div class='section-title'>Secondary Metrics</div>",
      "<div class='grid2'>",
      metricCard("IRR", m.irr !== null ? fmtPct(m.irr) : "N/A", "vs effective WACC " + effW + "%", irrCol, null),
      metricCard("Simple Payback", fmtPayback(m.payback), "Undiscounted recovery", "#555", null),
      "</div></div>",

      // PARAMETERS + 3YF WINDOW
      "<div class='section'><div class='section-title'>Project Parameters</div>",
      "<div class='grid2'>",
      "<div class='box'>",
      irow("Initial Investment", fmt(state.initialInvestment), true),
      irow("Base WACC", (state.wacc*100).toFixed(1)+"%", false),
      irow("Risk Category", "<span class='tag' style='background:" + rcBg + ";color:" + rcColor + "'>" + rc.label + " " + rc.premium + "</span>", false),
      irow("Effective WACC", "<strong style='color:#FF9900'>" + effW + "%</strong>", false),
      irow("Entitlement Start", mL, false),
      "</div>",
      "<div class='box'>",
      irow("Y1 Annual Entitlement", fmt(yearCFs.y1) + "/yr", true),
      irow("Y2 Annual Entitlement", fmt(yearCFs.y2) + "/yr", false),
      irow("Y3 Annual Entitlement", fmt(yearCFs.y3) + "/yr", false),
      "</div></div></div>",

      // 3YF WINDOW
      "<div class='section'><div class='section-title'>Adjusted 3YF Window (36 months)</div>",
      "<div class='" + (y0cols === 3 ? "grid3" : "grid4") + "'>",
      state.startMonth === 0
        ? windowRow("Y0 (0m)", "—", false)
        : windowRow("Y0 (" + adjustedCashflows.y0Months + "m)", y0v, y0h),
      windowRow("Y1 (12m)", fmt(adjustedCashflows.y1), false),
      windowRow("Y2 (12m)", fmt(adjustedCashflows.y2), false),
      state.startMonth === 1 ? "" : windowRow("Y3 (" + adjustedCashflows.y3Months + "m)", y3v, y3h),
      "</div></div>",

      // FOOTER
      "<div class='footer'>",
      "<span>Amazon AMET · CapEx Financial Analyzer · For decision support only</span>",
      "<span>Effective WACC: " + effW + "% · Risk: " + rc.label + " · Start: " + mL + "</span>",
      "</div>",

      "<script>window.onload=function(){window.print();}<\/script>",
      "</body></html>"
    ].join("");

    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
  };

  const reset = () => {
    setState(DEFAULT);
    setYearCFs({ y1: DEFAULT.cashflows[0], y2: DEFAULT.cashflows[1], y3: DEFAULT.cashflows[2] });
    setWaccInput(String(Math.round(DEFAULT.wacc * 100)));
    setSelectedCountry(null);
  };
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
              {/* WACC + Country Picker */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "'Space Mono',monospace" }}>WACC</label>
                  {selectedCountry && (
                    <span style={{ fontSize: 10, color: WACC_TIERS[selectedCountry.tier].color, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>
                      {selectedCountry.name} · {WACC_TIERS[selectedCountry.tier].label}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <div style={{ position: "relative", flex: 1 }}>
                    <input
                      type="number"
                      value={waccInput}
                      onChange={e => {
                        setWaccInput(e.target.value);
                        setSelectedCountry(null);
                        const v = Number(e.target.value);
                        if (!isNaN(v) && e.target.value !== "") update("wacc")(v / 100);
                      }}
                      onBlur={e => {
                        const v = Number(e.target.value);
                        if (isNaN(v) || e.target.value === "") {
                          setWaccInput("10");
                          update("wacc")(0.10);
                        }
                      }}
                      style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "8px 28px 8px 10px", color: "#e8eaf6", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none" }}
                      onFocus={e => (e.target.style.borderColor = "rgba(0,229,160,0.4)")}
                    />
                    <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)", fontSize: 11, pointerEvents: "none" }}>%</span>
                  </div>
                  <button
                    onClick={() => setShowCountryPicker(true)}
                    style={{ padding: "8px 12px", borderRadius: 7, background: "rgba(55,138,221,0.08)", border: "1px solid rgba(55,138,221,0.3)", color: "#378ADD", fontSize: 10, cursor: "pointer", fontFamily: "'Space Mono',monospace", fontWeight: 700, letterSpacing: "0.04em", whiteSpace: "nowrap", flexShrink: 0 }}
                    onMouseEnter={e => { e.target.style.background = "rgba(55,138,221,0.15)"; }}
                    onMouseLeave={e => { e.target.style.background = "rgba(55,138,221,0.08)"; }}>
                    🌍 Country WACC
                  </button>
                </div>
              </div>

              {/* Country Picker Modal */}
              {showCountryPicker && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
                  onClick={() => { setShowCountryPicker(false); setCountrySearch(""); }}>
                  <div style={{ background: "#0d1520", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, padding: 24, width: 460, maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 14 }}
                    onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#e8eaf6", fontFamily: "'Plus Jakarta Sans',sans-serif" }}>Country WACC — Amazon AMET</span>
                      <button onClick={() => { setShowCountryPicker(false); setCountrySearch(""); }}
                        style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 18, cursor: "pointer", padding: "0 4px" }}>✕</button>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {Object.entries(WACC_TIERS).map(([key, t]) => (
                        <span key={key} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 20, background: t.bg, color: t.color, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>
                          {t.label} {t.wacc ? t.wacc + "%" : "Calc."}
                        </span>
                      ))}
                    </div>
                    <input
                      type="text"
                      placeholder="Search country..."
                      value={countrySearch}
                      onChange={e => setCountrySearch(e.target.value)}
                      autoFocus
                      style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 12px", color: "#e8eaf6", fontSize: 13, fontFamily: "'Space Mono',monospace", outline: "none", width: "100%" }}
                    />
                    <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, maxHeight: 380 }}>
                      {COUNTRY_WACC
                        .filter(c => c.name.toLowerCase().includes(countrySearch.toLowerCase()))
                        .map(c => {
                          const t = WACC_TIERS[c.tier];
                          const isSelected = selectedCountry?.name === c.name;
                          return (
                            <div key={c.name}
                              onClick={() => {
                                setSelectedCountry(c);
                                update("wacc")(c.wacc / 100);
                                setWaccInput(String(c.wacc));
                                setShowCountryPicker(false);
                                setCountrySearch("");
                              }}
                              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: 8, cursor: "pointer", background: isSelected ? t.bg : "transparent", border: isSelected ? `1px solid ${t.color}40` : "1px solid transparent", transition: "all 0.1s" }}
                              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
                              <span style={{ fontSize: 13, color: "#e8eaf6", fontFamily: "'Plus Jakarta Sans',sans-serif" }}>{c.name}</span>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 12, background: t.bg, color: t.color, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{t.label.split(" ")[0]}</span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: t.color, fontFamily: "'Space Mono',monospace", minWidth: 40, textAlign: "right" }}>{c.wacc}%</span>
                              </div>
                            </div>
                          );
                        })}
                      {COUNTRY_WACC.filter(c => c.name.toLowerCase().includes(countrySearch.toLowerCase())).length === 0 && (
                        <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", padding: 24, fontSize: 13 }}>No countries found</div>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", textAlign: "center", fontFamily: "'Space Mono',monospace" }}>Amazon Internal · Country Risk Adjusted WACCs · 30-APR-2025</div>
                  </div>
                </div>
              )}

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
