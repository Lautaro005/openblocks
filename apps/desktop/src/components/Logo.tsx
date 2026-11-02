/** The OpenBlocks mark: three blocks of a page on an ink tile, the last one a checked task. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="15" fill="var(--logo-tile, #1d1c1a)" />
      <rect x="14" y="15" width="36" height="9" rx="4.5" fill="var(--logo-a, #f6f3ec)" />
      <rect x="14" y="28" width="26" height="9" rx="4.5" fill="var(--logo-b, #f6f3ec)" fillOpacity="0.62" />
      <rect x="14" y="41" width="9" height="9" rx="3" fill="var(--logo-c, #e8b04a)" />
      <rect x="27" y="41" width="19" height="9" rx="4.5" fill="var(--logo-b, #f6f3ec)" fillOpacity="0.38" />
    </svg>
  );
}
