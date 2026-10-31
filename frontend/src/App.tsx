import { useEffect, useState } from "react";
import { Globe as GlobeIcon, Map as MapIcon } from "lucide-react";
import MapGlobe from "./components/MapGlobe";
import { fetchEntities, fetchFlows, type Entity, type Flow } from "./api";

export default function App() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projection, setProjection] = useState<"globe" | "mercator">("globe");

  useEffect(() => {
    Promise.all([fetchEntities(), fetchFlows()])
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
        <button
          type="button"
          className="toggle"
          onClick={() =>
            setProjection((p) => (p === "globe" ? "mercator" : "globe"))
          }
          aria-pressed={projection === "globe"}
          title="Toggle globe / flat map"
        >
          {projection === "globe" ? (
            <MapIcon size={16} />
          ) : (
            <GlobeIcon size={16} />
          )}
          {projection === "globe" ? "Flat map" : "Globe"}
        </button>
      </header>
      <main className="map">{!loading && !error && (
          <MapGlobe entities={entities} flows={flows} projection={projection} />
        )}</main>
    </div>
  );
}
