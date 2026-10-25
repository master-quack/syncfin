import { JoinForm } from "../components/JoinForm";
import Link from "next/link";

export default function Home() {
  return (
    <section className="flex flex-col items-start gap-6 pt-10 sm:pt-20">
      <h1 className="font-display text-d2 leading-none sm:text-d1">
        Same film.
        <br />
        Same second.
        <br />
        Different sofas.
      </h1>
      <p className="max-w-md text-body text-muted">Type the code someone sent you. Nobody has to explain where they are in the plot.</p>
      <JoinForm />
      <p className="text-small text-dim">
        Hosting tonight?{" "}
        <Link href="/library" className="text-muted underline underline-offset-4 hover:text-text">
          Pick the film
        </Link>
        .
      </p>
    </section>
  );
}
