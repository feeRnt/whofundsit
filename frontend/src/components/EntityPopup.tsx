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
  const cik = entity.id.split(":")[0] ?? "";
  const cikNum = String(Number(cik));
  const links: DocLink[] = [];
  const accnPath = entity.secFilingNumber?.replace(/-/g, "");
  if (accnPath) {
    links.push({
      label: `Filing ${entity.secFilingNumber}`,
      href: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accnPath}/`,
    });
  }
  links.push({
    label: "Company on EDGAR",
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

function formatDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toISOString().slice(0, 10);
}

export default function EntityPopup({ entity }: { entity: Entity }) {
  const label = entity.conceptTag
    ? (CONCEPT_LABELS[entity.conceptTag] ?? entity.conceptTag)
    : "Reported value";
  return (
    <div className="entity-popup">
      <h2>{entity.name}</h2>
      <p className="entity-value">
        {label}: ${entity.fundsVolume.toLocaleString("en-US")}
      </p>
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
        {(entity.exchanges.length > 0 || entity.category) && (
          <div>
            <dt>Listing</dt>
            <dd>
              {[entity.exchanges.join(", "), entity.category]
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
