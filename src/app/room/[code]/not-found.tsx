import Link from "next/link";

export default function RoomNotFound() {
  return (
    <section className="flex flex-col items-start gap-5 pt-10 sm:pt-20">
      <p className="text-small text-muted">Wrong door</p>
      <h1 className="font-display text-d2 leading-none sm:text-d1">
        That room does not
        <br />
        exist (anymore).
      </h1>
      <p className="max-w-md text-body text-muted">
        Rooms are tidied away three days after the last visitor leaves. Codes are also easy to mistype. Check it with whoever sent it.
      </p>
      <Link href="/" className="rounded bg-text px-5 py-3 text-body font-semibold text-bg hover:bg-muted">
        Try another code
      </Link>
    </section>
  );
}
