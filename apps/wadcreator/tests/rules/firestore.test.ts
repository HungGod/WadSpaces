// firestore.rules against the emulator: npm run test:rules
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, runTransaction, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-wadcreator",
    firestore: { rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"), host: "127.0.0.1", port: 8090 },
  });
});
afterAll(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const alice = () => env.authenticatedContext("alice").firestore();
const bob = () => env.authenticatedContext("bob").firestore();
const carol = () => env.authenticatedContext("carol").firestore();
const anon = () => env.unauthenticatedContext().firestore();
const machine = (owner: string, machineId: string) => env.authenticatedContext(`machine:${machineId}`, { role: "machine", owner, machineId }).firestore();

const ws = (owner: string, sharedWith: string[] = []) => ({
  owner,
  ownerName: owner,
  name: "Deep work",
  description: "",
  visibility: sharedWith.length ? "shared" : "private",
  sharedWith,
  sharedNames: {},
  layout: { wallpaper: { type: "color", value: "#000" }, icons: [], grid: true },
  advanced: {},
});

async function seed(path: string, data: object) {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));
}

describe("usernames and profiles", () => {
  const claim = (db: ReturnType<typeof alice>, uid: string, name: string) =>
    runTransaction(db, async (tx) => {
      tx.set(doc(db, "usernames", name), { uid });
      tx.set(doc(db, "profiles", uid), { username: name, displayName: name, color: "#c6ff1f", photoURL: null, onboarded: false });
    });

  it("claims a free username together with the profile", async () => {
    await assertSucceeds(claim(alice(), "alice", "alice"));
  });

  it("can't take a username someone has", async () => {
    await claim(alice(), "alice", "alice");
    await assertFails(claim(bob(), "bob", "alice"));
  });

  it("can't claim a username without the matching profile, or claim a second one", async () => {
    await assertFails(setDoc(doc(alice(), "usernames", "alice"), { uid: "alice" }));
    await claim(alice(), "alice", "alice");
    await assertFails(setDoc(doc(alice(), "usernames", "alice2"), { uid: "alice" }));
  });

  it("can't claim a username for someone else, or a bad one", async () => {
    await assertFails(claim(alice(), "bob", "bob"));
    await assertFails(claim(alice(), "alice", "A!"));
  });

  it("lets anyone check a username but nobody list them", async () => {
    await claim(alice(), "alice", "alice");
    await assertSucceeds(getDoc(doc(anon(), "usernames", "alice")));
    await assertFails(getDocs(collection(anon(), "usernames")));
  });

  it("profiles are readable by signed-in people; the username never changes", async () => {
    await claim(alice(), "alice", "alice");
    await assertSucceeds(getDoc(doc(bob(), "profiles", "alice")));
    await assertFails(getDoc(doc(anon(), "profiles", "alice")));
    await assertSucceeds(updateDoc(doc(alice(), "profiles", "alice"), { onboarded: true, displayName: "Alice" }));
    await assertFails(updateDoc(doc(alice(), "profiles", "alice"), { username: "root" }));
    await assertFails(updateDoc(doc(bob(), "profiles", "alice"), { displayName: "hacked" }));
  });
});

