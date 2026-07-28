import type { CSSProperties } from "react";

const positions = [
  ["0%", "0%"],
  ["33.333%", "0%"],
  ["66.666%", "0%"],
  ["100%", "0%"],
  ["0%", "100%"],
  ["33.333%", "100%"],
  ["66.666%", "100%"],
  ["100%", "100%"],
];

export function AnimeCover({
  index,
  title,
  src,
  priority = false,
  className = "",
}: {
  index: number;
  title: string;
  src?: string | null;
  priority?: boolean;
  className?: string;
}) {
  const position = positions[index % positions.length];
  return (
    <div
      aria-label={`${title}封面`}
      role="img"
      className={`anime-cover ${className}`}
      data-priority={priority || undefined}
      style={
        {
          backgroundImage: src
            ? `url("${src.replaceAll('"', "%22")}")`
            : "url('/assets/fictional-anime-covers.png')",
          backgroundSize: src ? "cover" : "400% 200%",
          backgroundPosition: src
            ? "center"
            : `${position[0]} ${position[1]}`,
        } as CSSProperties
      }
    />
  );
}
