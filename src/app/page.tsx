"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import PersonaCard from "@/components/PersonaCard";
import SessionCard from "@/components/SessionCard";
import ProfileCard from "@/components/ProfileCard";
import NewPersonaDialog from "@/components/NewPersonaDialog";
import NewProfileDialog from "@/components/NewProfileDialog";
import PersonaStartModal from "@/components/PersonaStartModal";

const PERSONA_ACCENTS = [
  "var(--accent)",
  "#ff6482",
  "#4dff91",
  "#ffa64d",
  "#64c8ff",
  "#c882ff",
];

interface Persona {
  name: string;
  displayName: string;
  hasIcon?: boolean;
}

interface Session {
  id: string;
  persona: string;
  displayName?: string;
  title: string;
  createdAt: string;
  hasIcon?: boolean;
  model?: string;
}

interface ProfileOption {
  slug: string;
  name: string;
  isPrimary?: boolean;
}

export default function LobbyPage() {
  const router = useRouter();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<{
    slug: string;
    name: string;
    description: string;
    isPrimary?: boolean;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== "undefined") return window.innerWidth >= 768;
    return true;
  });
  const [startModal, setStartModal] = useState<{
    open: boolean;
    personaName: string;
    personaDisplayName: string;
    accentColor: string;
  }>({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });

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

  const handlePersonaClick = (personaName: string, displayName: string, index: number) => {
    setStartModal({
      open: true,
      personaName,
      personaDisplayName: displayName,
      accentColor: PERSONA_ACCENTS[index % PERSONA_ACCENTS.length],
    });
  };

  const startSession = async (personaName: string, profileSlug?: string, model?: string) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaName, profileSlug }),
    });
    if (res.ok) {
      const session = await res.json();
      const q = model ? `?model=${encodeURIComponent(model)}` : "";
      router.push(`/chat/${encodeURIComponent(session.id)}${q}`);
    }
  };

  const createProfile = async (
    name: string,
    description: string,
    isPrimary?: boolean
  ): Promise<ProfileOption> => {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, isPrimary }),
    });
    const data = await res.json();
    if (isPrimary) {
      // Update local state to clear other primaries
      setProfiles((prev) =>
        prev.map((p) => ({ ...p, isPrimary: false }))
      );
    }
    const newProfile = { slug: data.slug, name: data.name, isPrimary };
    setProfiles((prev) => [...prev, newProfile]);
    return newProfile;
  };

  const editProfile = async (slug: string) => {
    const res = await fetch(`/api/profiles/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data = await res.json();
    setEditingProfile({
      slug: data.slug,
      name: data.name,
      description: data.description || "",
      isPrimary: data.isPrimary,
    });
    setProfileDialogOpen(true);
  };

  const saveProfile = async (name: string, description: string, isPrimary?: boolean) => {
    if (editingProfile) {
      await fetch(`/api/profiles/${encodeURIComponent(editingProfile.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, isPrimary }),
      });
      setEditingProfile(null);
      loadLobby();
    } else {
      await createProfile(name, description, isPrimary);
    }
  };

  const deleteProfile = async (slug: string) => {
    await fetch(`/api/profiles/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    setProfiles((prev) => prev.filter((p) => p.slug !== slug));
  };

  const deleteSession = async (id: string) => {
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
    <div className="flex h-screen relative">
      {/* ── Mobile sidebar backdrop ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar: Sessions ── */}
      <aside
        className={`shrink-0 flex flex-col border-r border-border bg-surface/50 backdrop-blur-[16px] transition-all duration-normal overflow-hidden
          fixed inset-y-0 left-0 z-40 md:relative md:z-auto ${
          sidebarOpen ? "w-[280px]" : "w-0 border-r-0"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <span className="text-sm font-semibold text-text-dim uppercase tracking-wider">
            Sessions
          </span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim/60 cursor-pointer
              hover:bg-surface-light hover:text-text transition-all duration-fast text-base"
          >
            &lsaquo;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {sessions.length === 0 ? (
            <p className="text-text-dim/50 text-sm text-center py-10">
              No sessions yet
            </p>
          ) : (
            sessions.map((s) => (
              <SessionCard
                key={s.id}
                id={s.id}
                title={s.displayName || s.title}
                persona={s.displayName || s.persona}
                createdAt={s.createdAt}
                hasIcon={s.hasIcon}
                model={s.model}
                onOpen={() => {
                  router.push(`/chat/${encodeURIComponent(s.id)}`);
                  if (window.innerWidth < 768) setSidebarOpen(false);
                }}
                onDelete={() => deleteSession(s.id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="relative flex items-center gap-3 px-4 py-3 md:px-6 md:py-4 border-b border-border bg-surface/30 backdrop-blur-[16px]">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim cursor-pointer
                border border-border/40 hover:bg-surface-light hover:text-text transition-all duration-fast text-sm"
            >
              &rsaquo;
            </button>
          )}
          <div className="flex items-end gap-2.5">
            <h1 className="text-xl tracking-tight" style={{ fontWeight: 300, letterSpacing: "-0.02em" }}>
              <span className="text-accent" style={{ fontWeight: 600 }}>Claude</span>
              <span className="text-text-dim" style={{ fontWeight: 300 }}>{" "}Bridge</span>
            </h1>
          </div>

          {/* right side: profiles */}
          <div className="ml-auto flex items-center gap-1.5 md:gap-2.5 overflow-x-auto">
            {profiles.map((p) => (
              <ProfileCard
                key={p.slug}
                name={p.name}
                isPrimary={p.isPrimary}
                onEdit={() => editProfile(p.slug)}
                onDelete={() => deleteProfile(p.slug)}
              />
            ))}
            <button
              onClick={() => {
                setEditingProfile(null);
                setProfileDialogOpen(true);
              }}
              className="w-8 h-8 flex items-center justify-center rounded-full text-text-dim/60 cursor-pointer
                border border-border/40 hover:bg-surface-light hover:text-text hover:border-border/60 transition-all duration-fast text-sm"
              title="Add profile"
            >
              +
            </button>
          </div>
        </header>

        {/* Persona Area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[860px] mx-auto px-4 py-8 md:px-8 md:py-12">
            {/* Hero text */}
            <div className="text-center mb-8 md:mb-10 animate-[slideUp_0.4s_ease_both]">
              <h2 className="text-2xl md:text-3xl font-light text-text tracking-tight mb-2.5" style={{ letterSpacing: "-0.03em" }}>
                Who would you like to meet?
              </h2>
              <p className="text-base text-text-dim/70">
                Choose a persona to start a new session
              </p>
            </div>

            {/* Persona Grid */}
            <div
              className="grid gap-3 md:gap-5 mb-8 animate-[slideUp_0.4s_ease_0.08s_both]"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 100%), 1fr))" }}
            >
              {personas.map((p, i) => (
                <PersonaCard
                  key={p.name}
                  name={p.name}
                  displayName={p.displayName}
                  hasIcon={p.hasIcon}
                  index={i}
                  onSelect={() => handlePersonaClick(p.name, p.displayName, i)}
                  onEdit={() => editPersona(p.name)}
                />
              ))}

              {/* Create new persona card */}
              <div
                className="flex flex-col items-center justify-center gap-3 py-12 rounded-2xl cursor-pointer
                  border border-dashed border-border/50 transition-all duration-normal
                  hover:border-accent/40 hover:bg-accent/5"
                onClick={() => setDialogOpen(true)}
              >
                <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center border border-accent/20">
                  <span className="text-accent text-xl font-light">+</span>
                </div>
                <span className="text-sm text-text-dim">New Persona</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      <NewPersonaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={startBuilder}
      />

      <NewProfileDialog
        open={profileDialogOpen}
        onClose={() => {
          setProfileDialogOpen(false);
          setEditingProfile(null);
        }}
        onSave={saveProfile}
        editData={editingProfile}
      />

      <PersonaStartModal
        open={startModal.open}
        personaName={startModal.personaName}
        personaDisplayName={startModal.personaDisplayName}
        accentColor={startModal.accentColor}
        profiles={profiles}
        onClose={() =>
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" })
        }
        onStart={(profileSlug, model) => {
          const pName = startModal.personaName;
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });
          startSession(pName, profileSlug, model);
        }}
      />
    </div>
  );
}
