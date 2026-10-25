import Link from "next/link";

export default function NotFound() {
  return (
    <section className="flex flex-col items-start gap-5 pt-10 sm:pt-20">
      <p className="text-small text-muted">Error 404</p>
      <h1 className="font-display text-d2 leading-none sm:text-d1">
        This page left
        <br />
        during the interval.
      </h1>
      <p className="max-w-md text-body text-muted">Nothing lives at this address. It may never have.</p>
      <Link href="/" className="rounded bg-text px-5 py-3 text-body font-semibold text-bg hover:bg-muted">
        Back to the foyer
      </Link>
    </section>
  );
}
