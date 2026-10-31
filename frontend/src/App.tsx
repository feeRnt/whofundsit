import { useEffect, useMemo, useState } from "react";
import { Globe as GlobeIcon, Map as MapIcon } from "lucide-react";
import MapGlobe from "./components/MapGlobe";
import SearchBox from "./components/SearchBox";
import FlowsDropdown, { type FunderInfo } from "./components/FlowsDropdown";
import { fetchEntities, fetchFlows, type Entity, type Flow } from "./api";

export default function App() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [focused, setFocused] = useState<Entity | null>(null);
  const [showFlows, setShowFlows] = useState(true);
  const [showGrants, setShowGrants] = useState(false);
  const [funderOverrides, setFunderOverrides] = useState<Map<
    string,
    boolean
  > | null>(null);
  const [disabledCompanies, setDisabledCompanies] = useState<Set<string>>(
    new Set(),
  );
  const [flowLimit, setFlowLimit] = useState(250);

  const flowEndpoints = useMemo(() => {
    const ids = new Set<string>();
    for (const f of flows) {
      ids.add(f.sourceEntityId);
      ids.add(f.targetEntityId);
    }
    return ids;
  }, [flows]);

  const { funders13f, fundersGrants } = useMemo(() => {
    const byId = new Map<string, FunderInfo>();
    for (const f of flows) {
      const entry = byId.get(f.sourceEntityId) ?? {
        id: f.sourceEntityId,
        name: f.sourceEntity.name,
        count: 0,
        kind: f.flowType,
      };
      entry.count += 1;
      byId.set(f.sourceEntityId, entry);
    }
    const sorted = [...byId.values()].sort((a, b) => b.count - a.count);
    return {
      funders13f: sorted.filter((f) => f.kind === "13f"),
      fundersGrants: sorted.filter((f) => f.kind !== "13f"),
    };
  }, [flows]);

  // BlackRock on by default; everything else off until toggled.
  const enabledFunders = useMemo(() => {
    const ids = new Set<string>();
    for (const f of [...funders13f, ...fundersGrants]) {
      const on =
        funderOverrides?.get(f.id) ??
        f.name.toLowerCase().includes("blackrock");
      if (on) {
        ids.add(f.id);
      }
    }
    return ids;
  }, [funders13f, fundersGrants, funderOverrides]);

  const visibleFlows = useMemo(
    () =>
      flows
        .filter(
          (f) =>
            ((f.flowType === "13f" && showFlows) ||
              (f.flowType === "grant" && showGrants)) &&
            enabledFunders.has(f.sourceEntityId) &&
            !disabledCompanies.has(f.sourceEntityId) &&
            !disabledCompanies.has(f.targetEntityId),
        )
        .slice(0, flowLimit),
    [
      flows,
      flowLimit,
      showFlows,
      showGrants,
      enabledFunders,
      disabledCompanies,
    ],
  );

  const funderKinds = useMemo(() => {
    const kinds = new Map<string, string>();
    for (const f of [...funders13f, ...fundersGrants]) {
      kinds.set(f.id, f.kind);
    }
    return kinds;
  }, [funders13f, fundersGrants]);

  // Masters are mutually exclusive: activating one layer deactivates the
  // other (the inactive dropdown's checkboxes disable themselves).
  const toggleHedgeMaster = () => {
    setShowFlows((v) => !v);
    setShowGrants(false);
  };
  const toggleGrantMaster = () => {
    setShowGrants((v) => !v);
    setShowFlows(false);
  };

  const toggleFunder = (id: string) => {
    const turningOn = !enabledFunders.has(id);
    setFunderOverrides((prev) => {
      const next = new Map(prev ?? []);
      next.set(id, turningOn);
      return next;
    });
    // Checking a funder activates its layer so the arcs become visible.
    if (turningOn) {
      if (funderKinds.get(id) === "13f") {
        setShowFlows(true);
        setShowGrants(false);
      } else {
        setShowGrants(true);
        setShowFlows(false);
      }
    }
  };

  // Popup button shares state with the dropdown checkboxes: funder ids
  // route to the funder toggle, plain companies to the per-company set.
  const toggleCompanyFlows = (id: string) => {
    if (funderKinds.has(id)) {
      toggleFunder(id);
      return;
    }
    setDisabledCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // What the map treats as hidden: per-company hides plus funders whose
  // dropdown checkbox is off, so the popup button mirrors the checkbox.
  const companyFlowsHidden = useMemo(() => {
    const hidden = new Set(disabledCompanies);
    for (const id of funderKinds.keys()) {
      if (!enabledFunders.has(id)) {
        hidden.add(id);
      }
    }
    return hidden;
  }, [disabledCompanies, funderKinds, enabledFunders]);
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
              : `${entities.length} entities · ${visibleFlows.length}/${flows.length} flows · SEC EDGAR CY2026Q2`}
        </p>
        <SearchBox entities={entities} onSelect={setFocused} />
        <FlowsDropdown
          title="Hedge-Funds"
          masterLabel="Show funding map"
          funders={funders13f}
          showFlows={showFlows}
          enabledFunders={enabledFunders}
          onToggleMaster={toggleHedgeMaster}
          onToggleFunder={toggleFunder}
        />
        <FlowsDropdown
          title="University funds"
          masterLabel="Show grants"
          funders={fundersGrants}
          showFlows={showGrants}
          enabledFunders={enabledFunders}
          onToggleMaster={toggleGrantMaster}
          onToggleFunder={toggleFunder}
        />
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
          <MapGlobe entities={entities} flows={visibleFlows} projection={projection} focused={focused} flowEndpoints={flowEndpoints} companyFlowsHidden={companyFlowsHidden} onToggleCompanyFlows={toggleCompanyFlows} />
        )}</main>
    </div>
  );
}
