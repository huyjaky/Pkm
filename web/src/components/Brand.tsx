export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#222427" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="#ff4a1f" strokeWidth="3" />
      <circle cx="16" cy="16" r="3.2" fill="#eff0f1" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      Hoenn Link
    </div>
  );
}
