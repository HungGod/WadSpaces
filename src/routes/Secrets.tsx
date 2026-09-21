import { useEffect, useState } from "react";
import { Field, Notice, PageTitle, Section, useBusy } from "../components/ui";
import { wadd } from "../lib/wadd";

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export default function Secrets() {
  const [names, setNames] = useState<string[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, setError, run } = useBusy();

  const load = () => wadd.secrets().then(setNames).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!NAME_RE.test(name)) return setError("Names may use letters, digits, dot, dash and underscore.");
    await run("save", async () => {
      await wadd.setSecret(name, value);
      setSaved(name);
      setName("");
      setValue("");
      await load();
    });
  };

  return (
    <>
      <PageTitle
        title="Secrets"
        sub="Stored in this machine's podman secret store and mounted read-only into workspaces at /run/secrets/<name>. Values never leave the machine and are never shown again."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Section title="Add or replace">
          <form onSubmit={save} className="space-y-4">
            <Field label="Name" hint="github_token is used for git over HTTPS in every workspace.">
              <input className="field font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="github_token" autoComplete="off" />
            </Field>
            <Field label="Value">
              <textarea
                className="field min-h-24 font-mono"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="github_pat_…"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <button className="btn btn-primary" disabled={!name || !value || busy === "save"}>
              Save secret
            </button>
            {saved && <Notice kind="ok">Saved {saved}. Restart workspaces that use it to pick it up.</Notice>}
          </form>
        </Section>
        <Section title="On this machine">
          {error && <div className="mb-3"><Notice kind="error">{error}</Notice></div>}
          {names === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : names.length === 0 ? (
            <p className="text-sm text-muted">No secrets yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {names.map((n) => (
                <li key={n} className="flex items-center justify-between py-2.5">
                  <span className="font-mono text-sm">{n}</span>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === n}
                    onClick={() => confirm(`Delete secret ${n}?`) && run(n, async () => { await wadd.deleteSecret(n); await load(); })}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