describe("wadspaces", () => {
  it("owners create their own, with a valid id", async () => {
    await assertSucceeds(setDoc(doc(alice(), "wadspaces", "deep-work-abc123"), ws("alice")));
    await assertFails(setDoc(doc(alice(), "wadspaces", "Bad_ID"), ws("alice")));
    await assertFails(setDoc(doc(alice(), "wadspaces", "for-bob-abc123"), ws("bob")));
  });

  it("the owner and people it's shared with can read it; strangers can't", async () => {
    await seed("wadspaces/w1", ws("alice", ["bob"]));
    await assertSucceeds(getDoc(doc(alice(), "wadspaces", "w1")));
    await assertSucceeds(getDoc(doc(bob(), "wadspaces", "w1")));
    await assertFails(getDoc(doc(carol(), "wadspaces", "w1")));
    await assertFails(getDoc(doc(anon(), "wadspaces", "w1")));
  });

  it("the app's two list queries are allowed", async () => {
    await seed("wadspaces/w1", ws("alice", ["bob"]));
    await assertSucceeds(getDocs(query(collection(alice(), "wadspaces"), where("owner", "==", "alice"))));
    await assertSucceeds(getDocs(query(collection(bob(), "wadspaces"), where("sharedWith", "array-contains", "bob"))));
    await assertFails(getDocs(collection(bob(), "wadspaces")));
  });

  it("only the owner edits, never the owner field", async () => {
    await seed("wadspaces/w1", ws("alice", ["bob"]));
    await assertSucceeds(updateDoc(doc(alice(), "wadspaces", "w1"), { name: "Deeper work" }));
    await assertFails(updateDoc(doc(bob(), "wadspaces", "w1"), { name: "mine now" }));
    await assertFails(updateDoc(doc(alice(), "wadspaces", "w1"), { owner: "bob" }));
    await assertFails(deleteDoc(doc(bob(), "wadspaces", "w1")));
    await assertSucceeds(deleteDoc(doc(alice(), "wadspaces", "w1")));
  });

  it("machines read their owner's wadspaces and ones shared with their owner", async () => {
    await seed("wadspaces/w1", ws("alice", ["bob"]));
    await seed("wadspaces/w2", ws("carol"));
    await assertSucceeds(getDoc(doc(machine("alice", "m1"), "wadspaces", "w1")));
    await assertSucceeds(getDoc(doc(machine("bob", "m2"), "wadspaces", "w1")));
    await assertFails(getDoc(doc(machine("alice", "m1"), "wadspaces", "w2")));
    await assertFails(updateDoc(doc(machine("alice", "m1"), "wadspaces", "w1"), { name: "x" }));
  });

  it("a machine token can't act as its owner", async () => {
    await assertFails(setDoc(doc(machine("alice", "m1"), "wadspaces", "from-machine-abc123"), ws("alice")));
  });
});

describe("removed collections", () => {
  it("cloud files and cloud builds are gone: nobody reads or writes them", async () => {
    await seed("files/f1", { owner: "alice", name: "notes.md", linkedWadspaces: [] });
    await seed("builds/b1", { owner: "alice", wadspaceId: "w1", status: "queued" });
    await assertFails(getDoc(doc(alice(), "files", "f1")));
    await assertFails(getDoc(doc(machine("alice", "m1"), "files", "f1")));
    await assertFails(setDoc(doc(alice(), "files", "f2"), { owner: "alice", name: "x", linkedWadspaces: [] }));
    await assertFails(getDoc(doc(alice(), "builds", "b1")));
  });

  it("owners can't queue a files-sync any more", async () => {
    await seed("users/alice/machines/m1", { name: "Surface", lastSeen: null, workspaces: [] });
    await assertFails(addDoc(collection(alice(), "users/alice/machines/m1/commands"), { type: "files-sync", status: "pending" }));
  });
});

describe("drafts and secrets", () => {
  it("drafts are private", async () => {
    await assertSucceeds(setDoc(doc(alice(), "users/alice/drafts/d1"), { name: "x" }));
    await assertFails(getDoc(doc(bob(), "users/alice/drafts/d1")));
  });

  it("secrets: the owner writes, the owner's machines read", async () => {
    await assertSucceeds(setDoc(doc(alice(), "users/alice/secrets/github_token"), { value: "t" }));
    await assertSucceeds(getDoc(doc(machine("alice", "m1"), "users/alice/secrets/github_token")));
    await assertFails(getDoc(doc(machine("bob", "m2"), "users/alice/secrets/github_token")));
    await assertFails(getDoc(doc(bob(), "users/alice/secrets/github_token")));
  });
});

