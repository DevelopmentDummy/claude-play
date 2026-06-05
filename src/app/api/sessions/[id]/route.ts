import { getServices } from "@/lib/services";
import { softDeleteWithReap } from "@/lib/soft-delete";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();

  return softDeleteWithReap({
    key: id,
    dir: svc.sessions.getSessionDir(id),
    del: () => svc.sessions.deleteSession(id),
    label: "session",
  });
}
