import { getServices } from "@/lib/services";
import { softDeleteWithReap } from "@/lib/soft-delete";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();

  return softDeleteWithReap({
    key: name,
    dir: sessions.getPersonaDir(name),
    del: () => sessions.deletePersona(name),
    label: "persona",
  });
}
