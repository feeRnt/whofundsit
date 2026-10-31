import type { Entity } from "../api";

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

export default function EntityPopup({
  entity,
  entities,
  hasFlows,
  flowsOn,
  onToggleFlows,
}: {
  entity: Entity;
  entities: Entity[];
  hasFlows: boolean;
  flowsOn: boolean;
  onToggleFlows: () => void;
}) {
  const siblings = siblingConcepts(entities, entity);
  const label = entity.conceptTag
    ? (CONCEPT_LABELS[entity.conceptTag] ?? entity.conceptTag)
    : entity.source === "openalex"
      ? "Funded works"
      : entity.type === "Fund"
        ? "Holdings value"
        : "Reported value";
  const valueText =
    entity.source === "openalex"
      ? entity.fundsVolume.toLocaleString("en-US")
      : `$${entity.fundsVolume.toLocaleString("en-US")}`;
  const noFinancials = !entity.conceptTag && entity.fundsVolume === 0;
  return (
    <div className="entity-popup">
      <h2>{entity.name}</h2>
      <p className="entity-value">
        {noFinancials ? "Listed company — financials not yet loaded" : `${label}: ${valueText}`}
      </p>
      {siblings.map((s) => (
        <p key={s.id} className="entity-value sibling">
          {CONCEPT_LABELS[s.conceptTag ?? ""] ?? s.conceptTag}: $
          {s.fundsVolume.toLocaleString("en-US")}
        </p>
      ))}
      {hasFlows && (
        <button
          type="button"
          className="flow-toggle"
          onClick={onToggleFlows}
        >
          {flowsOn ? "Hide this company's flows" : "Show this company's flows"}
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
