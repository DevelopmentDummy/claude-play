"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import PersonaCard from "@/components/PersonaCard";
import SessionCard from "@/components/SessionCard";
import ProfileCard from "@/components/ProfileCard";
import NewPersonaDialog from "@/components/NewPersonaDialog";
import NewProfileDialog from "@/components/NewProfileDialog";
import ProfileSelectDialog from "@/components/ProfileSelectDialog";

interface Persona {
  name: string;
  displayName: string;
}

interface Session {
  id: string;
  persona: string;
  title: string;
  createdAt: string;
}

interface ProfileOption {
  slug: string;
  name: string;
}

export default function LobbyPage() {
  const router = useRouter();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [selectDialog, setSelectDialog] = useState<{
    open: boolean;
    personaName: string;
    personaDisplayName: string;
  }>({ open: false, personaName: "", personaDisplayName: "" });

  const loadLobby = useCallback(async () => {
    const [pRes, sRes, prRes] = await Promise.all([
      fetch("/api/personas"),
      fetch("/api/sessions"),
      fetch("/api/profiles"),
    ]);
    if (pRes.ok) setPersonas(await pRes.json());
    if (sRes.ok) setSessions(await sRes.json());
    if (prRes.ok) setProfiles(await prRes.json());
  }, []);

  useEffect(() => {
    loadLobby();
  }, [loadLobby]);

  const handlePersonaClick = (personaName: string, displayName: string) => {
    setSelectDialog({
      open: true,
      personaName,
      personaDisplayName: displayName,
    });
  };

  const startSession = async (personaName: string, profileSlug?: string) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaName, profileSlug }),
    });
    if (res.ok) {
      const session = await res.json();
      router.push(`/chat/${encodeURIComponent(session.id)}`);
    }
  };

  const createProfile = async (
    name: string,
    description: string
  ): Promise<ProfileOption> => {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    const data = await res.json();
    setProfiles((prev) => [...prev, { slug: data.slug, name: data.name }]);
    return { slug: data.slug, name: data.name };
  };

  const deleteProfile = async (slug: string) => {
    if (!confirm("Delete this profile?")) return;
    await fetch(`/api/profiles/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    setProfiles((prev) => prev.filter((p) => p.slug !== slug));
  };

  const deleteSession = async (id: string) => {
    if (!confirm(`Delete this session?`)) return;
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    loadLobby();
  };

  const startBuilder = (name: string) => {
    router.push(`/builder/${encodeURIComponent(name)}?mode=new`);
  };

  const editPersona = (name: string) => {
    router.push(`/builder/${encodeURIComponent(name)}?mode=edit`);
  };

  return (
    <div className="flex flex-col h-screen">
      <div className="px-6 py-5 pb-3.5 border-b border-border bg-surface backdrop-blur-[16px]">
        <h1 className="text-lg font-semibold tracking-tight">Claude Bridge</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-xs font-semibold text-text-dim uppercase tracking-widest">
              Personas
            </h2>
            <button
              onClick={() => setDialogOpen(true)}
              className="px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text hover:-translate-y-px transition-all duration-fast"
            >
              + New
            </button>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {personas.length === 0 ? (
              <div className="p-3.5 px-[18px] bg-surface border border-dashed border-border rounded-xl text-text-dim text-center min-w-[180px]">
                No personas yet. Click &quot;+ New&quot; to create one.
              </div>
            ) : (
              personas.map((p) => (
                <PersonaCard
                  key={p.name}
                  name={p.name}
                  displayName={p.displayName}
                  onSelect={() => handlePersonaClick(p.name, p.displayName)}
                  onEdit={() => editPersona(p.name)}
                />
              ))
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-xs font-semibold text-text-dim uppercase tracking-widest">
              Profiles
            </h2>
            <button
              onClick={() => setProfileDialogOpen(true)}
              className="px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text hover:-translate-y-px transition-all duration-fast"
            >
              + New
            </button>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {profiles.length === 0 ? (
              <div className="p-3.5 px-[18px] bg-surface border border-dashed border-border rounded-xl text-text-dim text-center min-w-[180px]">
                No profiles yet. Click &quot;+ New&quot; to create one.
              </div>
            ) : (
              profiles.map((p) => (
                <ProfileCard
                  key={p.slug}
                  name={p.name}
                  onDelete={() => deleteProfile(p.slug)}
                />
              ))
            )}
          </div>
        </section>

        <section>
          <h2 className="text-xs font-semibold text-text-dim uppercase tracking-widest mb-2.5">
            Sessions
          </h2>
          <div className="flex flex-wrap gap-2.5">
            {sessions.length === 0 ? (
              <div className="p-3.5 px-[18px] bg-surface border border-dashed border-border rounded-xl text-text-dim text-center min-w-[180px]">
                No sessions yet
              </div>
            ) : (
              sessions.map((s) => (
                <SessionCard
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  persona={s.persona}
                  createdAt={s.createdAt}
                  onOpen={() =>
                    router.push(`/chat/${encodeURIComponent(s.id)}`)
                  }
                  onDelete={() => deleteSession(s.id)}
                />
              ))
            )}
          </div>
        </section>
      </div>

      <NewPersonaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={startBuilder}
      />

      <NewProfileDialog
        open={profileDialogOpen}
        onClose={() => setProfileDialogOpen(false)}
        onSave={(name, description) => createProfile(name, description)}
      />

      <ProfileSelectDialog
        open={selectDialog.open}
        personaDisplayName={selectDialog.personaDisplayName}
        profiles={profiles}
        onClose={() =>
          setSelectDialog({ open: false, personaName: "", personaDisplayName: "" })
        }
        onStart={(profileSlug) => {
          setSelectDialog({ open: false, personaName: "", personaDisplayName: "" });
          startSession(selectDialog.personaName, profileSlug);
        }}
        onCreateProfile={createProfile}
      />
    </div>
  );
}
