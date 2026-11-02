import { useEffect, useState } from "react";
import { RefreshCw, ZoomIn } from "lucide-react";

// One-shot load hints: appear once the map loads, fade away on their own.
// Pointer-transparent so they never block map interaction. The tile line
// sits above the gesture line and names the refresh-map button for when
// tiles corrupt (the button itself lives in the map corner controls).
export default function ZoomHint({ onGone }: { onGone: () => void }) {
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setFading(true), 6100);
    const remove = setTimeout(() => {
      setGone(true);
      onGone();
    }, 7000);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
    };
  }, [onGone]);
  if (gone) {
    return null;
  }
  const cls = `zoom-hint${fading ? " fading" : ""}`;
  return (
    <>
      <div className={cls} aria-hidden="true">
        <ZoomIn size={14} />
        <span>Scroll to zoom · two-finger scroll on trackpads</span>
      </div>
      <div className={`${cls} tile-hint`} aria-hidden="true">
        <RefreshCw size={14} />
        <span>Tiles corrupted? Press the refresh-map button to reload them</span>
      </div>
    </>
  );
}
