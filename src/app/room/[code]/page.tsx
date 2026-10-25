import { notFound } from "next/navigation";
import { RoomView } from "../../../components/RoomView";
import { ROOM_ALPHABET, ROOM_CODE_LENGTH } from "../../../lib/sync/protocol";
import { requestIp } from "../../../lib/backend/ip";
import { lookupRoom } from "../../../lib/backend/roomserver";

export const dynamic = "force-dynamic";
const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export default async function RoomPage({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  if (!CODE_RE.test(code)) notFound();
  const found = await lookupRoom(code, requestIp());
  if (!found.ok) {
    if (found.reason === "missing") notFound();
    return (
      <section className="flex flex-col gap-3 pt-10">
        <h1 className="font-display text-d2 leading-none">{found.reason === "limited" ? "Slow down a little." : "The projector is warming up."}</h1>
        <p className="text-body text-muted">
          {found.reason === "limited" ? "Too many tries from this connection. Wait a minute and reload." : "The room server is not answering. Try again shortly."}
        </p>
      </section>
    );
  }
  return <RoomView code={code} title={found.room.title} wsUrl={process.env.WS_PUBLIC_URL || ""} />;
}
