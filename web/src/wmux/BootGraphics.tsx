import type { RetroBootProfile } from "./retro-boot-profiles";
const nextLogo = new URL("./assets/retro/logos/next.svg", import.meta.url).href;
const os2Logo = new URL("./assets/retro/logos/os2-warp.png", import.meta.url).href;
const sgiLogo = new URL("./assets/retro/logos/sgi.svg", import.meta.url).href;
const tosStartupFrame = new URL("./assets/retro/tos-1.04-desktop.png", import.meta.url).href;

const shellCopy = {
  "risc-os": { title: "WMUX Logon", user: "User name", password: "Password", action: "Log on" },
  "atari-st": { title: "WMUX REMOTE ACCESS", user: "User name:", password: "Password:", action: "OK" },
  lisa: { title: "LisaTerminal - Remote System", user: "Name", password: "Password", action: "Log On" },
  irix: { title: "Welcome to the WMUX network", user: "Login name:", password: "Password:", action: "Login" },
  nextstep: { title: "WMUX Network Login", user: "Name:", password: "Password:", action: "Log In" },
  os2: { title: "Logon to WMUX", user: "User ID:", password: "Password:", action: "Logon" },
} as const;

export function GraphicalDesktop({ shell, booting }: { shell: NonNullable<RetroBootProfile["graphicalShell"]>; booting: boolean }) {
  if (booting) {
    if (shell === "atari-st") return <img className="retro-graphical-full-frame" src={tosStartupFrame} alt="Atari TOS 1.04 startup" />;
    if (shell === "irix") return <div className="retro-graphical-logo-boot"><img src={sgiLogo} alt="Silicon Graphics" /><span>Starting up the system…</span></div>;
    if (shell === "nextstep") return <div className="retro-graphical-logo-boot retro-next-boot"><img src={nextLogo} alt="NeXT" /><span>Loading from SCSI disk</span></div>;
    if (shell === "os2") return <div className="retro-graphical-logo-boot retro-os2-boot"><img src={os2Logo} alt="IBM OS/2 Warp" /></div>;
    return <div className="retro-graphical-blank" />;
  }

  if (shell === "atari-st") return <div className="retro-atari-desktop"><div className="retro-atari-menu">Desk　 File　 View　 Options</div><span className="retro-atari-disk retro-atari-drive"><i /><small>Floppy A</small></span><span className="retro-atari-disk retro-atari-trash"><i /><small>Trash</small></span></div>;
  if (shell === "risc-os") return <div className="retro-riscos-desktop"><div className="retro-riscos-iconbar"><span className="retro-riscos-apps"><i />Apps</span><span className="retro-riscos-drive"><i />4</span><span className="retro-riscos-acorn" aria-label="Acorn system"><i /></span></div></div>;
  if (shell === "lisa") return <div className="retro-lisa-desktop"><div className="retro-lisa-menu">Desk　File/Print　Edit　Housekeeping</div><div className="retro-lisa-icons"><span className="retro-lisa-icon retro-lisa-clock"><i />Clock</span><span className="retro-lisa-icon retro-lisa-calculator"><i />Calculator</span><span className="retro-lisa-icon retro-lisa-terminal"><i />LisaTerminal</span><span className="retro-lisa-icon retro-lisa-wastebasket"><i />Wastebasket</span></div></div>;
  if (shell === "irix") return <div className="retro-irix-desktop"><div className="retro-irix-toolchest">Toolchest</div></div>;
  if (shell === "nextstep") return (
    <div className="retro-next-desktop">
      <div className="retro-next-menu" aria-hidden="true">
        <strong>Workspace</strong>
        {["Info", "File", "Edit", "Disk", "View"].map((label) => <span key={label}>{label}<i>▸</i></span>)}
      </div>
      <div className="retro-next-dock"><img src={nextLogo} alt="NeXT" /></div>
    </div>
  );
  return <div className="retro-os2-desktop"><div className="retro-os2-icon retro-os2-system"><i />OS/2 System</div><div className="retro-os2-icon retro-os2-connections"><i />Connections</div><div className="retro-os2-launchpad"><img src={os2Logo} alt="IBM OS/2 Warp" /><span className="retro-os2-launch-icons"><i className="retro-os2-window-icon" /><i className="retro-os2-folder-icon" /><i className="retro-os2-help-icon">?</i></span></div></div>;
}

export { shellCopy };
