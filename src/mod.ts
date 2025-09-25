// env.ts
// Bun + TypeScript environment variable helper using Bun Shell ($).
// Usage examples (see bottom).
//
// Notes:
// - On Windows, persistent changes modify User environment via PowerShell:
//   [Environment]::GetEnvironmentVariable / SetEnvironmentVariable
// - On POSIX, persistent changes edit ~/.profile (simple, not exhaustive).
// - This script is intentionally conservative: it backups files / outputs diffs.
// 
// @see https://github.com/relivator/sysutils
// @see https://stackoverflow.com/questions/714877/setting-windows-powershell-environment-variables

import { $ } from "bun";
import fs from "node:fs/promises";

type Cmd = "list" | "get" | "set" | "append" | "remove" | "contains";

function isWindows() {
  // Bun.platform() returns "win32" on Windows
  // fallback: check process.platform
  return (globalThis as any).Bun?.platform?.() === "win32" || process.platform === "win32";
}

function usage() {
  console.log(`
env.ts - Edit environment variables (Bun shell helper)

Usage:
  bun run env.ts <command> <NAME> [VALUE] [--persist] [--yes]

Commands:
  list <NAME?>         List environment variables or specific NAME
  get  <NAME>          Print effective value of NAME
  set  <NAME> <VALUE>  Set NAME to VALUE (process). Use --persist to make User-level persistent.
  append <NAME> <VALUE>  Append VALUE to NAME (path-like). Avoids duplicates.
  remove <NAME> <VALUE>  Remove VALUE from NAME (if present).
  contains <NAME> <VALUE>  Exit 0 if VALUE is present, else 1.

Options:
  --persist    Persist change to User environment (Windows registry or ~/.profile on POSIX)
  --yes        Skip interactive confirmation (useful for scripts)

Examples:
  bun run env.ts append Path "C:\\msys64\\ucrt64\\bin" --persist
  bun run env.ts get Path
  bun run env.ts list
`);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    process.exit(1);
  }
  const cmd = argv[0] as Cmd;
  const name = argv[1];
  const value = argv[2];
  const persist = argv.includes("--persist");
  const yes = argv.includes("--yes");
  return { cmd, name, value, persist, yes };
}

async function runPowerShellGetUser(name: string) {
  const ps = await $`powershell -NoProfile -Command [Environment]::GetEnvironmentVariable(${name}, 'User')`.text();
  return ps;
}

async function runPowerShellSetUser(name: string, value: string) {
  // Use SetEnvironmentVariable on User level
  await $`powershell -NoProfile -Command [Environment]::SetEnvironmentVariable(${name}, ${value}, 'User')`;
}

function normalizePathEntries(raw: string) {
  // split by semicolon (Windows) or colon (POSIX)
  if (isWindows()) {
    return raw.split(";").map(s => s.trim()).filter(Boolean);
  } else {
    return raw.split(":").map(s => s.trim()).filter(Boolean);
  }
}

function joinPathEntries(entries: string[]) {
  if (isWindows()) {
    return entries.join(";");
  } else {
    return entries.join(":");
  }
}

async function backupFile(path: string) {
  try {
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${path}.bak.${now}`;
    await fs.copyFile(path, bak);
    console.log(`Backup created: ${bak}`);
  } catch (e) {
    // ignore
  }
}

async function persistPosix(name: string, value: string) {
  const home = process.env.HOME || (await $`powershell -NoProfile -Command '$env:USERPROFILE'`.text()).trim();
  const profile = `${home}/.profile`;
  try {
    if (!(await fs.exists(profile))) {
      await fs.writeFile(profile, `# created by bun env.ts\nexport ${name}="${value}"\n`);
      console.log(`Wrote new ${profile}`);
      return;
    }
    const content = await fs.readFile(profile, "utf8");
    const re = new RegExp(`^\\s*export\\s+${name}=.*$`, "m");
    await backupFile(profile);
    let newContent;
    if (re.test(content)) {
      newContent = content.replace(re, `export ${name}="${value}"`);
    } else {
      newContent = content + `\n# added by bun env.ts\nexport ${name}="${value}"\n`;
    }
    await fs.writeFile(profile, newContent);
    console.log(`Updated ${profile}`);
  } catch (e) {
    console.error("Failed to persist to ~/.profile:", e);
    throw e;
  }
}

