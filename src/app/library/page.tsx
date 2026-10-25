import { Library } from "../../components/Library";
import { PasscodeForm } from "../../components/PasscodeForm";
import { isAuthed } from "../../lib/backend/session";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  if (!isAuthed()) {
    return (
      <section className="flex flex-col items-start gap-5 pt-10 sm:pt-16">
        <h1 className="font-display text-d2 leading-none sm:text-d1">
          The library is
          <br />
          behind a door.
        </h1>
        <p className="max-w-md text-body text-muted">One passcode, once per device. Whoever invited you knows it.</p>
        <PasscodeForm />
      </section>
    );
  }
  return <Library />;
}
