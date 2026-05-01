import Link from "next/link";

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function HistoryButton() {
  return (
    <Link
      href="/history"
      aria-label="History"
      className="flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-[var(--color-muted)] transition-colors hover:text-[var(--color-accent)]"
    >
      <HistoryIcon className="h-5 w-5" />
    </Link>
  );
}
