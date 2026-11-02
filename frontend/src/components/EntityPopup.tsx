import { useEffect, useState } from "react";
import { fetchQuote, fetchShares, formatMoney, primaryMetric, verificationCell, type Entity, type Flow, type Quote, type VerificationReport } from "../api";

const CONCEPT_LABELS: Record<string, string> = {
  StockholdersEquity: "Stockholders' equity",
  LongTermDebt: "Long-term debt",
  Assets: "Total assets",
  Revenues: "Revenue (quarter)",
  NetIncomeLoss: "Net income (quarter)",
};

export interface DocLink {
  label: string;
  href: string;
}

// Wikipedia-style supporting documents for one entity row: the EDGAR filing
// validating the datapoint, the company's EDGAR page, and the source dataset.
export function docLinks(entity: Entity): DocLink[] {
  if (entity.id.startsWith("lei:")) {
    const lei = entity.id.slice("lei:".length);
    return [
      { label: "GLEIF record", href: `https://search.gleif.org/#/record/${lei}` },
    ];
  }
  if (entity.id.startsWith("openalex:")) {
    const oid = entity.id.slice("openalex:".length);
    return [{ label: "OpenAlex record", href: `https://openalex.org/${oid}` }];
  }
  const raw = entity.id.startsWith("13f:")
    ? (entity.id.split(":")[1] ?? "")
    : (entity.id.split(":")[0] ?? "");
  if (!/^\d+$/.test(raw)) {
    return [];
  }
  const cikNum = String(Number(raw));
  const links: DocLink[] = [];
  const accnPath = entity.secFilingNumber?.replace(/-/g, "");
  if (accnPath) {
    links.push({
      label: `Filing ${entity.secFilingNumber}`,
      href: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accnPath}/`,
    });
  }
  links.push({
    label: entity.type === "Fund" ? "Fund on EDGAR" : "Company on EDGAR",
    href: `https://www.sec.gov/edgar/browse/?CIK=${cikNum}&owner=exclude`,
  });
  if (entity.conceptTag && entity.sourceTimeFrame) {
    links.push({
      label: `Frame dataset (${entity.sourceTimeFrame})`,
      href: `https://data.sec.gov/api/xbrl/frames/us-gaap/${entity.conceptTag}/USD/${entity.sourceTimeFrame}.json`,
    });
  }
  return links;
}

// One Entity row per XBRL concept ({CIK}:{ConceptTag}), so a company has
// sibling rows. Both click pathways show the full set via this lookup.
export function siblingConcepts(
  entities: Entity[],
  entity: Entity,
): Entity[] {
  const group = entity.id.split(":")[0] ?? "";
  if (!/^\d+$/.test(group)) {
    return [];
  }
  return entities.filter(
    (e) =>
      e.id !== entity.id &&
      e.id.startsWith(`${group}:`) &&
      e.conceptTag !== null,
  );
}

