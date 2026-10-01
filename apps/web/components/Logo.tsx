/** Fluxtify mark: three film frames flowing into motion. Brand violet, pink and coral. */
export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden fill="none">
      <path fill="#8b5cf6" fillRule="evenodd" d="M5 5.5H15C19.5 5.5 22.5 3.9 29.5 4.3C26 7.7 21 11.5 15 11.5H5A2 2 0 0 1 3 9.5V7.5A2 2 0 0 1 5 5.5ZM6 7.5V9.5H8V7.5Z" />
      <path fill="#ec4899" fillRule="evenodd" d="M5 13H15C19.5 13 22.5 11.4 29.5 11.8C26 15.2 21 19 15 19H5A2 2 0 0 1 3 17V15A2 2 0 0 1 5 13ZM6 15V17H8V15Z" />
      <path fill="#fb7a5a" fillRule="evenodd" d="M5 20.5H15C19.5 20.5 22.5 18.9 29.5 19.3C26 22.7 21 26.5 15 26.5H5A2 2 0 0 1 3 24.5V22.5A2 2 0 0 1 5 20.5ZM6 22.5V24.5H8V22.5Z" />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <span>Fluxtify</span>
    </span>
  );
}