describe("machines and the relay", () => {
  beforeEach(() => seed("users/alice/machines/m1", { name: "Surface", hostname: "wad", lastSeen: null, workspaces: [] }));

  it("the machine heartbeats; its owner can only rename it", async () => {
    await assertSucceeds(updateDoc(doc(machine("alice", "m1"), "users/alice/machines/m1"), { lastSeen: new Date(), workspaces: [], metrics: { cpu: 3 } }));
    await assertFails(updateDoc(doc(machine("alice", "m2"), "users/alice/machines/m1"), { lastSeen: new Date() }));
    await assertFails(updateDoc(doc(machine("alice", "m1"), "users/alice/machines/m1"), { name: "renamed by machine" }));
    await assertSucceeds(updateDoc(doc(alice(), "users/alice/machines/m1"), { name: "Surface at home" }));
    await assertFails(updateDoc(doc(alice(), "users/alice/machines/m1"), { lastSeen: new Date() }));
  });

  it("machines read their siblings, not other people's machines, and write only their own", async () => {
    await seed("users/alice/machines/m2", { name: "Laptop", lastSeen: null, workspaces: [] });
    await seed("users/bob/machines/m9", { name: "Bob's", lastSeen: null, workspaces: [] });
    await assertSucceeds(getDoc(doc(machine("alice", "m2"), "users/alice/machines/m1")));
    await assertSucceeds(getDocs(collection(machine("alice", "m2"), "users/alice/machines")));
    await assertFails(getDoc(doc(machine("bob", "m9"), "users/alice/machines/m1")));
    await assertFails(getDoc(doc(machine("alice", "m1"), "users/bob/machines/m9")));
    await assertFails(updateDoc(doc(machine("alice", "m2"), "users/alice/machines/m1"), { lastSeen: new Date() }));
    await assertFails(getDocs(collection(machine("alice", "m2"), "users/alice/machines/m1/commands")));
  });

  it("the heartbeat may carry the tailnet address, stream links and mounted projects, not Syncthing", async () => {
    await assertSucceeds(
      updateDoc(doc(machine("alice", "m1"), "users/alice/machines/m1"), {
        lastSeen: new Date(),
        tailnet: { ip: "100.64.0.1", dnsName: "wad.tail.ts.net", stableId: "n1", online: true },
        streams: [{ wsId: "w1", url: "https://wad.tail.ts.net:3100/" }],
        mountedProjects: ["p1", "p2"],
      }),
    );
    await assertFails(updateDoc(doc(machine("alice", "m1"), "users/alice/machines/m1"), { syncthing: { deviceId: "ABC" } }));
    await assertFails(updateDoc(doc(machine("alice", "m2"), "users/alice/machines/m1"), { mountedProjects: [] }));
  });

  it("the heartbeat's fields have the types the apps read", async () => {
    const m1 = () => doc(machine("alice", "m1"), "users/alice/machines/m1");
    await assertSucceeds(updateDoc(m1(), { lastSeen: new Date(), view: "workspace:w1", workspaces: [{ id: "w1", phase: "ready" }], mountedProjects: [] }));
    await assertSucceeds(updateDoc(m1(), { view: null }));
    await assertFails(updateDoc(m1(), { lastSeen: "yesterday" }));
    await assertFails(updateDoc(m1(), { workspaces: "w1" }));
    await assertFails(updateDoc(m1(), { mountedProjects: { p1: true } }));
    await assertFails(updateDoc(m1(), { view: 3 }));
  });

  it("owners can send the Rust wadd home", async () => {
    await assertSucceeds(addDoc(collection(alice(), "users/alice/machines/m1/commands"), { type: "home", status: "pending" }));
  });

  it("owners can ask for a projects sync or a launch", async () => {
    const cmds = "users/alice/machines/m1/commands";
    await assertSucceeds(addDoc(collection(alice(), cmds), { type: "projects-sync", status: "pending" }));
    await assertSucceeds(addDoc(collection(alice(), cmds), { type: "launch", wsId: "w1", projects: ["p1"], status: "pending" }));
    await assertFails(addDoc(collection(bob(), cmds), { type: "launch", wsId: "w1", status: "pending" }));
  });

  it("owners queue known commands; the machine updates their status", async () => {
    const cmds = "users/alice/machines/m1/commands";
    await assertSucceeds(addDoc(collection(alice(), cmds), { type: "switch", wsId: "w1", status: "pending" }));
    await assertFails(addDoc(collection(alice(), cmds), { type: "rm -rf", status: "pending" }));
    await assertFails(addDoc(collection(bob(), cmds), { type: "switch", wsId: "w1", status: "pending" }));
    await seed(`${cmds}/c1`, { type: "switch", wsId: "w1", status: "pending" });
    await assertSucceeds(updateDoc(doc(machine("alice", "m1"), `${cmds}/c1`), { status: "done" }));
    await assertFails(updateDoc(doc(machine("alice", "m1"), `${cmds}/c1`), { type: "stop" }));
  });
});

