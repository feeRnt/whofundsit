export interface FunderInfo {
  id: string;
  name: string;
  count: number;
  kind: string;
}

// Native <details> dropdown: master arcs switch plus one checkbox per funder
// (13F funds and the OpenAlex grant source alike).
export default function FlowsDropdown({
  title,
  masterLabel,
  funders,
  showFlows,
  enabledFunders,
  open,
  onToggleOpen,
  onToggleMaster,
  onToggleFunder,
}: {
  title: string;
  masterLabel: string;
  funders: FunderInfo[];
  showFlows: boolean;
  enabledFunders: Set<string>;
  open: boolean;
  onToggleOpen: () => void;
  onToggleMaster: () => void;
  onToggleFunder: (id: string) => void;
}) {
  return (
    <details className="flows-menu" open={open}>
      <summary
        className="toggle"
        aria-label={`${title} visibility options`}
        onClick={(e) => {
          // Controlled accordion: block the native toggle, let App decide.
          e.preventDefault();
          onToggleOpen();
        }}
      >
        {title}
      </summary>
      <div className="flows-panel">
        <label className="flows-row">
          <input
            type="checkbox"
            checked={showFlows}
            onChange={onToggleMaster}
          />
          {masterLabel}
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
