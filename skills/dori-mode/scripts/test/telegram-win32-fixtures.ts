import { mkdirSync, realpathSync } from "node:fs";
import { fileTgInboundStore, type TgInboundStore } from "../src/messenger/telegram-inbound-state.ts";

export const windowsSecurity = (path: string, script: string): string => {
  const prefix = [
    '$ErrorActionPreference = "Stop"',
    "$p = $env:DORI_CURSOR_TEST_PATH",
    "$sidType = [Security.Principal.SecurityIdentifier]",
    "$u = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$s = $u.Value",
    "$a = Get-Acl -LiteralPath $p",
  ];
  const result = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", [...prefix, script].join(";")],
    { env: { ...process.env, DORI_CURSOR_TEST_PATH: path } },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
export const setFixtureAcl = (path: string, extraAce = "") =>
  windowsSecurity(
    path,
    '$a.SetOwner($u);$a.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;${s})' +
      extraAce +
      '",[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $p -AclObject $a',
  );

/** Real file store for platform-neutral tests. On Windows each use closes its lease before fixture teardown. */
export function telegramTestStore(dir: string, bot: number): TgInboundStore {
  if (process.platform !== "win32") return fileTgInboundStore(dir, bot);
  const prepared = telegramTestDirectory(dir);
  return {
    load() {
      using store = fileTgInboundStore(prepared, bot);
      return store.load();
    },
    save(value) {
      using store = fileTgInboundStore(prepared, bot);
      store.save(value);
    },
  };
}

export function telegramTestDirectory(dir: string): string {
  if (process.platform !== "win32") return dir;
  mkdirSync(dir, { recursive: true });
  // Bun can preserve the runner’s DOS-short TEMP spelling; the store requires the full path.
  const canonical = realpathSync.native(dir);
  setFixtureAcl(canonical);
  return canonical;
}