describe("projects", () => {
  const P = "users/alice/projects";
  const project = (extra: object = {}) => ({
    name: "Writing",
    mountName: "Writing",
    source: { kind: "git", url: "https://github.com/HungGod/Writing.git" },
    setup: "",
    deleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });

  it("the owner creates, reads, edits and deletes them", async () => {
    await assertSucceeds(setDoc(doc(alice(), `${P}/p1`), project()));
    await assertSucceeds(getDoc(doc(alice(), `${P}/p1`)));
    await assertSucceeds(getDocs(collection(alice(), P)));
    await assertSucceeds(updateDoc(doc(alice(), `${P}/p1`), { name: "Vault", mountName: "Vault", updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(alice(), `${P}/p1`), { source: { kind: "git", url: "https://github.com/HungGod/Writing", ref: "drafts" } }));
    await assertSucceeds(updateDoc(doc(alice(), `${P}/p1`), { deleted: true }));
    await assertSucceeds(deleteDoc(doc(alice(), `${P}/p1`)));
  });

  it("the owner's machines read, create and update, but don't delete", async () => {
    const m1 = machine("alice", "m1");
    await assertSucceeds(setDoc(doc(m1, `${P}/fromMachine01`), project()));
    await assertSucceeds(getDocs(collection(m1, P)));
    await assertSucceeds(updateDoc(doc(m1, `${P}/fromMachine01`), { name: "Renamed offline", updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(machine("alice", "m2"), `${P}/fromMachine01`), { setup: "npm install", updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(m1, `${P}/fromMachine01`), { deleted: true, updatedAt: new Date() }));
    await assertFails(deleteDoc(doc(m1, `${P}/fromMachine01`)));
  });

  it("other people and other people's machines get nothing", async () => {
    await seed(`${P}/p1`, project());
    await assertFails(getDoc(doc(bob(), `${P}/p1`)));
    await assertFails(setDoc(doc(bob(), `${P}/p2`), project()));
    await assertFails(updateDoc(doc(bob(), `${P}/p1`), { name: "x" }));
    await assertFails(deleteDoc(doc(bob(), `${P}/p1`)));
    await assertFails(getDoc(doc(machine("bob", "m9"), `${P}/p1`)));
    await assertFails(setDoc(doc(machine("bob", "m9"), `${P}/p3`), project()));
    await assertFails(getDoc(doc(anon(), `${P}/p1`)));
  });

  it("a GitHub project is an https github.com URL", async () => {
    for (const url of [
      "git@github.com:HungGod/Writing.git",
      "http://github.com/HungGod/Writing",
      "https://gitlab.com/HungGod/Writing",
      "https://github.com/HungGod",
      "https://github.com/HungGod/Writing/tree/main",
      "https://github.com.evil.io/a/b",
    ]) {
      await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ source: { kind: "git", url } })));
    }
    for (const source of [{ kind: "", url: "https://github.com/a/b" }, { kind: "empty" }, { kind: "local" }, { kind: "git" }, { kind: "git", url: 7 }, "https://github.com/a/b"]) {
      await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ source })));
    }
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ source: { kind: "git", url: "https://github.com/a/b", ref: 3 } })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ source: { kind: "git", url: "https://github.com/a/b", extra: true } })));
    const { source: _s, ...noSource } = project();
    await assertFails(setDoc(doc(alice(), `${P}/p1`), noSource));
    await assertSucceeds(setDoc(doc(alice(), `${P}/p1`), project({ source: { kind: "git", url: "https://github.com/some-org/my.repo_2" } })));
  });

  it("a project can be a folder on one machine", async () => {
    const folder = (extra: object = {}) => ({ kind: "folder", machineId: "m1", machineName: "Surface", path: "/var/home/wad/Notes", ...extra });
    await assertSucceeds(setDoc(doc(alice(), `${P}/f1`), project({ source: folder() })));
    await assertSucceeds(setDoc(doc(machine("alice", "m1"), `${P}/f2`), project({ source: folder({ machineId: "", machineName: "" }) })));
    await assertFails(setDoc(doc(alice(), `${P}/f3`), project({ source: folder({ path: "var/home/wad/Notes" }) })));
    await assertFails(setDoc(doc(alice(), `${P}/f3`), project({ source: folder({ path: "" }) })));
    await assertFails(setDoc(doc(alice(), `${P}/f3`), project({ source: folder({ path: 7 }) })));
    await assertFails(setDoc(doc(alice(), `${P}/f3`), project({ source: folder({ machineId: null }) })));
    await assertFails(setDoc(doc(alice(), `${P}/f3`), project({ source: { kind: "folder", path: "/x" } })));
    await assertFails(setDoc(doc(alice(), `${P}/f3`), project({ source: folder({ url: "https://github.com/a/b" }) })));
  });

  it("a project can be a drive, or a folder inside one", async () => {
    const drive = (extra: object = {}) => ({ kind: "drive", uuid: "0f6e7c1a-58b2-4c1e-9f0a-6d2a1b3c4d5e", label: "Photos", fstype: "ext4", subpath: "", ...extra });
    await assertSucceeds(setDoc(doc(alice(), `${P}/d1`), project({ source: drive() })));
    await assertSucceeds(setDoc(doc(machine("alice", "m1"), `${P}/d2`), project({ source: drive({ uuid: "1234-ABCD", subpath: "Pictures/2026" }) })));
    for (const uuid of ["abc", "has space", "x".repeat(65), "../../etc", 12345]) {
      await assertFails(setDoc(doc(alice(), `${P}/d3`), project({ source: drive({ uuid }) })));
    }
    for (const subpath of ["..", "../etc", "a/../../b", null]) {
      await assertFails(setDoc(doc(alice(), `${P}/d3`), project({ source: drive({ subpath }) })));
    }
    await assertFails(setDoc(doc(alice(), `${P}/d3`), project({ source: drive({ label: 1 }) })));
    await assertFails(setDoc(doc(alice(), `${P}/d3`), project({ source: { kind: "drive", uuid: "1234-ABCD" } })));
  });

  it("an unknown kind is refused", async () => {
    for (const kind of ["", "empty", "local", "ftp", "Git", null]) {
      await assertFails(setDoc(doc(alice(), `${P}/k1`), project({ source: { kind, url: "https://github.com/a/b" } })));
    }
  });

  it("the Syncthing fields are gone", async () => {
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ holders: {} })));
    await assertFails(setDoc(doc(machine("alice", "m1"), `${P}/p1`), project({ holders: { m1: { state: "idle" } } })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ ignore: ["node_modules"] })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ folderId: "wad-p1" })));
    await seed(`${P}/p1`, project());
    await assertFails(updateDoc(doc(machine("alice", "m1"), `${P}/p1`), { "holders.m1": { state: "idle" } }));
  });

  it("checks the document: folder name, field types, no local-only fields", async () => {
    for (const mountName of ["", ".", "..", "a/b", "has space", "x".repeat(65)]) {
      await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ mountName })));
    }
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ name: "" })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ setup: 1 })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ deleted: "no" })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ updatedAt: 123 })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ synced: true })));
    await assertFails(setDoc(doc(alice(), `${P}/p1`), project({ legacy: true })));
    await assertFails(setDoc(doc(machine("alice", "m1"), `${P}/p1`), project({ mountName: "../etc" })));
    await assertFails(setDoc(doc(alice(), `${P}/bad.id`), project()));
    await seed(`${P}/p1`, project());
    await assertFails(updateDoc(doc(alice(), `${P}/p1`), { mountName: "no/slash" }));
    await assertFails(updateDoc(doc(machine("alice", "m1"), `${P}/p1`), { source: { kind: "empty" } }));
  });
});

