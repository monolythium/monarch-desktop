// Signing activity strip — N bars wide, each bar is a round. Gold = signed,
// red = missed. Up to ~200 bars from designs/home.jsx; this strips at 60
// for the home cockpit view.

export function SigningStrip({
  data,
  threshold,
  total,
}: {
  data: number[];
  threshold: number;
  total: number;
}) {
  return (
    <div className="sig-strip" aria-label="Signing activity">
      {data.map((live, i) => {
        const missed = live < threshold;
        return (
          <div
            key={i}
            className={
              missed ? "sig-strip__bar sig-strip__bar--miss" : "sig-strip__bar"
            }
            style={{ height: `${Math.max(8, (live / total) * 100)}%` }}
            title={`${live}/${total}`}
          />
        );
      })}
    </div>
  );
}
