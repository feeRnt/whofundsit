export interface FunderInfo {
  id: string;
  name: string;
  count: number;
  kind: string;
}

// Native <details> dropdown: master arcs switch plus one checkbox per funder
// (13F funds and the OpenAlex grant source alike).
export default function FlowsDropdown({
  funders,
  showFlows,
  enabledFunders,
  onToggleMaster,
  onToggleFunder,
}: {
  funders: FunderInfo[];
  showFlows: boolean;
  enabledFunders: Set<string>;
  onToggleMaster: () => void;
  onToggleFunder: (id: string) => void;
}) {
  return (
    <details className="flows-menu">
      <summary className="toggle" aria-label="Flow visibility options">
        Flows
      </summary>
      <div className="flows-panel">
        <label className="flows-row">
          <input
            type="checkbox"
            checked={showFlows}
            onChange={onToggleMaster}
          />
          Show arcs
        </label>
        {funders.map((f) => (
          <label key={f.id} className="flows-row" title={f.kind}>
            <input
              type="checkbox"
              checked={enabledFunders.has(f.id)}
              disabled={!showFlows}
              onChange={() => onToggleFunder(f.id)}
            />
            <span>{f.name}</span>
            <span className="flows-count">{f.count}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