describe("github repos", () => {
  const R = "users/alice/github/repos";
  const list = (extra: object = {}) => ({
    login: "HungGod",
    repos: [
      {
        fullName: "HungGod/Writing",
        name: "Writing",
        private: true,
        url: "https://github.com/HungGod/Writing",
        defaultBranch: "main",
        pushedAt: "2026-09-30T12:00:00Z",
        description: null,
      },
    ],
    updatedAt: new Date(),
    ...extra,
  });

  it("the owner's machines write the list; the owner reads it", async () => {
    await assertSucceeds(setDoc(doc(machine("alice", "m1"), R), list()));
    await assertSucceeds(setDoc(doc(machine("alice", "m2"), R), list({ repos: [] })));
    await assertSucceeds(updateDoc(doc(machine("alice", "m1"), R), { repos: [], updatedAt: new Date() }));
    await assertSucceeds(getDoc(doc(alice(), R)));
  });

  it("nobody else reads or writes it, and the owner doesn't write it", async () => {
    await seed(R, list());
    await assertFails(getDoc(doc(bob(), R)));
    await assertFails(getDoc(doc(machine("bob", "m9"), R)));
    await assertFails(getDoc(doc(anon(), R)));
    await assertFails(setDoc(doc(machine("bob", "m9"), R), list()));
    await assertFails(setDoc(doc(bob(), R), list()));
    await assertFails(setDoc(doc(alice(), R), list()));
    await assertFails(deleteDoc(doc(machine("alice", "m1"), R)));
  });

  it("only the repos doc, in its shape", async () => {
    const m1 = machine("alice", "m1");
    await assertFails(setDoc(doc(m1, "users/alice/github/token"), list()));
    await assertFails(setDoc(doc(m1, R), list({ login: null })));
    await assertFails(setDoc(doc(m1, R), list({ repos: {} })));
    await assertFails(setDoc(doc(m1, R), list({ updatedAt: 123 })));
    await assertFails(setDoc(doc(m1, R), list({ token: "ghp_x" })));
  });
});

describe("enroll codes", () => {
  it("signed-in people create unused codes for themselves only", async () => {
    await assertSucceeds(setDoc(doc(alice(), "enrollCodes", "ABCD2345"), { uid: "alice", used: false, machineName: "x" }));
    await assertFails(setDoc(doc(alice(), "enrollCodes", "EFGH2345"), { uid: "bob", used: false }));
    await assertFails(setDoc(doc(alice(), "enrollCodes", "bad"), { uid: "alice", used: false }));
    await assertFails(getDoc(doc(alice(), "enrollCodes", "ABCD2345")));
  });
});

// A write batch the app never makes, to be sure the transaction path is what passes.
describe("sanity", () => {
  it("a batch can't create a profile for a username owned by someone else", async () => {
    await seed("usernames/taken", { uid: "bob" });
    const db = alice();
    const b = writeBatch(db);
    b.set(doc(db, "profiles", "alice"), { username: "taken", displayName: "x", color: "#fff", photoURL: null, onboarded: false });
    await assertFails(b.commit());
  });
});
