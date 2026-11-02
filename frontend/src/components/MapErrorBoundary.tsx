import { Component, type ReactNode } from "react";

// Catches render/WebGL crashes in the map subtree so a Deck/MapLibre
// failure shows a recoverable note instead of a blank page. Header and
// controls outside the boundary stay alive.
export default class MapErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[map] render failed", error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="map-note refreshable" role="alert">
          The map hit a graphics error —{" "}
          <button type="button" onClick={() => window.location.reload()}>
            refresh the page
          </button>{" "}
          to restore it.
        </div>
      );
    }
    return this.props.children;
  }
}