// SEC submissions carry parallel tickers[]/exchanges[] arrays; group tickers
// by exchange so "Nasdaq ×4" becomes "Nasdaq: GOOGL, GOOG, …".
export function listingText(entity: Entity): string {
  if (entity.tickers.length === 0) {
    return [...new Set(entity.exchanges)].join(", ");
  }
  const groups = new Map<string, string[]>();
  for (const [i, t] of entity.tickers.entries()) {
    const ex = entity.exchanges[i] ?? "";
    groups.set(ex, [...(groups.get(ex) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([ex, ts]) => (ex ? `${ex}: ${ts.join(", ")}` : ts.join(", ")))
    .join(" · ");
}

function formatDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toISOString().slice(0, 10);
}

const STAKE_COLORS = [
  "#2dd4bf",
  "#fbbf24",
  "#38bdf8",
  "#fb7185",
  "#a3e635",
  "#fb923c",
];
const OTHER_COLOR = "#64748b";

// Ownership ring: top 6 tracked 13F holders get slices, the rest merge
// into gray "Other". With a market cap (shares × live price) every slice
// is a true % and the public float gets a sized dark slice; without one
// the ring falls back to tracked-relative and Public shows no percentage.
function StakesRing({
  stakes,
  entities,
  marketCap,
  capNote,
}: {
  stakes: Flow[];
  entities: Entity[];
  marketCap: number | null;
  capNote?: string | null;
}) {
  const total = stakes.reduce((a, f) => a + f.amount, 0);
  if (stakes.length === 0 || total <= 0) {
    return null;
  }
  // True-% mode sizes every slice against market cap (shares × live price).
  // Tracked must not exceed it — a stale count falls back to
  // tracked-relative instead of drawing a negative public slice.
  const trueMode = marketCap !== null && marketCap > 0 && total <= marketCap;
  const base = trueMode && marketCap !== null ? marketCap : total;
  const shown = stakes.slice(0, 6);
  const rest = stakes.slice(6);
  const restTotal = rest.reduce((a, f) => a + f.amount, 0);
  const label = (f: Flow) =>
    entities.find((e) => e.id === f.sourceEntityId)?.tickers[0] ??
    f.sourceEntity.name;
  const R = 40;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const arcs = shown.map((f, i) => {
    const frac = f.amount / base;
    const arc = {
      key: f.id,
      frac,
      offset: acc,
      color: STAKE_COLORS[i % STAKE_COLORS.length],
      title: `${f.sourceEntity.name} — ${(frac * 100).toFixed(1)}%`,
    };
    acc += frac;
    return arc;
  });
  if (restTotal > 0) {
    arcs.push({
      key: "other",
      frac: restTotal / base,
      offset: acc,
      color: OTHER_COLOR,
      title: `Other (${rest.length}) — ${((restTotal / base) * 100).toFixed(1)}%`,
    });
    acc += restTotal / base;
  }
  const publicFrac = trueMode && marketCap !== null ? 1 - total / marketCap : 0;
  // Untracked is the residual: 100 minus every printed slice. In true-%
  // mode that is the public float; tracked-relative slices sum to 100,
  // and overlapping filings (tracked > cap) clamp at ~0, never negative.
  const untrackedPct = Math.max(0, 100 - (total / base) * 100);
  const exceeds = marketCap !== null && marketCap > 0 && total > marketCap;
  if (publicFrac > 0) {
    arcs.push({
      key: "public",
      frac: publicFrac,
      offset: acc,
      color: "#334155",
      title: `Untracked shares — ${(publicFrac * 100).toFixed(1)}%`,
    });
  }
  return (
    <div className="stakes">
      <svg
        viewBox="0 0 100 100"
        className="stakes-ring"
        role="img"
        aria-label="Tracked institutional stakes"
      >
        <g transform="rotate(-90 50 50)">
          {arcs.map((s) => (
            <circle
              key={s.key}
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(s.frac * C - 2, 1)} ${C}`}
              strokeDashoffset={-(s.offset * C)}
            >
              <title>{s.title}</title>
            </circle>
          ))}
        </g>
        <text x="50" y="49" textAnchor="middle" className="stakes-total">
          {formatMoney(total)}
        </text>
        <text x="50" y="61" textAnchor="middle" className="stakes-sub">
          {trueMode && marketCap !== null
            ? `${((total / marketCap) * 100).toFixed(1)}% of mcap`
            : "13F Funding"}
        </text>
      </svg>
      <ul className="stakes-legend">
        {shown.map((f, i) => (
          <li
            key={f.id}
            title={`${f.sourceEntity.name} — ${formatMoney(f.amount)}`}
          >
            <span
              className="swatch"
              style={{ background: STAKE_COLORS[i % STAKE_COLORS.length] }}
            />
            <span className="stakes-name">{label(f)}</span>
            <span className="stakes-pct">
              {((f.amount / base) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
        {rest.length > 0 && (
          <li title={`${rest.length} smaller holders — ${formatMoney(restTotal)}`}>
            <span className="swatch" style={{ background: OTHER_COLOR }} />
            <span className="stakes-name">Other ({rest.length})</span>
            <span className="stakes-pct">
              {((restTotal / base) * 100).toFixed(1)}%
            </span>
          </li>
        )}
        <li
          className="stakes-public"
          title={
            trueMode
              ? "10-K shares outstanding minus tracked 13F positions: retail, insiders, small funds"
              : "Retail, insiders and small funds never appear in 13F filings"
          }
        >
          <span className="swatch swatch-unknown">?</span>
          <span className="stakes-name">
            {marketCap !== null ? "Untracked shares" : "Untracked funding"}
          </span>
          <span className="stakes-pct">
            {exceeds ? "≈" : ""}
            {untrackedPct.toFixed(1)}%
          </span>
        </li>
      </ul>
      <p className="stakes-note">
        {trueMode && marketCap !== null
          ? `True % of ~${formatMoney(marketCap)} market cap.`
          : exceeds && marketCap !== null
            ? `Tracked 13F $ ≥ ~${formatMoney(marketCap)} market cap — overlapping filings.`
            : (capNote ?? "Split of tracked 13F $ — true % needs market cap.")}
      </p>
    </div>
  );
}

export default function EntityPopup({
  entity,
  entities,
  verification,
  stakes,
  hasFlows,
  flowsOn,
  onToggleFlows,
  focused,
  onToggleFocus,
}: {
  entity: Entity;
  entities: Entity[];
  verification: VerificationReport | null;
  stakes: Flow[];
  hasFlows: boolean;
  flowsOn: boolean;
  onToggleFlows: () => void;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const siblings = siblingConcepts(entities, entity);
  // Bold primary is always the same metric (Total assets; holdings for
  // funds, funded works for OpenAlex) whichever sibling row was clicked.
  // Other concepts stay as secondary lines below, minus the primary row.
  const primary = primaryMetric(entity, entities);
  const label = primary.label;
  const valueText = primary.text;
  const noFinancials = primary.volume === 0 && entity.source !== "openalex";
  const secondary = siblings.filter(
    (s) => !(primary.label === "Total assets" && s.conceptTag === "Assets"),
  );
  const ticker = entity.tickers[0];
  // Numeric-prefix ids ({CIK}:{tag}) are SEC company rows; 13f:/lei:/
  // openalex: rows have no 10-K share count.
  const cik = /^\d+$/.test(entity.id.split(":")[0] ?? "") ? (entity.id.split(":")[0] as string) : null;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [shares, setShares] = useState<number | null>(null);
  useEffect(() => {
    setQuote(null);
    if (!ticker) {
      return;
    }
    let live = true;
    fetchQuote(ticker).then((q) => {
      if (live) {
        setQuote(q);
      }
    });
    return () => {
      live = false;
    };
  }, [ticker]);
  useEffect(() => {
    setShares(null);
    if (!cik) {
      return;
    }
    let live = true;
    fetchShares(cik).then((s) => {
      if (live) {
        setShares(s);
      }
    });
    return () => {
      live = false;
    };
  }, [cik]);
  const marketCap = shares !== null && quote !== null ? shares * quote.close : null;
  // Trust badge: this row's source-cell audit score, overall as fallback.
  const sourceCell = verificationCell(verification, `source=${entity.source}`);
  const overallCell = verification?.overall ?? null;
  const badgeCell =
    sourceCell && sourceCell.pctVerified !== null
      ? { cell: sourceCell, scope: `source=${entity.source}` }
      : overallCell && overallCell.pctVerified !== null
        ? { cell: overallCell, scope: "overall" }
        : null;
  // Ring view switch: available whenever a market cap exists. When
  // tracked $ exceeds it (overlapping filings) the ring itself falls
  // back to tracked-relative and says so — hiding the toggle made
  // share-% look "gone" (regression in 9f2939a, which also dropped
  // this missing-input diagnosis).
  const canTrue = marketCap !== null && marketCap > 0;
  const capNote =
    marketCap !== null
      ? null
      : !ticker
        ? "True % needs a live price — no ticker on this row."
        : !cik
          ? "True % needs a 10-K share count — no SEC CIK."
          : shares === null
            ? "True % needs a 10-K share count — none on file for this CIK."
            : "True % needs shares + price — quote fetch failed.";
  const [ringTrue, setRingTrue] = useState(true);
  return (
    <div className="entity-popup">
      <h2>{entity.name}</h2>
      <p className="entity-value">
        {noFinancials ? "Listed company — financials not yet loaded" : `${label}: ${valueText}`}
      </p>
      {quote !== null && (
        <p
          className={`entity-value ${quote.changePct >= 0 ? "quote-up" : "quote-down"}`}
        >
          Today: {quote.changePct >= 0 ? "+" : ""}
          {quote.changePct.toFixed(2)}%
        </p>
      )}
      {shares !== null && (
        <p className="entity-value">
          Outstanding shares:{" "}
          {new Intl.NumberFormat("en-US", { notation: "compact" }).format(shares)}
        </p>
      )}
      {secondary.map((s) => (
        <p key={s.id} className="entity-value sibling">
          {CONCEPT_LABELS[s.conceptTag ?? ""] ?? s.conceptTag}:{" "}
          {formatMoney(s.fundsVolume, s.currency)}
        </p>
      ))}
      {canTrue && (
        <div className="ring-toggle" role="group" aria-label="Ownership ring mode">
          <button
            type="button"
            className={ringTrue ? "" : "active"}
            onClick={() => setRingTrue(false)}
          >
            13F funding
          </button>
          <button
            type="button"
            className={ringTrue ? "active" : ""}
            onClick={() => setRingTrue(true)}
          >
            Real %
          </button>
        </div>
      )}
      <StakesRing
        stakes={stakes}
        entities={entities}
        marketCap={ringTrue ? marketCap : null}
        capNote={capNote}
      />
      {hasFlows && (
        <button
          type="button"
          className="flow-toggle"
          onClick={onToggleFlows}
        >
          {flowsOn ? "Hide this company's flows" : "Show this company's flows"}
        </button>
      )}
      {hasFlows && (
        <button
          type="button"
          className="flow-toggle"
          onClick={onToggleFocus}
        >
          {focused ? "Show all companies' arcs" : "Only this company's arcs"}
        </button>
      )}
      {entity.mergedFrom && entity.mergedFrom.length > 0 && (
        <details className="merged-note">
          <summary>
            Merged from {entity.mergedFrom.length} record
            {entity.mergedFrom.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {entity.mergedFrom.map((r) => (
              <li key={r.id}>
                {r.name} <span>({r.source} · {r.id})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <dl>
        <div>
          <dt>As of</dt>
          <dd>{formatDate(entity.financialDate)}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{entity.businessAddress ?? entity.rawAddressText}</dd>
        </div>
        {entity.industry && (
          <div>
            <dt>Industry</dt>
            <dd>{entity.industry}</dd>
          </div>
        )}
        {entity.form && (
          <div>
            <dt>Source filing</dt>
            <dd>
              {entity.form}
              {entity.filed ? ` filed ${formatDate(entity.filed)}` : ""}
            </dd>
          </div>
        )}
        {(entity.tickers.length > 0 ||
          entity.exchanges.length > 0 ||
          entity.category) && (
          <div>
            <dt>Listing</dt>
            <dd>
              {[
                listingText(entity),
                entity.category?.replace(/<br\s*\/?>/g, " · "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
        {entity.formerNames.length > 0 && (
          <div>
            <dt>Formerly</dt>
            <dd>{entity.formerNames.join(", ")}</dd>
          </div>
        )}
      </dl>
      {!entity.businessAddress && (
        <p className="approx-note">
          Approximate location — no street address on file.
        </p>
      )}
      {badgeCell && verification && (
        <p
          className="verify-badge"
          title={`Methodology audit (${badgeCell.scope}): ${badgeCell.cell.passed}/${badgeCell.cell.tested} passed · ${verification.generatedAt.slice(0, 10)}`}
        >
          {badgeCell.cell.pctVerified}% verified
        </p>
      )}
      <h3>Supporting documents</h3>
      <ul>
        {docLinks(entity).map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
