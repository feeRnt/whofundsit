import { useMemo, useState } from "react";
import type { Entity } from "../api";

// Client-side search over loaded entities: name, ticker, or address.
// Selecting a result flies the map there and opens its popup.
export default function SearchBox({
  entities,
  onSelect,
}: {
  entities: Entity[];
  onSelect: (e: Entity) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      return [];
    }
    // One row per company (entities hold one row per concept tag).
    const seen = new Set<string>();
    const out: Entity[] = [];
    for (const e of entities) {
      const hay =
        `${e.name} ${e.tickers.join(" ")} ${e.businessAddress ?? ""} ${e.rawAddressText}`.toLowerCase();
      if (!hay.includes(q)) {
        continue;
      }
      const key =
        e.id.startsWith("openalex:") || e.id.startsWith("13f:")
          ? e.id
          : e.id.split(":")[0];
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(e);
      if (out.length >= 10) {
        break;
      }
    }
    return out;
  }, [entities, query]);

  return (
    <div className="search">
      <input
        value={query}
        onChange={(ev) => {
          setQuery(ev.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search name, ticker, address…"
        aria-label="Search companies"
      />
      {open && matches.length > 0 && (
        <ul className="search-results">
          {matches.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onMouseDown={() => {
                  onSelect(e);
                  setOpen(false);
                  setQuery(e.name);
                }}
              >
                <strong>{e.name}</strong>
                <span>
                  {[e.tickers.join(", "), e.businessAddress ?? e.rawAddressText]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
