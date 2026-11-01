import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import logoUrl from "./assets/logo.svg";
import MapGlobe, { type Basemap } from "./components/MapGlobe";
import SearchBox from "./components/SearchBox";
import FlowsDropdown, { type FunderInfo } from "./components/FlowsDropdown";
import { fetchEntities, fetchFlows, type Entity, type Flow } from "./api";

// Entity-source groups for the flashcard cycler + per-database toggles.
// ESEF enriches `global` rows in place, so it shares that group.
const SOURCE_GROUPS = [
  { key: "edgar", label: "SEC EDGAR", sources: ["frames-api", "bulk-zip"] },
  { key: "global", label: "Wikidata + GLEIF", sources: ["global"] },
  { key: "funds", label: "13F Funds", sources: ["13f"] },
  { key: "grants", label: "OpenAlex Grants", sources: ["openalex"] },
  { key: "twse", label: "TWSE", sources: ["twse"] },
];

function groupOf(source: string): { key: string; label: string } {
  const g = SOURCE_GROUPS.find((g) => g.sources.includes(source));
  return g ? { key: g.key, label: g.label } : { key: source, label: source };
}

// Past this many dots/arcs the map may chug on weak GPUs — warn in the label.
const LAG_WARN_AT = 15000;

export default function App() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [focused, setFocused] = useState<Entity | null>(null);
  // Bumped on every search pick so re-picking the same company re-flies.
  const [focusTick, setFocusTick] = useState(0);
  const [showFlows, setShowFlows] = useState(true);
  const [showGrants, setShowGrants] = useState(false);
  const [showOwnership, setShowOwnership] = useState(true);
  // Focus mode: arcs for one company only; dropdowns tick just its funders.
  const [focusCompany, setFocusCompany] = useState<string | null>(null);
  const [funderOverrides, setFunderOverrides] = useState<Map<
    string,
    boolean
  > | null>(null);
  const [disabledCompanies, setDisabledCompanies] = useState<Set<string>>(
    new Set(),
  );
  const [flowLimit, setFlowLimit] = useState(250);
  // Max dots shown, biggest fundsVolume first; null = all (rightmost).
  const [dotLimit, setDotLimit] = useState<number | null>(14000);
  // Per-database entity toggles (flashcard popup); empty = all shown.
  const [disabledSources, setDisabledSources] = useState<Set<string>>(new Set());
  // Flashcard tick: rotates the header through present source groups.
  const [sourceTick, setSourceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSourceTick((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, []);

  // Present source groups with counts (flashcard + popup read this).
  const presentGroups = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const e of entities) {
      const g = groupOf(e.source);
      const cur = counts.get(g.key) ?? { label: g.label, count: 0 };
      cur.count += 1;
      counts.set(g.key, cur);
    }
    return [...counts.entries()].map(([key, v]) => ({ key, ...v }));
  }, [entities]);

  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);

  const visibleEntities = useMemo(
    () =>
      disabledSources.size === 0
        ? entities
        : entities.filter((e) => !disabledSources.has(groupOf(e.source).key)),
    [entities, disabledSources],
  );

  // Dots slider: moneyed/money-less round-robin, biggest-first per bucket.
  // Arcs follow automatically — MapGlobe only draws arcs whose ends are shown.
  const shownEntities = useMemo(() => {
    // Round-robin moneyed/money-less so zero-volume rows (global sync,
    // universities) show up instead of sinking under the asset sort.
    // Each bucket stays biggest-first; filter() copies, so sort() is safe.
    const moneyed = visibleEntities.filter((e) => e.fundsVolume > 0);
    const broke = visibleEntities.filter((e) => !(e.fundsVolume > 0));
    moneyed.sort((a, b) => b.fundsVolume - a.fundsVolume);
    broke.sort((a, b) => b.fundsVolume - a.fundsVolume);
    if (dotLimit == null) {
      return [...moneyed, ...broke];
    }
    const out: typeof moneyed = [];
    for (
      let i = 0;
      out.length < dotLimit && (i < moneyed.length || i < broke.length);
      i++
    ) {
      if (i < moneyed.length && out.length < dotLimit) {
        out.push(moneyed[i]);
      }
      if (i < broke.length && out.length < dotLimit) {
        out.push(broke[i]);
      }
    }
    return out;
  }, [visibleEntities, dotLimit]);

  const toggleSource = (key: string) =>
    setDisabledSources((s) => {
      const next = new Set(s);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const flowEndpoints = useMemo(() => {
    const ids = new Set<string>();
    for (const f of flows) {
      ids.add(f.sourceEntityId);
      ids.add(f.targetEntityId);
    }
    return ids;
  }, [flows]);

  const { funders13f, fundersGrants, fundersOwnership } = useMemo(() => {
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
      fundersGrants: sorted.filter((f) => f.kind === "grant"),
      fundersOwnership: sorted.filter((f) => f.kind === "ownership"),
    };
  }, [flows]);

  // BlackRock + all ownership funders on by default; everything else off
  // until toggled.
  const enabledFunders = useMemo(() => {
    const ids = new Set<string>();
    for (const f of [...funders13f, ...fundersGrants, ...fundersOwnership]) {
      const on =
        funderOverrides?.get(f.id) ??
        (f.kind === "ownership" || f.name.toLowerCase().includes("blackrock"));
      if (on) {
        ids.add(f.id);
      }
    }
    return ids;
  }, [funders13f, fundersGrants, fundersOwnership, funderOverrides]);

  // Funders with at least one arc touching the focused company.
  const focusFunders = useMemo(() => {
    const ids = new Set<string>();
    if (!focusCompany) {
      return ids;
    }
    for (const f of flows) {
      if (
        f.sourceEntityId === focusCompany ||
        f.targetEntityId === focusCompany
      ) {
        ids.add(f.sourceEntityId);
      }
    }
    return ids;
  }, [flows, focusCompany]);

  // Effective checkbox state: in focus mode only the company's funders are
  // ticked (explicit unchecks still apply so boxes stay toggleable).
  const effectiveFunders = useMemo(() => {
    if (!focusCompany) {
      return enabledFunders;
    }
    const ids = new Set(focusFunders);
    for (const [id, on] of funderOverrides ?? []) {
      if (!on) {
        ids.delete(id);
      }
    }
    return ids;
  }, [focusCompany, focusFunders, enabledFunders, funderOverrides]);

  const visibleFlows = useMemo(() => {
      const filtered = flows.filter(
        (f) =>
          ((f.flowType === "13f" && showFlows) ||
            (f.flowType === "grant" && showGrants) ||
            (f.flowType === "ownership" && showOwnership)) &&
          effectiveFunders.has(f.sourceEntityId) &&
          !disabledCompanies.has(f.sourceEntityId) &&
          !disabledCompanies.has(f.targetEntityId) &&
          !isEndpointHidden(f.sourceEntityId) &&
          !isEndpointHidden(f.targetEntityId) &&
          (!focusCompany ||
            f.sourceEntityId === focusCompany ||
            f.targetEntityId === focusCompany),
      );
      // Round-robin across flow types so small-unit types (ownership stakes
      // are 0/undisclosed, grants are work counts) get a fair share of the
      // cap instead of being buried under dollar amounts.
      const byType = new Map<string, typeof filtered>();
      for (const f of filtered) {
        const list = byType.get(f.flowType) ?? [];
        list.push(f);
        byType.set(f.flowType, list);
      }
      const out: typeof filtered = [];
      let i = 0;
      for (;;) {
        let added = false;
        for (const list of byType.values()) {
          if (i < list.length && out.length < flowLimit) {
            out.push(list[i]);
            added = true;
          }
        }
        if (!added || out.length >= flowLimit) {
          break;
        }
        i += 1;
      }
      return out;
    },
    [
      flows,
      flowLimit,
      showFlows,
      showGrants,
      showOwnership,
      effectiveFunders,
      disabledCompanies,
      disabledSources,
      entityById,
      focusCompany,
    ],
  );

  // The Arcs slider is global: live whenever ANY arc type is on, not just
  // the Hedge-Funds master switch.
  const anyArcsOn = showFlows || showGrants || showOwnership;

  // A flow hides only when its endpoint entity is loaded AND its source
  // group is toggled off — unfetched endpoints never hide anything.
  function isEndpointHidden(id: string): boolean {
    const e = entityById.get(id);
    return !!e && disabledSources.has(groupOf(e.source).key);
  }

  const toggleFocusCompany = (id: string) => {
    if (focusCompany === id) {
      setFocusCompany(null);
      return;
    }
    // Fresh lens: clear stale unchecks for this company's funders, and make
    // sure the layers carrying its arcs are switched on.
    setFunderOverrides((prev) => {
      if (!prev) {
        return prev;
      }
      const next = new Map(prev);
      for (const f of flows) {
        if (f.sourceEntityId === id || f.targetEntityId === id) {
          next.delete(f.sourceEntityId);
        }
      }
      return next;
    });
    const kinds = new Set(
      flows
        .filter((f) => f.sourceEntityId === id || f.targetEntityId === id)
        .map((f) => f.flowType),
    );
    if (kinds.has("13f")) {
      setShowFlows(true);
    }
    if (kinds.has("grant")) {
      setShowGrants(true);
    }
    if (kinds.has("ownership")) {
      setShowOwnership(true);
    }
    setFocusCompany(id);
  };

  const funderKinds = useMemo(() => {
    const kinds = new Map<string, string>();
    for (const f of [...funders13f, ...fundersGrants, ...fundersOwnership]) {
      kinds.set(f.id, f.kind);
    }
    return kinds;
  }, [funders13f, fundersGrants, fundersOwnership]);

  // One dropdown open at a time (accordion); layers stay independent.
  const [openMenu, setOpenMenu] = useState<"hedge" | "grants" | "ownership" | "sources" | null>(null);

  // Any click outside the menus collapses the open dropdown (map, search,
  // sliders, popups). Clicks inside a menu toggle normally.
  useEffect(() => {
    if (!openMenu) {
      return;
    }
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".flows-menu, .flashcard")) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openMenu]);

  const toggleFunder = (id: string) => {
    setFunderOverrides((prev) => {
      const next = new Map(prev ?? []);
      next.set(id, !effectiveFunders.has(id));
      return next;
    });
  };

  // "Select all" menu buttons: tick every funder of that kind at once,
  // or untick them all when they're already all on.
  const selectAll = (list: FunderInfo[]) => () => {
    const allOn = list.every((f) => effectiveFunders.has(f.id));
    setFunderOverrides((prev) => {
      const next = new Map(prev ?? []);
      for (const f of list) {
        next.set(f.id, !allOn);
      }
      return next;
    });
  };
  const selectAllLabel = (list: FunderInfo[]) =>
    list.every((f) => effectiveFunders.has(f.id))
      ? "Deselect all"
      : "Select all";

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
      if (!effectiveFunders.has(id)) {
        hidden.add(id);
      }
    }
    return hidden;
  }, [disabledCompanies, funderKinds, effectiveFunders]);

  const focusName = focusCompany
    ? (entities.find((e) => e.id === focusCompany)?.name ?? focusCompany)
    : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projection, setProjection] = useState<"globe" | "mercator">("mercator");
  // Dark basemap by default (matches the UI); choice persists per browser.
  const [basemap, setBasemap] = useState<Basemap>(() =>
    localStorage.getItem("whf-basemap") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    localStorage.setItem("whf-basemap", basemap);
  }, [basemap]);

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
          <span className="brand-lockup">
            <img src={logoUrl} alt="WhoFundsIt logo" />
            <span className="brand-word">WhoFundsIt</span>
          </span>
        </h1>
        <p>
          {loading
            ? "Loading…"
            : error
              ? `API error: ${error} (is the backend running?)`
              : `${shownEntities.length} entities · ${visibleFlows.length}/${flows.length} flows`}
          {!loading && !error && presentGroups.length > 0 && (
            <button
              type="button"
              className="flashcard"
              title="Data sources — click to toggle per database"
              onClick={() =>
                setOpenMenu((m) => (m === "sources" ? null : "sources"))
              }
            >
              {(() => {
                const g = presentGroups[sourceTick % presentGroups.length]!;
                return `${g.label} (${g.count})`;
              })()}
            </button>
          )}
        </p>
        <SearchBox
          entities={visibleEntities}
          onSelect={(e) => {
            setFocused(e);
            setFocusTick((t) => t + 1);
            setOpenMenu(null);
          }}
        />
        {focusCompany && (
          <button
            type="button"
            className="toggle"
            onClick={() => setFocusCompany(null)}
            title="Exit single-company view"
          >
            Only {focusName} <X size={14} />
          </button>
        )}
        <FlowsDropdown
          title="Hedge-Funds"
          masterLabel="Show funding map"
          funders={funders13f}
          showFlows={showFlows}
          enabledFunders={effectiveFunders}
          open={openMenu === "hedge"}
          onToggleOpen={() =>
            setOpenMenu((m) => (m === "hedge" ? null : "hedge"))
          }
          onToggleMaster={() => setShowFlows((v) => !v)}
          onToggleFunder={toggleFunder}
          onSelectAll={selectAll(funders13f)}
          selectAllLabel={selectAllLabel(funders13f)}
        />
        <FlowsDropdown
          title="University Funds"
          masterLabel="Show grants"
          funders={fundersGrants}
          showFlows={showGrants}
          enabledFunders={effectiveFunders}
          open={openMenu === "grants"}
          onToggleOpen={() =>
            setOpenMenu((m) => (m === "grants" ? null : "grants"))
          }
          onToggleMaster={() => setShowGrants((v) => !v)}
          onToggleFunder={toggleFunder}
        />
        <FlowsDropdown
          title="Ownership"
          masterLabel="Show ownership"
          funders={fundersOwnership}
          showFlows={showOwnership}
          enabledFunders={effectiveFunders}
          open={openMenu === "ownership"}
          onToggleOpen={() =>
            setOpenMenu((m) => (m === "ownership" ? null : "ownership"))
          }
          onToggleMaster={() => setShowOwnership((v) => !v)}
          onToggleFunder={toggleFunder}
          onSelectAll={selectAll(fundersOwnership)}
          selectAllLabel={selectAllLabel(fundersOwnership)}
        />
        <details
          className="flows-menu"
          open={openMenu === "sources"}
        >
          <summary
            className="toggle"
            aria-label="Data source visibility options"
            onClick={(e) => {
              e.preventDefault();
              setOpenMenu((m) => (m === "sources" ? null : "sources"));
            }}
          >
            Sources
          </summary>
          <div className="flows-panel">
            {presentGroups.map((g) => (
              <label key={g.key} className="flows-row">
                <input
                  type="checkbox"
                  checked={!disabledSources.has(g.key)}
                  onChange={() => toggleSource(g.key)}
                />
                <span>{g.label}</span>
                <span className="flows-count">{g.count}</span>
              </label>
            ))}
          </div>
        </details>
        <label
          className="arcs-control"
          title="Max arcs shown, biggest first"
        >
          Arcs {anyArcsOn ? visibleFlows.length : 0}
          {anyArcsOn && flowLimit > LAG_WARN_AT ? " — may lag" : ""}
          <input
            type="range"
            min={0}
            max={flows.length}
            step={500}
            value={Math.min(flowLimit, flows.length)}
            disabled={!anyArcsOn}
            onChange={(ev) => setFlowLimit(Number(ev.target.value))}
          />
        </label>
        <label
          className="arcs-control"
          title="Max company dots shown, biggest assets first"
        >
          Dots {shownEntities.length}
          {shownEntities.length > LAG_WARN_AT ? " — may lag" : ""}
          <input
            type="range"
            min={0}
            max={visibleEntities.length}
            step={500}
            value={Math.min(dotLimit ?? visibleEntities.length, visibleEntities.length)}
            onChange={(ev) => {
              const v = Number(ev.target.value);
              setDotLimit(v >= visibleEntities.length ? null : v);
            }}
          />
        </label>
      </header>
      <main className="map">{!loading && !error && (
          <MapGlobe entities={shownEntities} flows={visibleFlows} projection={projection} focused={focused} focusTick={focusTick} flowEndpoints={flowEndpoints} companyFlowsHidden={companyFlowsHidden} onToggleCompanyFlows={toggleCompanyFlows} focusCompanyId={focusCompany} onToggleFocusCompany={toggleFocusCompany} onOpenPopup={() => setOpenMenu(null)} onToggleProjection={() => setProjection((p) => (p === "globe" ? "mercator" : "globe"))} basemap={basemap} onToggleBasemap={() => setBasemap((b) => (b === "dark" ? "light" : "dark"))} />
        )}</main>
    </div>
  );
}
