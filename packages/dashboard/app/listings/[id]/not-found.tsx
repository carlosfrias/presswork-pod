import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto mt-24 max-w-md rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-8 text-center">
      <h1 className="font-display text-xl font-semibold text-(--text-primary)">
        Listing not found
      </h1>
      <p className="mt-2 text-sm text-(--text-muted)">
        The ID you opened either doesn&apos;t exist or has been deleted.
      </p>
      <Link
        href="/listings"
        className="mt-6 inline-block rounded-(--radius-sm) bg-(--surface-2) px-4 py-2 text-sm text-(--text-primary) hover:bg-(--surface-3)"
      >
        Back to listings
      </Link>
    </div>
  );
}
