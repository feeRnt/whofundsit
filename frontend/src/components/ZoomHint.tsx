import { useEffect, useState } from "react";
import { ZoomIn } from "lucide-react";

// One-shot zoom gesture hint: appears once the map loads, fades away on
// its own. Pointer-transparent so it never blocks map interaction.
export default function ZoomHint({ onGone }: { onGone: () => void }) {
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setFading(true), 4500);
    const remove = setTimeout(() => {
      setGone(true);
      onGone();
    }, 5400);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
    };
  }, [onGone]);
  if (gone) {
    return null;
  }
  return (
    <div className={`zoom-hint${fading ? " fading" : ""}`} aria-hidden="true">
      <ZoomIn size={14} />
      <span>Scroll to zoom · two-finger scroll on trackpads</span>
    </div>
  );
}
