import { useEffect, useMemo, useState } from "react";
import { Globe as GlobeIcon } from "lucide-react";
import MapGlobe from "./components/MapGlobe";
import SearchBox from "./components/SearchBox";
import { fetchEntities, fetchFlows, type Entity, type Flow } from "./api";

export default function App() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [focused, setFocused] = useState<Entity | null>(null);
  const [showFlows, setShowFlows] = useState(false);
  const [flowLimit, setFlowLimit] = useState(250);

  const flowEndpoints = useMemo(() => {
    const ids = new Set<string>();
    for (const f of flows) {
      ids.add(f.sourceEntityId);
      ids.add(f.targetEntityId);
    }
    return ids;
  }, [flows]);

  const visibleFlows = useMemo(
    () => flows.slice(0, flowLimit),
    [flows, flowLimit],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projection, setProjection] = useState<"globe" | "mercator">("mercator");

  useEffect(() => {
    Promise.all([fetchEntities(), fetchFlows(1000)])
      .then(([fetchedEntities, fetchedFlows]) => {
        setEntities(fetchedEntities);
        setFlows(fetchedFlows);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "load failed"),
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="app">
      <header className="bar">
        <h1>
          <GlobeIcon size={20} /> WhoFundsIt
        </h1>
        <p>
          {loading
            ? "Loading…"
            : error
              ? `API error: ${error} (is the backend running?)`
              : `${entities.length} entities · ${flows.length} flows · SEC EDGAR CY2026Q2`}
        </p>
        <SearchBox entities={entities} onSelect={setFocused} />
        <button
          type="button"
          className="toggle flows-toggle"
          onClick={() => setShowFlows((v) => !v)}
          aria-pressed={showFlows}
          title="Toggle money-flow arcs"
        >
          {showFlows ? "Hide flows" : "Show flows"}
        </button>
        <label
          className="arcs-control"
          title="Max arcs shown, biggest first"
        >
          Arcs {showFlows ? flowLimit : 0}
          <input
            type="range"
            min={0}
            max={1000}
            step={50}
            value={flowLimit}
            disabled={!showFlows}
            onChange={(ev) => setFlowLimit(Number(ev.target.value))}
          />
        </label>
      </header>
      <main className="map">{!loading && !error && (
          <MapGlobe entities={entities} flows={showFlows ? visibleFlows : []} projection={projection} focused={focused} flowEndpoints={flowEndpoints} onToggleProjection={() => setProjection((p) => (p === "globe" ? "mercator" : "globe"))} />
        )}</main>
    </div>
  );
}
