import type { SVGProps } from "react";

export type IconName =
  | "home"
  | "bolt"
  | "cpu"
  | "pulse"
  | "settings"
  | "layers"
  | "grid"
  | "folder"
  | "search"
  | "plus"
  | "x"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "chevron-down"
  | "trash"
  | "edit"
  | "refresh"
  | "download"
  | "pin"
  | "check"
  | "alert"
  | "info"
  | "terminal"
  | "monitor"
  | "memory"
  | "disk"
  | "network"
  | "play"
  | "pause"
  | "arrow-right"
  | "external"
  | "sliders"
  | "globe"
  | "package"
  | "clock"
  | "sparkles"
  | "shield"
  | "grip"
  | "layers-stack";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

const P: Record<IconName, string> = {
  home: "M3.5 10.4 12 3.5l8.5 6.9v9.1a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5zM9 21v-6.2h6V21",
  bolt: "M13.2 2.5 4.6 13.3h6.1l-1.2 8.2 8.9-11.2h-6.2z",
  cpu: "M7.5 7.5h9v9h-9zM10.5 10.5h3v3h-3zM9.5 3.2v4.3M14.5 3.2v4.3M9.5 16.5v4.3M14.5 16.5v4.3M3.2 9.5h4.3M3.2 14.5h4.3M16.5 9.5h4.3M16.5 14.5h4.3",
  pulse: "M2.6 12h4l2.2-6.4 4.4 12.8L15.6 12h5.8",
  settings:
    "M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM19.4 15c0-.5 0-1-.1-1.4l2-1.6-2-3.4-2.4.9c-.7-.6-1.4-1-2.2-1.3l-.3-2.6h-5l-.3 2.6c-.8.3-1.5.7-2.2 1.3l-2.4-.9-2 3.4 2 1.6c-.1.4-.1.9-.1 1.4s0 1 .1 1.4l-2 1.6 2 3.4 2.4-.9c.7.6 1.4 1 2.2 1.3l.3 2.6h5l.3-2.6c.8-.3 1.5-.7 2.2-1.3l2.4.9 2-3.4-2-1.6c.1-.4.1-.9.1-1.4Z",
  layers: "M12 3 3 7.8l9 4.8 9-4.8L12 3ZM3 12.2l9 4.8 9-4.8M3 16.6l9 4.8 9-4.8",
  "layers-stack": "M4 5.5h16v4H4zM4 11.5h16v4H4zM4 17.5h10v3H4z",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  folder:
    "M3 7.2A2.2 2.2 0 0 1 5.2 5h3.7l2.1 2.2h7.8A2.2 2.2 0 0 1 21 9.4v8.4A2.2 2.2 0 0 1 18.8 20H5.2A2.2 2.2 0 0 1 3 17.8z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM16.2 16.2 21 21",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6 6 18",
  "chevron-left": "M15 5.5 8.5 12l6.5 6.5",
  "chevron-right": "M9 5.5 15.5 12 9 18.5",
  "chevron-up": "M5.5 15 12 8.5l6.5 6.5",
  "chevron-down": "M5.5 9 12 15.5 18.5 9",
  trash:
    "M4 7h16M9.5 7V4.8A1.8 1.8 0 0 1 11.3 3h1.4a1.8 1.8 0 0 1 1.8 1.8V7M6.5 7l.9 12.2A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.8L17.5 7M10 11v6M14 11v6",
  edit: "M4 20h4l10.2-10.2a2.1 2.1 0 0 0 0-3L16.2 4.8a2.1 2.1 0 0 0-3 0L3 15v5ZM13.5 5.5l5 5",
  refresh: "M20 11.2A8 8 0 1 0 18.4 17M20 4.8V11h-6",
  download: "M12 3.5v11.2M7.5 10.5 12 15l4.5-4.5M4.5 20.5h15",
  pin: "M12 3.5a5 5 0 0 1 5 5c0 3.7-5 8.4-5 8.4s-5-4.7-5-8.4a5 5 0 0 1 5-5ZM12 10.8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  check: "M4.5 12.5 9.5 17.5 19.5 6.5",
  alert: "M12 3.2 2.8 20h18.4L12 3.2ZM12 9v5M12 17.2v.2",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.2v.2",
  terminal:
    "M3.5 5.5A1.5 1.5 0 0 1 5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5zM7 9l3 3-3 3M13 15h4",
  monitor: "M3.5 4.5h17v12h-17zM9 20.5h6M12 16.5v4",
  memory: "M4 6.5h16v11H4zM7.5 10h3v4h-3zM13.5 10h3v4h-3zM7 17.5v2.5M12 17.5v2.5M17 17.5v2.5",
  disk: "M4 7.5c0-1.9 3.6-3.5 8-3.5s8 1.6 8 3.5-3.6 3.5-8 3.5-8-1.6-8-3.5ZM4 7.5v9c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-9M4 12c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5",
  network: "M12 20.5v-6M4.2 8.2a11 11 0 0 1 15.6 0M7.2 11.4a6.8 6.8 0 0 1 9.6 0M12 17.3v.2",
  play: "M8 5.5 18.5 12 8 18.5z",
  pause: "M9 5.5v13M15 5.5v13",
  "arrow-right": "M4 12h15M13 6l6 6-6 6",
  external:
    "M14 4h6v6M20 4l-9 9M18 14v5.2A1.8 1.8 0 0 1 16.2 21H5.8A1.8 1.8 0 0 1 4 19.2V8.8A1.8 1.8 0 0 1 5.8 7H11",
  sliders: "M4 7h7M15 7h5M4 17h3M11 17h9M13 4.5v5M9 14.5v5",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 12h17M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z",
  package: "M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3ZM3.5 7.5 12 12l8.5-4.5M12 12v9",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5.4l3.5 2",
  sparkles:
    "M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM5.5 16l.6 1.4 1.4.6-1.4.6L5.5 20l-.6-1.4L3.5 18l1.4-.6z",
  shield:
    "M12 3 4.5 6v6c0 4.6 3.1 7.6 7.5 9 4.4-1.4 7.5-4.4 7.5-9V6L12 3ZM8.5 12.2l2.4 2.4 4.6-4.8",
  grip: "M9 6.5h.2M14.8 6.5h.2M9 12h.2M14.8 12h.2M9 17.5h.2M14.8 17.5h.2",
};

export default function Icon({ name, size = 16, strokeWidth = 1.55, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={P[name]} />
    </svg>
  );
}