async function persistPosixEditPath(name: string, entry: string, action: "append" | "remove") {
  const home = process.env.HOME || "";
  const profile = `${home}/.profile`;
  await backupFile(profile);
  let content = "";
  if (await fs.exists(profile)) {
    content = await fs.readFile(profile, "utf8");
  }
  // Naive approach: track an exported variable line
  const re = new RegExp(`^\\s*export\\s+${name}=["']?(.*)["']?$`, "m");
  let current = "";
  const match = content.match(re);
  if (match) current = match[1] || "";
  else current = process.env[name] || "";
  const entries = normalizePathEntries(current || "");
  if (action === "append") {
    if (!entries.includes(entry)) entries.push(entry);
  } else {
    const idx = entries.indexOf(entry);
    if (idx >= 0) entries.splice(idx, 1);
  }
  const newVal = joinPathEntries(entries);
  if (re.test(content)) {
    content = content.replace(re, `export ${name}="${newVal}"`);
  } else {
    content += `\n# added by bun env.ts\nexport ${name}="${newVal}"\n`;
  }
  await fs.writeFile(profile, content);
  console.log(`Persisted ${name} in ${profile}`);
}

async function main() {
  const { cmd, name, value, persist, yes } = parseArgs();

  if (!["list", "get", "set", "append", "remove", "contains"].includes(cmd)) {
    console.error("Unknown command");
    usage();
    process.exit(2);
  }

  if (cmd === "list") {
    if (name) {
      console.log(`${name}=${process.env[name] ?? ""}`);
    } else {
      // print all env
      for (const k of Object.keys(process.env)) {
        console.log(`${k}=${process.env[k]}`);
      }
    }
    return;
  }

  if (!name) {
    console.error("Name is required for this command");
    usage();
    process.exit(2);
  }

  if (cmd === "get") {
    console.log(process.env[name] ?? "");
    return;
  }

  if (cmd === "contains") {
    if (!value) {
      console.error("Value required for contains");
      process.exit(2);
    }
    const cur = process.env[name] ?? "";
    const entries = normalizePathEntries(cur);
    if (entries.includes(value)) process.exit(0);
    else process.exit(1);
  }

  if (cmd === "set") {
    if (value === undefined) {
      console.error("Value required for set");
      process.exit(2);
    }
    // process-level
    process.env[name] = value;
    console.log(`Set ${name} for current process.`);
    if (persist) {
      if (!yes) console.log("Persisting to user environment (will create backup). Use --yes to skip this message.");
      if (isWindows()) {
        // Windows: Set via PowerShell
        try {
          await runPowerShellSetUser(name, value);
          console.log(`Persisted ${name} to User environment (Windows).`);
        } catch (e) {
          console.error("Failed to persist via PowerShell:", e);
        }
      } else {
        try {
          await persistPosix(name, value);
        } catch (e) {
          console.error("Failed to persist on POSIX:", e);
        }
      }
    }
    return;
  }

  // append/remove operate on path-like variables
  if (!value) {
    console.error("Value required for append/remove");
    process.exit(2);
  }

  const cur = process.env[name] ?? "";
  const entries = normalizePathEntries(cur);
  if (cmd === "append") {
    if (entries.includes(value)) {
      console.log("Entry already present — nothing to do.");
    } else {
      entries.push(value);
      const newVal = joinPathEntries(entries);
      process.env[name] = newVal;
      console.log(`Appended to ${name} for current process.`);
      if (persist) {
        if (isWindows()) {
          try {
            const userVal = (await runPowerShellGetUser(name)).trim();
            const userEntries = normalizePathEntries(userVal || "");
            if (!userEntries.includes(value)) {
              userEntries.push(value);
              const joined = joinPathEntries(userEntries);
              await runPowerShellSetUser(name, joined);
              console.log(`Persisted append to User ${name} (Windows).`);
            } else {
              console.log("User-level already contains the entry — no change.");
            }
          } catch (e) {
            console.error("Failed to persist append on Windows:", e);
          }
        } else {
          try {
            await persistPosixEditPath(name, value, "append");
          } catch (e) {
            console.error("Failed to persist append on POSIX:", e);
          }
        }
      }
    }
    return;
  }

  if (cmd === "remove") {
    const idx = entries.indexOf(value);
    if (idx === -1) {
      console.log("Entry not present — nothing to remove.");
    } else {
      entries.splice(idx, 1);
      const newVal = joinPathEntries(entries);
      process.env[name] = newVal;
      console.log(`Removed entry from ${name} for current process.`);
      if (persist) {
        if (isWindows()) {
          try {
            const userVal = (await runPowerShellGetUser(name)).trim();
            const userEntries = normalizePathEntries(userVal || "");
            const i2 = userEntries.indexOf(value);
            if (i2 >= 0) {
              userEntries.splice(i2, 1);
              await runPowerShellSetUser(name, joinPathEntries(userEntries));
              console.log(`Persisted removal to User ${name} (Windows).`);
            } else {
              console.log("User-level did not contain entry — no change.");
            }
          } catch (e) {
            console.error("Failed to persist removal on Windows:", e);
          }
        } else {
          try {
            await persistPosixEditPath(name, value, "remove");
          } catch (e) {
            console.error("Failed to persist removal on POSIX:", e);
          }
        }
      }
    }
    return;
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(3);
});
